import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OFFLINE_THRESHOLD_MS = 60_000; // 1 minute

// Hardcoded list of known device IDs
const KNOWN_DEVICES = ['arduino-a', 'arduino-b', 'arduino-c'];

// In-memory store: { [id]: { status: bool, lastSeen: Date } }
const devices = {};

app.use(express.json());

// Arduinos call this every 30s
app.post('/ping', (req, res) => {
  const { id, status } = req.body;

  if (!KNOWN_DEVICES.includes(id)) {
    return res.status(401).json({ error: 'Unknown device' });
  }

  devices[id] = { status, lastSeen: Date.now() };
  res.json({ ok: true });
});

// Status page
app.get('/', (req, res) => {
  const now = Date.now();

  const rows = KNOWN_DEVICES.map((id) => {
    const d = devices[id];
    const isOffline = !d || now - d.lastSeen > OFFLINE_THRESHOLD_MS;
    const display = isOffline ? 'offline' : String(d.status);
    return `<tr><td>${id}</td><td>${display}</td></tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="10">
  <title>Device Status</title>
</head>
<body>
  <h1>Device Status</h1>
  <table border="1" cellpadding="8">
    <tr><th>Device</th><th>Status</th></tr>
    ${rows}
  </table>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

import http from 'http';

const HTTP_PORT = process.env.HTTP_PORT || 3001;
http.createServer(app).listen(HTTP_PORT, () => {
  console.log(`Plain HTTP listening on port ${HTTP_PORT}`);
});