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
const RENDER_URL = process.env.RENDER_URL;  

const DEFAULT_EXP_HOURS = 8;

if (!BOT_TOKEN || !RENDER_URL) {
  console.error("Missing BOT_TOKEN or RENDER_URL");
  process.exit(1);
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);

let db;

/* ------ DB SETUP ------ */
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

/* ----- AUTO DELETE SCHEDULER ---- */
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
  } catch (e) {}
  await db.run(`DELETE FROM deliveries WHERE id=?`, [row.id]);
  tasks.delete(row.id);
}

async function loadTasks() {
  const rows = await db.all(`SELECT * FROM deliveries`);
  rows.forEach(scheduleDelete);
}

/* ====== ADMIN CHECK ====== */
function isAdmin(ctx) {
  return ctx.from && String(ctx.from.id) === String(ADMIN_ID);
}

