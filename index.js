const express = require("express");
const tmi = require("tmi.js");

const app = express();
app.use(express.json());

const CHANNEL = "enduxfps";
const PORT = process.env.PORT || 10000;

let live = false;
let viewers = {};

const client = new tmi.Client({
  channels: [CHANNEL]
});

client.connect();

client.on("connected", () => {
  console.log("Tracker verbunden");
});

client.on("message", (channel, tags, message, self) => {
  if (!live || self) return;

  const user = tags.username;
  if (!user) return;

  if (!viewers[user]) viewers[user] = 0;
  viewers[user] += 1;
});

app.get("/", (req, res) => {
  res.send("Endux Live Tracker läuft");
});

app.get("/top5", (req, res) => {
  const top = Object.entries(viewers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  res.json(top);
});

app.post("/live", (req, res) => {
  live = true;
  viewers = {};
  res.send("Live-Tracking gestartet");
});

app.post("/offline", (req, res) => {
  live = false;
  res.send("Live-Tracking gestoppt");
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
