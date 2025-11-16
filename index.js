const { Telegraf } = require("telegraf");
const fs = require("fs");

require("dotenv").config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// JSON file jisme hum movies store karenge
const DB_FILE = "./movies.json";

// agar file nahi hai to bana do
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ movies: [] }, null, 2));
}

// function — database load / save
function loadDB() {
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// -----------------------
//   /start handler
// -----------------------
bot.start(async (ctx) => {
    const payload = ctx.startPayload;

    if (!payload) {
        return ctx.reply("Welcome! Movie link sahi se use karo. Example:\n/start pushpa");
    }

    const slug = payload.trim().toLowerCase();

    const db = loadDB();
    const movie = db.movies.find(m => m.slug === slug);

    if (!movie) {
        return ctx.reply("Movie expired ho chuki hai ya galat link hai.");
    }

    try {
        await ctx.telegram.copyMessage(
            ctx.chat.id,
            movie.channel_id,
            movie.message_id
        );

        ctx.reply(`🎬 Movie: ${movie.slug}\n⏳ Movie 8 hours baad delete ho jayegi.`);
    } catch (err) {
        console.log(err);
        ctx.reply("Movie bhejne me problem aa gayi.");
    }
});

// -----------------------
//  ADMIN COMMAND: /addmovie
// -----------------------
// usage:
// /addmovie pushpa -1003405742119 9
bot.command("addmovie", async (ctx) => {
    const ownerId = process.env.OWNER_ID;

    if (String(ctx.from.id) !== ownerId) {
        return ctx.reply("You are not authorized.");
    }

    const parts = ctx.message.text.split(" ");

    if (parts.length < 4) {
        return ctx.reply("Usage: /addmovie <slug> <channel_id> <message_id>");
    }

    const slug = parts[1].toLowerCase();
    const channel_id = parts[2];
    const message_id = Number(parts[3]);

    const db = loadDB();

    // save movie
    db.movies.push({
        slug,
        channel_id,
        message_id,
        added_at: Date.now()
    });

    saveDB(db);

    ctx.reply(`Movie added: ${slug}`);
});

// -----------------------
// Auto Delete Old Movies (every 10 mins)
// -----------------------
setInterval(() => {
    let db = loadDB();
    const now = Date.now();

    db.movies = db.movies.filter(m => {
        const diff = now - m.added_at;
        return diff < 8 * 60 * 60 * 1000;  // 8 hours
    });

    saveDB(db);
}, 10 * 60 * 1000);

// -----------------------
bot.launch();
console.log("Bot is running...");
