// index.js — Pro Movie Bot (deep-link + auto-delete + sqlite)
// WARNING: Use only for legal/licensed content.

import express from "express";
import { Telegraf } from "telegraf";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const PORT = process.env.PORT || 10000;

// If RENDER_URL not set, auto-generate it using Render's dynamic hostname
const RENDER_URL = process.env.RENDER_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;

const DEFAULT_EXP_HOURS = 8;

// REQUIRED ENV CHECK
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN in environment.");
  process.exit(1);
}

if (!RENDER_URL) {
  console.error("❌ Missing RENDER_URL or Render external hostname.");
  process.exit(1);
}

console.log("➡ Using webhook URL:", RENDER_URL);

const app = express();
const bot = new Telegraf(BOT_TOKEN);

let db;

/* ---------- DB INIT ---------- */
async function initDb() {
  db = await open({
    filename: "./moviebot.db",
    driver: sqlite3.Database
  });

  await db.exec(`CREATE TABLE IF NOT EXISTS movies (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    telegram_file_id TEXT NOT NULL,
    expire_hours INTEGER DEFAULT 8,
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

/* ---------- AUTO-DELETE SCHEDULER ---------- */
const tasks = new Map();

function scheduleDelete(row) {
  const ms = row.expire_at * 1000 - Date.now();

  if (ms <= 0) return deleteNow(row);

  const t = setTimeout(() => deleteNow(row), ms);
  tasks.set(row.id, t);
}

async function deleteNow(row) {
  try {
    await bot.telegram.deleteMessage(row.chat_id, row.message_id);
  } catch {}
  await db.run(`DELETE FROM deliveries WHERE id=?`, [row.id]);
  tasks.delete(row.id);
}

async function loadTasks() {
  const rows = await db.all(`SELECT * FROM deliveries`);
  rows.forEach(scheduleDelete);
}

/* ---------- ADMIN CHECK ---------- */
function isAdmin(ctx) {
  return ctx.from && String(ctx.from.id) === String(ADMIN_ID);
}

/* ---------- BOT LOGIC ---------- */

bot.start(async (ctx) => {
  const key = ctx.startPayload;

  if (!key) return ctx.reply("Open movie from your app.");

  const movie = await db.get(`SELECT * FROM movies WHERE key=?`, [key]);
  if (!movie) return ctx.reply("Movie not found.");

  try {
    const send = await ctx.replyWithVideo(movie.telegram_file_id, {
      caption: `${movie.title}\n(Delivered by Movie Bot)`,
      supports_streaming: true
    });

    const now = Math.floor(Date.now() / 1000);
    const exp = now + (movie.expire_hours * 3600);

    const res = await db.run(
      `INSERT INTO deliveries (chat_id,message_id,movie_key,delivered_at,expire_at)
       VALUES (?,?,?,?,?)`,
      [send.chat.id, send.message_id, movie.key, now, exp]
    );

    scheduleDelete({
      id: res.lastID,
      chat_id: send.chat.id,
      message_id: send.message_id,
      expire_at: exp
    });

  } catch {
    ctx.reply("Failed to send movie.");
  }
});

/* ---------- BLOCK NORMAL USERS ---------- */
bot.on("message", (ctx, next) => {
  if (isAdmin(ctx)) return next();
  return ctx.reply("Movies only work through the app.");
});

/* ---------- ADMIN COMMANDS ---------- */

bot.command("addmovie", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const r = ctx.message.text.replace("/addmovie", "").trim();
  const p = r.split("|").map(s => s.trim());

  if (p.length < 3)
    return ctx.reply("Usage: /addmovie KEY | Title | file_id | hours");

  const key = p[0];
  const title = p[1];
  const fid = p[2];
  const hrs = p[3] ? Number(p[3]) : DEFAULT_EXP_HOURS;

  await db.run(
    `INSERT OR REPLACE INTO movies (key,title,telegram_file_id,expire_hours)
     VALUES (?,?,?,?)`,
    [key, title, fid, hrs]
  );

  const me = await bot.telegram.getMe();
  ctx.reply(`Movie added!\nLink: https://t.me/${me.username}?start=${key}`);
});

bot.command("delmovie", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const key = ctx.message.text.replace("/delmovie", "").trim();
  await db.run(`DELETE FROM movies WHERE key=?`, [key]);
  ctx.reply("Deleted " + key);
});

bot.command("listmovies", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.all(`SELECT * FROM movies ORDER BY added_at DESC`);
  if (!rows.length) return ctx.reply("No movies.");
  ctx.reply(rows.map(r => `• ${r.key} — ${r.title}`).join("\n"));
});

/* ---------- ADMIN VIDEO UPLOAD (GET FILE ID) ---------- */
bot.on("video", async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply("File ID:\n" + ctx.message.video.file_id);
});

/* ---------- WEBHOOK SETUP ---------- */

const path = `/webhook/${BOT_TOKEN}`;
const fullWebhookURL = `${RENDER_URL}${path}`;

bot.telegram.setWebhook(fullWebhookURL);
app.use(bot.webhookCallback(path));

app.get("/", (req, res) => res.send("MovieBot Online (Webhook Mode)"));


/* ---------- START SERVER ---------- */
(async () => {
  await initDb();
  await loadTasks();

  app.listen(PORT, () => {
    console.log("✅ Webhook server running on:", PORT);
    console.log("🌐 Webhook URL:", fullWebhookURL);
  });
})();

