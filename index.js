const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
const PORT = process.env.PORT || 10000;

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TOKEN = process.env.TWITCH_USER_TOKEN;
const CHANNEL = process.env.TWITCH_CHANNEL || "enduxfps";

let live = false;
let currentStreamId = null;
let lastUpdate = Date.now();

function formatHours(minutes) {
  return (minutes / 60).toFixed(1).replace(".", ",") + "h";
}

function parseWatchtime(value) {
  const regex = /(\d+(?:\.\d+)?)\s*(years?|months?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/gi;

  let total = 0;
  let found = false;

  for (const match of value.matchAll(regex)) {
    found = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();

    if (unit.startsWith("year")) total += amount * 525600;
    else if (unit.startsWith("month")) total += amount * 43200;
    else if (unit.startsWith("day")) total += amount * 1440;
    else if (unit.startsWith("hour") || unit.startsWith("hr")) total += amount * 60;
    else if (unit.startsWith("min")) total += amount;
    else if (unit.startsWith("sec")) total += amount / 60;
  }

  return found ? total : null;
}

function formatDaysHours(minutes) {
  const totalHours = Math.max(1, Math.ceil(minutes / 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  return `${days} ${days === 1 ? "Tag" : "Tage"} ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
}

async function getChatters() {
  const response = await fetch(
    `https://api.twitch.tv/helix/chat/chatters?broadcaster_id=${process.env.BROADCASTER_ID}&moderator_id=${process.env.MODERATOR_ID}`,
    {
      headers: {
        "Client-ID": CLIENT_ID,
        "Authorization": `Bearer ${TOKEN}`
      }
    }
  );

  if (!response.ok) {
    console.log("Chatters API Fehler:", await response.text());
    return null;
  }

  const data = await response.json();
  return data.data || [];
}

async function checkLive() {
  try {
    const response = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${CHANNEL}`,
      {
        headers: {
          "Client-ID": CLIENT_ID,
          "Authorization": `Bearer ${TOKEN}`
        }
      }
    );

    if (!response.ok) {
      console.log("Live-Check Fehler:", await response.text());
      return;
    }

    const data = await response.json();
    const stream = data.data[0];

    if (stream) {
      const streamId = stream.id;

      if (streamId !== currentStreamId) {
        const saved = await pool.query(
          "SELECT stream_id FROM tracker_state WHERE id = 1"
        );

        const savedStreamId = saved.rows[0]?.stream_id;

        if (savedStreamId !== streamId) {
          await pool.query("DELETE FROM stream_watchtime");

          await pool.query(
            `INSERT INTO tracker_state (id, stream_id)
             VALUES (1, $1)
             ON CONFLICT (id)
             DO UPDATE SET stream_id = $1`,
            [streamId]
          );

          console.log("Neuer Stream – Ranking zurückgesetzt");
        } else {
          console.log("Neustart – bisheriges Ranking bleibt erhalten");
        }

        currentStreamId = streamId;
        lastUpdate = Date.now();
      }

      live = true;
    } else {
      if (live) console.log("Endux offline – Tracking gestoppt");

      live = false;
      currentStreamId = null;
      lastUpdate = Date.now();
    }
  } catch (error) {
    console.log("Live-Check Fehler:", error.message);
  }
}

async function trackChatters() {
  if (!live) return;

  const chatters = await getChatters();
  if (chatters === null) return;

  const now = Date.now();
  const elapsed = (now - lastUpdate) / 60000;
  lastUpdate = now;

  for (const chatter of chatters) {
    await pool.query(
      `INSERT INTO stream_watchtime (user_login, minutes)
       VALUES ($1, $2)
       ON CONFLICT (user_login)
       DO UPDATE SET minutes = stream_watchtime.minutes + $2`,
      [chatter.user_login, elapsed]
    );
  }
}

app.get("/", (req, res) => {
  res.send("Endux Live Tracker läuft");
});

app.get("/top5", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_login, minutes
       FROM stream_watchtime
       ORDER BY minutes DESC
       LIMIT 5`
    );

    res.send(
      result.rows.length
        ? `TOP 5 WATCHTIME » ${result.rows.map((u, i) =>
            `#${i + 1} ${u.user_login} ◆ ${formatHours(Number(u.minutes))}`
          ).join(" | ")}`
        : "TOP 5 WATCHTIME » Wird ermittelt"
    );
  } catch (error) {
    console.log("Top5 Fehler:", error.message);
    res.send("TOP 5 WATCHTIME » Fehler beim Laden");
  }
});

app.get("/test", (req, res) => {
  res.send(
    "TOP 5 WATCHTIME » #1 Timmy ◆ 2,1h | #2 Vex ◆ 1,6h | #3 Luke ◆ 1,3h | #4 Viewer4 ◆ 0,9h | #5 Viewer5 ◆ 0,5h"
  );
});

app.get("/abstand", async (req, res) => {
  try {
    const username = (req.query.user || "").toLowerCase();
    const watchtimeText = req.query.time || "";

    if (!username || !watchtimeText) {
      return res.send("Watchtime konnte nicht übertragen werden.");
    }

    const minutes = parseWatchtime(watchtimeText);

    if (minutes === null) {
      return res.send("Watchtime konnte nicht gelesen werden.");
    }

    await pool.query(
      `INSERT INTO watchtime (user_login, minutes)
       VALUES ($1, $2)
       ON CONFLICT (user_login)
       DO UPDATE SET minutes = $2`,
      [username, minutes]
    );

    const result = await pool.query(
      `SELECT user_login, minutes
       FROM watchtime
       ORDER BY minutes DESC`
    );

    const ranking = result.rows;
    const position = ranking.findIndex(
      u => u.user_login.toLowerCase() === username
    );

    if (position === 0) {
      return res.send("Du bist aktuell auf Platz 1!");
    }

    const missing = Math.max(
      0,
      Number(ranking[position - 1].minutes) -
      Number(ranking[position].minutes)
    );

    if (missing === 0) {
      return res.send(`Du bist gleichauf mit Platz ${position}!`);
    }

    res.send(
      `ABSTAND ZUM NÄCHSTEN PLATZ » Noch ${formatDaysHours(missing)} bis Platz ${position}!`
    );
  } catch (error) {
    console.log("Abstand Fehler:", error.message);
    res.send("ABSTAND » Fehler beim Laden");
  }
});

app.get("/abstandtest", (req, res) => {
  res.send(
    "ABSTAND ZUM NÄCHSTEN PLATZ » Noch 2 Tage 14 Stunden bis Platz 3!"
  );
});

async function startServer() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tracker_state (
        id INTEGER PRIMARY KEY,
        stream_id TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stream_watchtime (
        user_login TEXT PRIMARY KEY,
        minutes DOUBLE PRECISION NOT NULL DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS watchtime (
        user_login TEXT PRIMARY KEY,
        minutes DOUBLE PRECISION NOT NULL DEFAULT 0
      )
    `);

    app.listen(PORT, () => {
      console.log("Server läuft auf Port " + PORT);
      checkLive();
      setInterval(checkLive, 60000);
      setInterval(trackChatters, 30000);
    });
  } catch (error) {
    console.log("Datenbank-Startfehler:", error.message);
    process.exit(1);
  }
}

startServer();


