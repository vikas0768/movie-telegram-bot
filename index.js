


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
const CHANNEL_ID = process.env.CHANNEL_ID; // example: -1001234567890
const PORT = process.env.PORT || 10000;

const RENDER_URL =
  process.env.RENDER_URL ||
  `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error("❌ Missing BOT_TOKEN or CHANNEL_ID");
  process.exit(1);
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);

let db;

/* ---------- DB INIT ---------- */
async function initDb() {
  db = await open({
    filename: "./moviebot.db",
    driver: sqlite3.Database,
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

/* ---------- AUTO DELETE ---------- */
async function scheduleDelete(row) {
  const ms = row.expire_at * 1000 - Date.now();
  if (ms <= 0) return deleteNow(row);

  setTimeout(() => deleteNow(row), ms);
}

async function deleteNow(row) {
  try {
    await bot.telegram.deleteMessage(row.chat_id, row.message_id);
  } catch {}
  await db.run(`DELETE FROM deliveries WHERE id=?`, [row.id]);
}

/* ---------- ADMIN CHECK ---------- */
function isAdmin(ctx) {
  return ctx.from && String(ctx.from.id) === String(ADMIN_ID);
}

/* ---------- SEND MOVIE TO USER ---------- */

bot.start(async (ctx) => {
  const key = ctx.startPayload;
  if (!key) return ctx.reply("Open this movie from your app.");

  const movie = await db.get(`SELECT * FROM movies WHERE key=?`, [key]);
  if (!movie) return ctx.reply("Movie not found.");

  try {
    const sent = await ctx.replyWithVideo(movie.telegram_file_id, {
      caption: `${movie.title}\n(Delivered by MovieBot)`,
      supports_streaming: true,
    });

    const now = Math.floor(Date.now() / 1000);
    const expire_at = now + movie.expire_hours * 3600;

    const r = await db.run(
      `INSERT INTO deliveries (chat_id,message_id,movie_key,expire_at)
       VALUES (?,?,?,?)`,
      [sent.chat.id, sent.message_id, movie.key, expire_at]
    );

    scheduleDelete({
      id: r.lastID,
      chat_id: sent.chat.id,
      message_id: sent.message_id,
      expire_at,
    });
  } catch (e) {
    ctx.reply("Failed to send movie.");
  }
});

/* ---------- BLOCK NORMAL USERS ---------- */
bot.on("message", (ctx, next) => {
  if (isAdmin(ctx)) return next();
  return ctx.reply("Use the app to get movies.");
});

/* ---------- ADMIN: ADD MOVIE ---------- */
/*
Usage:
 /addmovie KEY | Title | ChannelMsgID | hours(optional)
*/

bot.command("addmovie", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const raw = ctx.message.text.replace("/addmovie", "").trim();
  const p = raw.split("|").map((x) => x.trim());

  if (p.length < 3)
    return ctx.reply(
      "Usage:\n/addmovie KEY | Title | ChannelMsgID | hours(optional)"
    );

  const key = p[0];
  const title = p[1];
  const msgId = Number(p[2]);
  const hours = p[3] ? Number(p[3]) : 8;

  try {
    // Get the message from channel
    const message = await bot.telegram.forwardMessage(
      ADMIN_ID,
      CHANNEL_ID,
      msgId
    );

    const video = message.video;
    if (!video)
      return ctx.reply("❌ The ChannelMsgID selected does NOT contain a video.");

    const file_id = video.file_id;

    await db.run(
      `INSERT OR REPLACE INTO movies (key,title,telegram_file_id,expire_hours)
       VALUES (?,?,?,?)`,
      [key, title, file_id, hours]
    );

    const me = await bot.telegram.getMe();
    ctx.reply(
      `✔ Movie Added!\n\n🔗 User Link:\nhttps://t.me/${me.username}?start=${key}`
    );
  } catch (err) {
    console.log(err);
    ctx.reply("❌ Failed! Wrong ChannelMsgID or bot is not admin in channel.");
  }
});

/* ---------- WEBHOOK ---------- */

const path = `/webhook/${BOT_TOKEN}`;
bot.telegram.setWebhook(`${RENDER_URL}${path}`);
app.use(bot.webhookCallback(path));

app.get("/", (req, res) => res.send("MovieBot Online"));

/* ---------- START ---------- */

(async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log("Bot running:", PORT);
  });
})();

