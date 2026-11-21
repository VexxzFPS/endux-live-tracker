
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

const SE_CHANNEL_ID = "62a195a071bbb573d524e640";
const SE_LIMIT = 100;

const EXCLUDED_USERS = [
  "nightbot",
  "streamelements",
  "moobot",
  "fossabot",
  "streamlabs"
];

let live = false;
let currentStreamId = null;
let lastUpdate = Date.now();
let syncRunning = false;

function formatHours(minutes) {
  return (minutes / 60).toFixed(1).replace(".", ",") + "h";
}

function formatDaysHours(minutes) {
  const totalHours = Math.max(1, Math.ceil(minutes / 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  return `${days} ${days === 1 ? "Tag" : "Tage"} ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
}

// StreamElements-Gesamtwatchtime synchronisieren
async function syncStreamElementsWatchtime() {
  if (syncRunning) return;
  syncRunning = true;

  try {
    console.log("StreamElements-Synchronisierung gestartet");

    let offset = 0;
    let total = 0;
    const allUsers = [];

    while (true) {
      const url =
        `https://api.streamelements.com/kappa/v2/points/${SE_CHANNEL_ID}/watchtime?offset=${offset}&limit=${SE_LIMIT}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `StreamElements API Fehler ${response.status}: ${await response.text()}`
        );
      }

      const data = await response.json();

      if (!Array.isArray(data.users)) {
        throw new Error("Ungültige StreamElements-Antwort");
      }

      allUsers.push(...data.users);
      total = Number(data._total || allUsers.length);

      console.log(
        `Watchtime geladen: ${Math.min(offset + data.users.length, total)} / ${total}`
      );

      if (data.users.length === 0 || allUsers.length >= total) {
        break;
      }

      offset += SE_LIMIT;
    }

    if (allUsers.length === 0) {
      throw new Error("Keine Nutzer geladen – Datenbank bleibt unverändert");
    }

    for (let start = 0; start < allUsers.length; start += 500) {
      const batch = allUsers.slice(start, start + 500);
      const values = [];
      const placeholders = [];

      batch.forEach((user) => {
        const username = String(user.username || "").toLowerCase();
        const minutes = Number(user.minutes);

        if (!username || !Number.isFinite(minutes)) return;

        const position = values.length / 2;

        values.push(username, minutes);

        placeholders.push(
          `($${position * 2 + 1}, $${position * 2 + 2})`
        );
      });

      if (placeholders.length === 0) continue;

      await pool.query(
        `INSERT INTO watchtime (user_login, minutes)
         VALUES ${placeholders.join(",")}
         ON CONFLICT (user_login)
         DO UPDATE SET minutes = EXCLUDED.minutes`,
        values
      );
    }

    const usernames = allUsers
      .map(user => String(user.username || "").toLowerCase())
      .filter(Boolean);

    await pool.query(
      `DELETE FROM watchtime
       WHERE NOT (user_login = ANY($1::text[]))`,
      [usernames]
    );

    console.log(
      `StreamElements-Synchronisierung abgeschlossen: ${allUsers.length} Nutzer`
    );
  } catch (error) {
    console.log("StreamElements-Sync Fehler:", error.message);
  } finally {
    syncRunning = false;
  }
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
      if (live) {
        console.log("Endux offline – Tracking gestoppt");
      }

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
    const username = chatter.user_login.toLowerCase();

    if (EXCLUDED_USERS.includes(username)) {
      continue;
    }

    await pool.query(
      `INSERT INTO stream_watchtime (user_login, minutes)
       VALUES ($1, $2)
       ON CONFLICT (user_login)
       DO UPDATE SET minutes = stream_watchtime.minutes + $2`,
      [username, elapsed]
    );
  }
}

app.get("/", (req, res) => {
  res.send("Endux Live Tracker läuft");
});

// TOP 5
app.get("/top5", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_login, minutes
       FROM stream_watchtime
       WHERE NOT (user_login = ANY($1::text[]))
       ORDER BY minutes DESC
       LIMIT 5`,
      [EXCLUDED_USERS]
    );

    res.send(
      result.rows.length
        ? `TOP 5 WATCHTIME OF TODAY »⠀⠀⠀⠀⠀⠀⠀${result.rows
            .map((u, i) => {
              const name = u.user_login.padEnd(16, " ").slice(0, 16);
              const rank = `#${i + 1}`;
              const time = formatHours(Number(u.minutes));

              return `${rank} ${name} · ${time}`;
            })
            .join("⠀")}`
        : "TOP 5 WATCHTIME » Wird ermittelt"
    );
  } catch (error) {
    console.log("Top5 Fehler:", error.message);
    res.send("TOP 5 WATCHTIME » Fehler beim Laden");
  }
});

app.get("/test", (req, res) => {
  res.send(
    "TOP 5 WATCHTIME » #1 Timmy · 2,1h | #2 Vex · 1,6h | #3 Luke · 1,3h | #4 Viewer4 · 0,9h | #5 Viewer5 · 0,5h"
  );
});

// ABSTAND
app.get("/abstand", async (req, res) => {
  try {
    const username = String(req.query.user || "").toLowerCase();

    if (!username) {
      return res.send("ABSTAND » Benutzername fehlt.");
    }

    const result = await pool.query(
      `SELECT user_login, minutes
       FROM watchtime
       ORDER BY minutes DESC, user_login ASC`
    );

    const ranking = result.rows;

    const position = ranking.findIndex(
      user => user.user_login.toLowerCase() === username
    );

    if (position === -1) {
      return res.send("ABSTAND » Keine Watchtime gefunden.");
    }

    if (position === 0) {
      return res.send(
        "ABSTAND ZUM NÄCHSTEN PLATZ » Du bist aktuell auf Platz 1!"
      );
    }

    const missing = Math.max(
      0,
      Number(ranking[position - 1].minutes) -
      Number(ranking[position].minutes)
    );

    if (missing === 0) {
      return res.send(
        `ABSTAND ZUM NÄCHSTEN PLATZ » Du bist gleichauf mit Platz ${position}!`
      );
    }

    res.send(
      `ABSTAND ZUM NÄCHSTEN PLATZ » Noch ${formatDaysHours(
        missing
      )} bis Platz ${position}!`
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

// SERVER START
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
      syncStreamElementsWatchtime();

      setInterval(checkLive, 60000);
      setInterval(trackChatters, 30000);
      setInterval(syncStreamElementsWatchtime, 15 * 60 * 1000);
    });
  } catch (error) {
    console.log("Datenbank-Startfehler:", error.message);
    process.exit(1);
  }
}

startServer();




