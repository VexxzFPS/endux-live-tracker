const express = require("express");
const tmi = require("tmi.js");

const app = express();
const PORT = process.env.PORT || 10000;

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const CHANNEL = process.env.TWITCH_CHANNEL || "enduxfps";

let token = "";
let tokenExpiry = 0;
let live = false;
let scores = new Map();
let lastSeen = new Map();

async function getToken() {
  if (token && Date.now() < tokenExpiry) return token;

  const response = await fetch(
    "https://id.twitch.tv/oauth2/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "client_credentials"
      })
    }
  );

  if (!response.ok) throw new Error("Twitch Auth fehlgeschlagen");

  const data = await response.json();
  token = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return token;
}

async function checkLive() {
  try {
    const accessToken = await getToken();

    const response = await fetch(
      "https://api.twitch.tv/helix/streams?user_login=" + CHANNEL,
      {
        headers: {
          "Client-ID": CLIENT_ID,
          "Authorization": "Bearer " + accessToken
        }
      }
    );

    if (!response.ok) throw new Error("Twitch API Fehler");

    const data = await response.json();
    const isLive = data.data.length > 0;

    if (isLive && !live) {
      scores.clear();
      lastSeen.clear();
      console.log("Endux ist live – Tracking gestartet");
    }

    if (!isLive && live) {
      console.log("Endux offline – Tracking gestoppt");
    }

    live = isLive;
  } catch (error) {
    console.error(error.message);
  }
}

const client = new tmi.Client({
  options: { skipMembership: true },
  channels: [CHANNEL]
});

client.connect().catch(console.error);

client.on("message", (channel, tags, message, self) => {
  if (!live || self) return;

  const user = tags.username;
  if (!user) return;

  const minute = Math.floor(Date.now() / 60000);

  if (lastSeen.get(user) === minute) return;

  lastSeen.set(user, minute);
  scores.set(user, (scores.get(user) || 0) + 1);
});

app.get("/", (req, res) => {
  res.send("Endux Live Tracker läuft");
});

app.get("/top5", (req, res) => {
  const top = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const output = top.length
    ? top.map((u, i) =>
        `${i + 1}. ${u[0]} (${u[1]} aktive Chat-Minuten)`
      ).join(" | ")
    : "Noch keine aktiven Chatter";

  res.type("text/plain").send(output);
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
  checkLive();
  setInterval(checkLive, 60000);
});
