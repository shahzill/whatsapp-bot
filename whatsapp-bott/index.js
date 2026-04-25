if (typeof globalThis.crypto === "undefined") {
  const { webcrypto } = require("crypto");
  globalThis.crypto = webcrypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const cron = require("node-cron");
const axios = require("axios");
const express = require("express");

const API_BASE = "https://shaheensapi.shaheenccyyc.com";
const API_KEY = "shaheen_qr_2026";
const WA_PHONE = "14038795634";

let sock;
let isReady = false;
let pairingRequested = false;
let lastPairingCode = null;
// Maps @lid JID -> @s.whatsapp.net JID so STOP from multi-device accounts can be resolved
const lidToPhoneJid = {};

// Railway requires an HTTP server
const app = express();
app.use(express.json());
app.get("/", (_, res) =>
  res.json({ ready: isReady, pairingCode: lastPairingCode }),
);
app.post("/trigger/teaser", async (_, res) => {
  await sendTeaserMessage();
  res.json({ ok: true });
});
app.post("/trigger/reminders", async (_, res) => {
  await sendDailyReminders();
  res.json({ ok: true });
});
app.listen(process.env.PORT || 3001);

const silentLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: function () {
    return this;
  },
};

const getOffset = (dateStr) => {
  const month = parseInt(String(dateStr).split("-")[1], 10);
  return month >= 4 && month <= 10 ? "-06:00" : "-07:00";
};

// Convert phone to WhatsApp JID
const toJid = (phone) => {
  const cleaned = phone.replace(/\D/g, "");
  return `${cleaned.length === 10 ? `1${cleaned}` : cleaned}@s.whatsapp.net`;
};

// Filter games to only those matching the subscriber's chosen team|format combos.
// e.g. teamsStr = "Warriors|T20,Mavericks|35Overs"
// Empty teamsStr = all games (backwards compat for old subscribers).
const filterGamesBySubscriptions = (games, teamsStr) => {
  if (!teamsStr || teamsStr.trim() === "") return games;
  const combos = teamsStr
    .split(",")
    .map((c) => c.split("|").map((s) => s.trim().toLowerCase()))
    .filter(([team, fmt]) => team && fmt);

  return games.filter((g) =>
    combos.some(([team, fmt]) => {
      const teamMatch = g.GameDetails.toLowerCase().includes(team);
      const fmtLower = g.Format.toLowerCase();
      const fmtMatch =
        fmt === "t20"       ? fmtLower.includes("t20") :
        fmt === "35overs"   ? fmtLower.includes("35") :
        /* weeknight */       fmtLower.includes("weeknight");
      return teamMatch && fmtMatch;
    })
  );
};

