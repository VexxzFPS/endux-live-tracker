const express = require("express");
const tmi = require("tmi.js");

const app = express();
const PORT = process.env.PORT || 10000;

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TOKEN = process.env.TWITCH_USER_TOKEN;
const CHANNEL = process.env.TWITCH_CHANNEL || "enduxfps";

let live = false;
let scores = new Map();
let lastUpdate = Date.now();

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
    return [];
  }

  const data = await response.json();
  return data.data || [];
}

async function checkLive() {
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
  const isLive = data.data.length > 0;

  if (isLive && !live) {
    scores.clear();
    console.log("Endux ist live – Tracking gestartet");
  }

  if (!isLive && live) {
    console.log("Endux offline – Tracking gestoppt");
  }

  live = isLive;
}

async function trackChatters() {
  if (!live) return;

  const now = Date.now();
  const elapsed = (now - lastUpdate) / 60000;
  lastUpdate = now;

  const chatters = await getChatters();

  for (const chatter of chatters) {
    scores.set(
      chatter.user_login,
      (scores.get(chatter.user_login) || 0) + elapsed
    );
  }
}

app.get("/", (req, res) => res.send("Endux Live Tracker läuft"));

app.get("/top5", (req, res) => {
  const top = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  res.send(
    top.length
      ? `TOP 5 WATCHTIME » ${top.map((u, i) =>
          `${["#1", "#2", "#3", "#4", "#5"][i]} ${u[0]} ◆ ${Math.floor(u[1])}m`
        ).join(" | ")}`
      : "TOP 5 WATCHTIME » Wird ermittelt"
  );
});

app.get("/test", (req, res) => {
  res.send(
    "TOP 5 WATCHTIME » Timmy ◆ 125m | Vex ◆ 98m | Luke ◆ 76m | Viewer4 ◆ 54m | Viewer5 ◆ 32m"
  );
});

app.get("/abstand", (req, res) => {
  const username = (req.query.user || "").toLowerCase();

  const ranking = [...scores.entries()]
    .sort((a, b) => b[1] - a[1]);

  const position = ranking.findIndex(u => u[0].toLowerCase() === username);

  if (position === -1) {
    return res.send("Du bist noch nicht im Watchtime-Ranking.");
  }

  if (position === 0) {
    return res.send("Du bist aktuell auf Platz 1!");
  }

  const missing = Math.max(
    1,
    Math.ceil(ranking[position - 1][1] - ranking[position][1])
  );

  res.send(`ABSTAND ZUM NÄCHSTEN PLATZ » Noch ${missing} Min. bis Platz ${position}!`);
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
  checkLive();
  setInterval(checkLive, 60000);
  setInterval(trackChatters, 30000);
});
