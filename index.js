// index.js — Pro Movie Bot (deep-link + auto-delete + sqlite)
// WARNING: Use only for legal/licensed content.

import { Telegraf } from "telegraf";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;
const DEFAULT_EXP_HOURS = parseInt(process.env.DEFAULT_EXP_HOURS || "8", 10);

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in environment");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let db;

/* ---------- DB init ---------- */
async function initDb() {
  db = await open({
    filename: "./moviebot.db",
    driver: sqlite3.Database
  });

  await db.exec(`CREATE TABLE IF NOT EXISTS movies (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    telegram_file_id TEXT NOT NULL,
    expire_hours INTEGER DEFAULT ${DEFAULT_EXP_HOURS},
    added_by TEXT,
    added_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    movie_key TEXT NOT NULL,
    delivered_at INTEGER DEFAULT (strftime('%s','now')),
    expire_at INTEGER NOT NULL
  )`);
}

/* ---------- Scheduling ---------- */
const scheduled = new Map(); // deliveryId => timeout

function scheduleDeletionRow(row) {
  const ms = row.expire_at * 1000 - Date.now();
  if (ms <= 0) {
    // immediate attempt
    attemptDelete(row.id, row.chat_id, row.message_id);
    return;
  }
  const t = setTimeout(() => {
    attemptDelete(row.id, row.chat_id, row.message_id);
    scheduled.delete(row.id);
  }, ms);
  scheduled.set(row.id, t);
}

async function rescheduleAll() {
  const rows = await db.all(`SELECT id, chat_id, message_id, movie_key, expire_at FROM deliveries`);
  for (const r of rows) scheduleDeletionRow(r);
}

async function attemptDelete(deliveryId, chatId, messageId) {
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch (err) {
    // ignore; message may already be deleted or permission issue
    console.warn("deleteMessage err:", err?.response?.description || err.message || err);
  }
  try {
    await db.run(`DELETE FROM deliveries WHERE id = ?`, [deliveryId]);
  } catch (e) {
    console.error("Failed to remove delivery row:", e);
  }
}

/* ---------- Helpers ---------- */
function isAdmin(ctx) {
  if (!ADMIN_ID) return false;
  return String(ctx.from && ctx.from.id) === String(ADMIN_ID);
}

/* ---------- Bot behavior ---------- */

// Disable regular interaction; only accept /start payloads for non-admins
bot.start(async (ctx) => {
  const payload = (ctx.startPayload || "").trim();
  if (!payload) {
    return ctx.reply("Direct use of this bot is disabled. Open movie links from the app.");
  }
  // lookup movie
  const movie = await db.get(`SELECT key,title,telegram_file_id,expire_hours FROM movies WHERE key = ?`, [payload]);
  if (!movie) {
    return ctx.reply("Requested movie not available.");
  }

  // send video (by telegram_file_id)
  try {
    const send = await ctx.replyWithVideo(movie.telegram_file_id, {
      caption: `${movie.title}\n\n(Delivered by MovieBot)`,
      supports_streaming: true
    });

    const deliveredAt = Math.floor(Date.now() / 1000);
    const expireAt = deliveredAt + (movie.expire_hours || DEFAULT_EXP_HOURS) * 3600;
    const chatId = send.chat.id;
    const messageId = send.message_id;

    const result = await db.run(
      `INSERT INTO deliveries (chat_id,message_id,movie_key,delivered_at,expire_at) VALUES (?,?,?,?,?)`,
      [chatId, messageId, movie.key, deliveredAt, expireAt]
    );
    const deliveryId = result.lastID;
    scheduleDeletionRow({ id: deliveryId, chat_id: chatId, message_id: messageId, expire_at: expireAt });
  } catch (err) {
    console.error("Error sending video:", err);
    return ctx.reply("Failed to deliver movie. Try later.");
  }
});

// Block other messages for non-admins
bot.on("message", (ctx, next) => {
  const text = ctx.message && ctx.message.text;
  // allow admin commands normally
  if (text && text.startsWith("/")) {
    if (isAdmin(ctx)) return next();
    return ctx.reply("This bot only responds to app links. Direct commands are disabled.");
  } else {
    if (isAdmin(ctx)) return next();
    return ctx.reply("Use the app to open a movie link. Direct messages are disabled.");
  }
});

/* ---------- Admin commands ---------- */

// /addmovie KEY | Title | telegram_file_id | HOURS(optional)
bot.command("addmovie", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Only admin allowed.");
  const raw = ctx.message.text.replace("/addmovie", "").trim();
  const parts = raw.split("|").map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length < 3) {
    return ctx.reply("Usage: /addmovie KEY | Title | telegram_file_id | HOURS(optional)\nExample:\n/addmovie GIRLFRIEND | Girlfriend (2023) | <file_id> | 8");
  }
  const [key, title, telegram_file_id] = parts;
  const hours = parts[3] ? parseInt(parts[3]) : DEFAULT_EXP_HOURS;
  try {
    await db.run(
      `INSERT OR REPLACE INTO movies (key,title,telegram_file_id,expire_hours,added_by) VALUES (?,?,?,?,?)`,
      [key, title, telegram_file_id, hours, `${ctx.from.id}`]
    );
    const botUsername = (bot.options && bot.options.username) ? bot.options.username : (await bot.telegram.getMe()).username;
    return ctx.reply(`✅ Movie added.\nDeep link: https://t.me/${botUsername}?start=${encodeURIComponent(key)}`);
  } catch (err) {
    console.error("addmovie error:", err);
    return ctx.reply("Failed to add movie.");
  }
});

// /delmovie KEY
bot.command("delmovie", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Only admin.");
  const key = ctx.message.text.replace("/delmovie", "").trim();
  if (!key) return ctx.reply("Usage: /delmovie KEY");
  try {
    await db.run(`DELETE FROM movies WHERE key = ?`, [key]);
    return ctx.reply("Deleted: " + key);
  } catch (err) {
    console.error("delmovie err:", err);
    return ctx.reply("Failed to delete.");
  }
});

// /listmovies
bot.command("listmovies", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Only admin.");
  const rows = await db.all(`SELECT key,title,expire_hours,added_at FROM movies ORDER BY added_at DESC LIMIT 200`);
  if (!rows || rows.length === 0) return ctx.reply("No movies.");
  const lines = rows.map(r => `• ${r.key} — ${r.title} (expire ${r.expire_hours}h)`).join("\n");
  ctx.reply(lines);
});

// Temporary helper: reply with file_id when admin forwards video to bot
// This is safe to keep — it only responds in admin chats.
bot.on("message", async (ctx) => {
  if (!isAdmin(ctx)) return; // only admin
  if (ctx.message && ctx.message.video) {
    const fileId = ctx.message.video.file_id;
    const size = ctx.message.video.file_size || "unknown";
    ctx.reply(`Received video file_id:\n${fileId}\nsize: ${size}`);
    console.log("Admin uploaded file_id:", fileId, "size:", size);
  }
});

/* ---------- Startup ---------- */
(async () => {
  await initDb();
  bot.launch().then(async () => {
    // store username for deeplink generation
    const me = await bot.telegram.getMe();
    bot.options.username = me.username;
    console.log("Bot launched:", me.username);
    await rescheduleAll();
  }).catch(err => {
    console.error("Failed to launch bot:", err);
    process.exit(1);
  });

  // graceful shutdown
  process.once("SIGINT", () => {
    console.log("SIGINT — graceful shutdown");
    bot.stop();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    console.log("SIGTERM — graceful shutdown");
    bot.stop();
    process.exit(0);
  });
})();