const buildReminderMessage = (games, dateLabel, sectionLabel) => {
  let msg = `🏏 *${sectionLabel}*\n📅 *${dateLabel}*\n\n`;
  games.forEach((game) => {
    const stripped = game.DateAndTime.replace(" ", "T").replace(
      /Z$|[+-]\d{2}:\d{2}$/,
      "",
    );
    const dateStr = stripped + getOffset(game.DateAndTime);
    const time = new Date(dateStr).toLocaleTimeString("en-CA", {
      timeZone: "America/Edmonton",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    msg += `*Format: ${game.Format}*`;
    if (game.IsUmpiring) msg += " 🟡 Umpiring";
    msg += `\n${game.GameDetails}\n`;
    msg += `📍 ${game.Venue}\n⏰ ${time}\n\n`;
  });
  msg += "_Reply STOP to unsubscribe_";
  return msg;
};

const buildTeaserMessage = (games, label) => {
  const playingGames = games.filter((g) => !g.IsUmpiring);
  const umpiringGames = games.filter((g) => g.IsUmpiring);
  const lines = [];
  if (playingGames.length)
    lines.push(
      `🏏 *${playingGames.length} game${playingGames.length > 1 ? "s" : ""} tomorrow* — be ready!`,
    );
  if (umpiringGames.length)
    lines.push(
      `🟡 *${umpiringGames.length} umpiring${umpiringGames.length > 1 ? "s" : ""} tomorrow* — be ready!`,
    );
  return `*Shaheen Cricket Club* 🏏\n*${label}*\n\n${lines.join("\n")}`;
};

const sendDailyReminders = async () => {
  if (!isReady) {
    console.log("WhatsApp not ready — skipping reminders");
    return;
  }
  try {
    const { data } = await axios.get(
      `${API_BASE}/api/whatsapp/today-data?key=${API_KEY}`,
    );
    const { games, subscribers, dateLabel } = data;

    if (!games.length) {
      console.log("No games today — no reminders sent");
      return;
    }

    console.log(`Sending daily reminders to ${subscribers.length} subscribers...`);

    for (const sub of subscribers) {
      const jid = toJid(sub.phone);
      const myGames = filterGamesBySubscriptions(games, sub.teams);

      try {
        // Daily2: subscriber's teams only
        if (myGames.length > 0) {
          await sock.sendMessage(jid, {
            text: buildReminderMessage(myGames, dateLabel, "Your Teams — Shaheen CC"),
          });
          console.log(`  ✓ Daily (your teams) sent to ${sub.phone}`);
        }

        // Daily1: all games, only if toggle is on
        if (sub.all_games && games.length > 0) {
          await sock.sendMessage(jid, {
            text: buildReminderMessage(games, dateLabel, "All Shaheen Games"),
          });
          console.log(`  ✓ Daily (all games) sent to ${sub.phone}`);
        }
      } catch (e) {
        console.error(`  ✗ Failed to send to ${sub.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Failed to fetch today data:", e.message);
  }
};

const connect = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("./wa_session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: silentLogger,
    browser: Browsers.macOS("Chrome"),
  });

  sock.ev.on("creds.update", saveCreds);

  // Build LID → phone JID map so STOP messages from @lid senders can be resolved
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      if (c.lid && c.id) {
        lidToPhoneJid[c.lid] = c.id;
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && WA_PHONE && !state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(WA_PHONE.replace(/\D/g, ""));
        lastPairingCode = code;
        console.log(`\n📱 Pairing code for ${WA_PHONE}: ${code}\n`);
      } catch (e) {
        console.error("Pairing code failed:", e.message);
        pairingRequested = false;
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected");
      isReady = true;
    }

    if (connection === "close") {
      isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Disconnected (${code})`);
      if (
        code === DisconnectReason.loggedOut ||
        code === DisconnectReason.connectionReplaced
      ) {
        console.log(
          "Session ended permanently — close WhatsApp Web in any browsers and restart the bot.",
        );
      } else {
        setTimeout(connect, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const body =
        msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      if (body.trim().toUpperCase() !== "STOP") continue;

      const jid = msg.key.remoteJid;
      // @lid is a WhatsApp Linked ID, not a phone — resolve to phone JID via contact map
      const resolvedJid = jid.endsWith("@lid")
        ? (lidToPhoneJid[jid] || null)
        : jid;
      if (!resolvedJid || resolvedJid.endsWith("@lid")) {
        console.log("[STOP] Could not resolve LID to phone JID:", jid);
        continue;
      }
      const phone = "+" + resolvedJid.replace("@s.whatsapp.net", "").split(":")[0];
      console.log("[STOP] jid:", jid, "→ resolvedJid:", resolvedJid, "→ phone:", phone);
      const unsubRes = await axios
        .post(`${API_BASE}/api/whatsapp/unsubscribe`, { phone })
        .catch((e) => { console.log("[STOP] unsubscribe error:", e.response?.data || e.message); });
      console.log("[STOP] unsubscribe response:", unsubRes?.data);
      await sock
        .sendMessage(jid, {
          text: "You've been unsubscribed from Shaheen Cricket Club reminders.",
        })
        .catch(() => {});
    }
  });
};

const sendPendingWelcomes = async () => {
  if (!isReady) return;
  try {
    const { data: pending } = await axios.get(
      `${API_BASE}/api/whatsapp/pending-welcome?key=${API_KEY}`,
    );
    if (!pending.length) return;

    const toDateStr = (offset) =>
      new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toLocaleDateString(
        "en-CA",
        { timeZone: "America/Edmonton", year: "numeric", month: "2-digit", day: "2-digit" },
      );

    const [{ data: todayData }, { data: tomorrowData }] = await Promise.all([
      axios.get(`${API_BASE}/api/whatsapp/today-data?key=${API_KEY}&date=${toDateStr(0)}`),
      axios.get(`${API_BASE}/api/whatsapp/today-data?key=${API_KEY}&date=${toDateStr(1)}`),
    ]);

    for (const sub of pending) {
      const jid = toJid(sub.phone);
      try {
        await sock.sendMessage(jid, {
          text: `✅ You're subscribed to Shaheen Cricket Club game reminders! You'll get a message on match days.\n\nReply *STOP* at any time to unsubscribe.`,
        });
        await axios.post(`${API_BASE}/api/whatsapp/mark-welcomed`, {
          phone: sub.phone,
          key: API_KEY,
        });

        // Today's games for this subscriber
        const todayMine = filterGamesBySubscriptions(todayData.games, sub.teams);
        if (todayMine.length > 0) {
          await sock.sendMessage(jid, {
            text: buildReminderMessage(todayMine, todayData.dateLabel, "Your Teams — Shaheen CC"),
          });
        }
        if (sub.all_games && todayData.games.length > 0) {
          await sock.sendMessage(jid, {
            text: buildReminderMessage(todayData.games, todayData.dateLabel, "All Shaheen Games"),
          });
        }

        // Tomorrow's teaser for this subscriber
        const tomorrowMine = filterGamesBySubscriptions(tomorrowData.games, sub.teams);
        if (tomorrowMine.length > 0) {
          await sock.sendMessage(jid, {
            text: buildTeaserMessage(tomorrowMine, "Your Teams"),
          });
        }
        if (sub.all_games && tomorrowData.games.length > 0) {
          await sock.sendMessage(jid, {
            text: buildTeaserMessage(tomorrowData.games, "All Shaheen Games"),
          });
        }

        console.log(`  ✓ Welcomed ${sub.phone}`);
      } catch (e) {
        console.error(`  ✗ Failed to welcome ${sub.phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Failed to fetch pending welcomes:", e.message);
  }
};

const sendTeaserMessage = async () => {
  if (!isReady) return;
  try {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dateStr = tomorrow.toLocaleDateString("en-CA", {
      timeZone: "America/Edmonton",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    console.log(`Teaser checking games for: ${dateStr}`);

    const { data } = await axios.get(
      `${API_BASE}/api/whatsapp/today-data?key=${API_KEY}&date=${dateStr}`,
    );
    if (!data.games.length) return;

    const games = data.games;

    for (const sub of data.subscribers) {
      const jid = toJid(sub.phone);
      const myGames = filterGamesBySubscriptions(games, sub.teams);

      try {
        // Teaser2: subscriber's teams only
        if (myGames.length > 0) {
          await sock.sendMessage(jid, {
            text: buildTeaserMessage(myGames, "Your Teams"),
          });
        }

        // Teaser1: all games, only if toggle is on
        if (sub.all_games && games.length > 0) {
          await sock.sendMessage(jid, {
            text: buildTeaserMessage(games, "All Shaheen Games"),
          });
        }
      } catch (e) {
        console.error(`  ✗ Teaser failed for ${sub.phone}:`, e.message);
      }
    }
    console.log(`Teaser sent to ${data.subscribers.length} subscribers`);
  } catch (e) {
    console.error("Teaser fetch failed:", e.message);
  }
};

cron.schedule("00 07 * * *", sendDailyReminders, {
  timezone: "America/Edmonton",
});

cron.schedule("00 20 * * *", sendTeaserMessage, {
  timezone: "America/Edmonton",
});

setInterval(sendPendingWelcomes, 60_000);

connect();
console.log("WhatsApp bot starting...");
