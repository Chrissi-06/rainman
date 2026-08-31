import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';

const OFFLINE_THRESHOLD_MS = 90_000;
const MAX_HISTORY_MINUTES = 1440;
const MAX_BODY_SIZE = '16kb';

const KNOWN_DEVICES = ['arduino-a', 'arduino-b', 'arduino-c'];
const devices = {};

const UPDATE_SECRET = process.env.UPDATE_SECRET;

if (!UPDATE_SECRET) {
  throw new Error('UPDATE_SECRET is not configured');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
    recorded_at TIMESTAMPTZ DEFAULT NOW(),
    alert BOOLEAN DEFAULT FALSE
  )
`);

await pool.query(`
  ALTER TABLE measurements
  ADD COLUMN IF NOT EXISTS alert BOOLEAN DEFAULT FALSE
`);

await pool.query(`
  CREATE INDEX IF NOT EXISTS measurements_device_recorded_at_idx
  ON measurements (device_id, recorded_at)
`);

app.set('trust proxy', 'loopback');

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(express.static(path.join(__dirname, 'public')));

function isValidSecret(receivedSecret) {
  if (typeof receivedSecret !== 'string') {
    return false;
  }

  const expected = Buffer.from(UPDATE_SECRET, 'utf8');
  const received = Buffer.from(receivedSecret, 'utf8');

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

function authenticateUpdate(req, res, next) {
  const authorization = req.get('authorization');

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authorization.slice('Bearer '.length).trim();

  if (!isValidSecret(token)) {
    return res.status(401).json({ error: 'Invalid authentication' });
  }

  req.deviceId = req.body?.id;
  next();
}

const pingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.deviceId || req.ip,
  message: { error: 'Too many update requests' },
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function validatePingPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be an object';
  }

  const { id, status, avg, alert } = body;

  if (!KNOWN_DEVICES.includes(id)) {
    return 'Unknown device';
  }

  if (!isBoolean(status)) {
    return 'status must be a boolean';
  }

  if (!isBoolean(alert)) {
    return 'alert must be a boolean';
  }

  if (avg === undefined || avg === null) {
    return null;
  }

  if (typeof avg !== 'object' || Array.isArray(avg)) {
    return 'avg must be an object';
  }

  for (const field of ['temp', 'hum', 'sound', 'rainProb']) {
    if (!isFiniteNumber(avg[field])) {
      return `avg.${field} must be a finite number`;
    }
  }

  if (avg.hum < 0 || avg.hum > 100) {
    return 'avg.hum must be between 0 and 100';
  }

  if (avg.rainProb < 0 || avg.rainProb > 100) {
    return 'avg.rainProb must be between 0 and 100';
  }

  return null;
}

app.post('/ping', authenticateUpdate, pingLimiter, async (req, res) => {
  const validationError = validatePingPayload(req.body);

  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { id, status, avg, alert } = req.body;

  devices[id] = {
    status,
    lastSeen: Date.now(),
  };

  if (avg) {
    await pool.query(
      `INSERT INTO measurements (
        device_id,
        air_temp,
        air_hum,
        sound_v,
        rain_prob,
        raining,
        alert
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, avg.temp, avg.hum, avg.sound, avg.rainProb, status ? 1 : 0, alert],
    );
  }

  res.json({ ok: true });
});

app.get('/api/devices', (req, res) => {
  const now = Date.now();

  const result = KNOWN_DEVICES.map((id) => {
    const device = devices[id];

    const isOffline = !device || now - device.lastSeen > OFFLINE_THRESHOLD_MS;

    return {
      id,
      status: isOffline ? 'offline' : String(device.status),
    };
  });

  res.json(result);
});

app.get('/api/data/:deviceId', async (req, res) => {
  const { deviceId } = req.params;

  if (!KNOWN_DEVICES.includes(deviceId)) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const minutes = Number.parseInt(req.query.minutes ?? '60', 10);

  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_HISTORY_MINUTES
  ) {
    return res.status(400).json({
      error: `minutes must be between 1 and ${MAX_HISTORY_MINUTES}`,
    });
  }

  const result = await pool.query(
    `SELECT
      t_ms,
      air_temp,
      air_hum,
      sound_v,
      rain_prob,
      raining,
      recorded_at
    FROM measurements
    WHERE device_id = $1
      AND recorded_at > NOW() - ($2 * INTERVAL '1 minute')
    ORDER BY recorded_at ASC`,
    [deviceId, minutes],
  );

  res.json(result.rows);
});

app.get('/device/:deviceId', (req, res) => {
  if (!KNOWN_DEVICES.includes(req.params.deviceId)) {
    return res.status(404).send('Device not found');
  }

  res.sendFile(path.join(__dirname, 'public', 'device.html'));
});

app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}`);
});
