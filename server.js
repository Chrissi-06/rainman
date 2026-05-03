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
const OFFLINE_THRESHOLD_MS = 30_000; // 30 seconds (3 missed pings)

const KNOWN_DEVICES = ['arduino-a', 'arduino-b', 'arduino-c'];

const devices = {};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Create table if it doesn't exist
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

// Arduino posts here every 10 seconds
app.post('/ping', async (req, res) => {
  const { id, status, csv } = req.body;

  if (!KNOWN_DEVICES.includes(id)) {
    return res.status(401).json({ error: 'Unknown device' });
  }

  devices[id] = { status, lastSeen: Date.now() };

  // Parse and store CSV rows if provided
  if (csv) {
    const lines = csv
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    for (const line of lines) {
      const [t_ms, air_temp, air_hum, sound_v, rain_prob, raining] =
        line.split(',');
      await pool.query(
        `INSERT INTO measurements (device_id, t_ms, air_temp, air_hum, sound_v, rain_prob, raining)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, t_ms, air_temp, air_hum, sound_v, rain_prob, raining],
      );
    }
  }

  res.json({ ok: true });
});

// API: last N minutes of data for a device
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

// Main status page
app.get('/', (req, res) => {
  const now = Date.now();
  const rows = KNOWN_DEVICES.map((id) => {
    const d = devices[id];
    const isOffline = !d || now - d.lastSeen > OFFLINE_THRESHOLD_MS;
    const display = isOffline ? 'offline' : String(d.status);
    const color = isOffline ? '#e74c3c' : d.status ? '#e74c3c' : '#2ecc71';
    return `<tr>
      <td><a href="/device/${id}">${id}</a></td>
      <td style="color:${color};font-weight:bold">${display}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="10">
  <title>Device Status</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 10px; border: 1px solid #ddd; }
    a { text-decoration: none; color: #3498db; }
  </style>
</head>
<body>
  <h1>Device Status</h1>
  <table>
    <tr><th>Device</th><th>Raining</th></tr>
    ${rows}
  </table>
</body>
</html>`);
});

// Per-device graph page
app.get('/device/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  if (!KNOWN_DEVICES.includes(deviceId)) {
    return res.status(404).send('Device not found');
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${deviceId} — Data</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: sans-serif; max-width: 900px; margin: 40px auto; }
    canvas { margin-bottom: 40px; }
    .controls { margin-bottom: 20px; }
    a { color: #3498db; }
  </style>
</head>
<body>
  <p><a href="/">← Back</a></p>
  <h1>${deviceId}</h1>
  <div class="controls">
    Show last:
    <select id="minutes" onchange="loadData()">
      <option value="10">10 minutes</option>
      <option value="60" selected>1 hour</option>
      <option value="360">6 hours</option>
      <option value="1440">24 hours</option>
    </select>
  </div>

  <canvas id="tempHumChart"></canvas>
  <canvas id="soundChart"></canvas>
  <canvas id="rainChart"></canvas>

  <script>
    const SOUND_SCALE = 100 / 3.3;

    let tempHumChart, soundChart, rainChart;

    function initCharts() {
      const commonOptions = {
        animation: false,
        scales: { x: { ticks: { maxTicksLimit: 10 } } }
      };

      tempHumChart = new Chart(document.getElementById('tempHumChart'), {
        type: 'line',
        data: { labels: [], datasets: [
          { label: 'Temperature (°C)', data: [], borderColor: '#e74c3c', tension: 0.2, pointRadius: 0 },
          { label: 'Humidity (%)', data: [], borderColor: '#3498db', tension: 0.2, pointRadius: 0 }
        ]},
        options: { ...commonOptions, plugins: { title: { display: true, text: 'Temperature & Humidity' } } }
      });

      soundChart = new Chart(document.getElementById('soundChart'), {
        type: 'line',
        data: { labels: [], datasets: [
          { label: 'Sound (scaled)', data: [], borderColor: '#9b59b6', tension: 0.2, pointRadius: 0 }
        ]},
        options: { ...commonOptions, plugins: { title: { display: true, text: 'Sound Level (scaled to 0-100)' } } }
      });

      rainChart = new Chart(document.getElementById('rainChart'), {
        type: 'line',
        data: { labels: [], datasets: [
          { label: 'Rain Probability (%)', data: [], borderColor: '#2ecc71', tension: 0.2, pointRadius: 0 }
        ]},
        options: { ...commonOptions, plugins: { title: { display: true, text: 'Rain Probability' } } }
      });
    }

    async function loadData() {
      const minutes = document.getElementById('minutes').value;
      const res = await fetch('/api/data/${deviceId}?minutes=' + minutes);
      const rows = await res.json();

      const labels = rows.map(r => new Date(r.recorded_at).toLocaleTimeString());
      const temps  = rows.map(r => r.air_temp);
      const hums   = rows.map(r => r.air_hum);
      const sounds = rows.map(r => (r.sound_v * SOUND_SCALE).toFixed(1));
      const rain   = rows.map(r => r.rain_prob);

      tempHumChart.data.labels = labels;
      tempHumChart.data.datasets[0].data = temps;
      tempHumChart.data.datasets[1].data = hums;
      tempHumChart.update();

      soundChart.data.labels = labels;
      soundChart.data.datasets[0].data = sounds;
      soundChart.update();

      rainChart.data.labels = labels;
      rainChart.data.datasets[0].data = rain;
      rainChart.update();
    }

    initCharts();
    loadData();
    setInterval(loadData, 10000);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
