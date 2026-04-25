const express = require('express');
const app = express();
app.use(express.json());

let letzterStatus = { regnet: false, zeitstempel: null };

app.post('/api/status', (req, res) => {
  letzterStatus = {
    regnet: req.body.regnet,
    zeitstempel: new Date(),
  };
  console.log('Status empfangen:', letzterStatus);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json(letzterStatus);
});

app.listen(3000, () => console.log('Server läuft'));
