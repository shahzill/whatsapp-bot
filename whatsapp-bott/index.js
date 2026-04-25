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

const buildReminderMessage = (games, dateLabel) => {
  let msg = `🏏 *Shaheen Cricket Club*\n📅 *${dateLabel}*\n\n`;
  games.forEach((game) => {
    const offset = getOffset(game.DateAndTime);
    const time = new Date(
      game.DateAndTime.replace(" ", "T") + offset,
    ).toLocaleTimeString("en-CA", {
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

    const message = buildReminderMessage(games, dateLabel);
    console.log(`Sending reminders to ${subscribers.length} subscribers...`);

    for (const sub of subscribers) {
      const cleaned = sub.phone.replace(/\D/g, "");
      const jid = `${cleaned.length === 10 ? `1${cleaned}` : cleaned}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, { text: message });
        console.log(`  ✓ Sent to ${sub.phone}`);
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
      if (code !== DisconnectReason.loggedOut) {
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
      const phone = jid.replace("@s.whatsapp.net", "");
      await axios
        .post(`${API_BASE}/api/whatsapp/unsubscribe`, { phone })
        .catch(() => {});
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
    for (const sub of pending) {
      const cleaned = sub.phone.replace(/\D/g, "");
      const jid = `${cleaned.length === 10 ? `1${cleaned}` : cleaned}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, {
          text: `✅ You're subscribed to Shaheen Cricket Club game reminders! You'll get a message on match days.\n\nReply *STOP* at any time to unsubscribe.`,
        });
        await axios.post(`${API_BASE}/api/whatsapp/mark-welcomed`, {
          phone: sub.phone,
          key: API_KEY,
        });
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

    const playingGames = data.games.filter((g) => !g.IsUmpiring);
    const umpiringGames = data.games.filter((g) => g.IsUmpiring);

    const lines = [];
    if (playingGames.length)
      lines.push(
        `🏏 *${playingGames.length} game${playingGames.length > 1 ? "s" : ""} tomorrow* — be ready!`,
      );
    if (umpiringGames.length)
      lines.push(
        `🟡 *${umpiringGames.length} umpiring${umpiringGames.length > 1 ? "s" : ""} tomorrow* — be ready!`,
      );

    const message = `*Shaheen Cricket Club* 🏏\n\n${lines.join("\n")}`;

    for (const sub of data.subscribers) {
      const cleaned = sub.phone.replace(/\D/g, "");
      const jid = `${cleaned.length === 10 ? `1${cleaned}` : cleaned}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, { text: message });
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

cron.schedule("06 23 * * *", sendTeaserMessage, {
  timezone: "America/Edmonton",
});

setInterval(sendPendingWelcomes, 60_000);

connect();
console.log("WhatsApp bot starting...");
