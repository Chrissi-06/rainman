import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OFFLINE_THRESHOLD_MS = 90_000;
const KNOWN_DEVICES = ['arduino-a', 'arduino-b', 'arduino-c'];
const devices = {};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS measurements (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    t_ms BIGINT,
    air_temp REAL,
    air_hum REAL,
    sound_v REAL,
    rain_prob REAL,
    raining INTEGER,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/ping', async (req, res) => {
  const { id, status, avg, alert } = req.body;
  if (!KNOWN_DEVICES.includes(id)) {
    return res.status(401).json({ error: 'Unknown device' });
  }

  devices[id] = { status, lastSeen: Date.now() };

  if (avg) {
    await pool.query(
      `INSERT INTO measurements (device_id, air_temp, air_hum, sound_v, rain_prob, raining, alert)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        avg.temp,
        avg.hum,
        avg.sound,
        avg.rainProb,
        status ? 1 : 0,
        alert ? true : false,
      ],
    );
  }

  res.json({ ok: true });
});

app.get('/api/devices', (req, res) => {
  const now = Date.now();
  const result = KNOWN_DEVICES.map((id) => {
    const d = devices[id];
    const isOffline = !d || now - d.lastSeen > OFFLINE_THRESHOLD_MS;
    return { id, status: isOffline ? 'offline' : String(d.status) };
  });
  res.json(result);
});

app.get('/api/data/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const minutes = parseInt(req.query.minutes) || 60;
  const result = await pool.query(
    `SELECT t_ms, air_temp, air_hum, sound_v, rain_prob, raining, recorded_at
     FROM measurements
     WHERE device_id = $1
       AND recorded_at > NOW() - INTERVAL '${minutes} minutes'
     ORDER BY recorded_at ASC`,
    [deviceId],
  );
  res.json(result.rows);
});

app.get('/device/:deviceId', (req, res) => {
  if (!KNOWN_DEVICES.includes(req.params.deviceId)) {
    return res.status(404).send('Device not found');
  }
  res.sendFile(path.join(__dirname, 'public', 'device.html'));
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
