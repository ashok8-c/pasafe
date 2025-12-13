require('dotenv').config();

// 🔹 MQTT: load safely (won’t crash Render if broker not reachable)
try {
  require('./mqtt/client');
} catch (e) {
  console.warn('⚠️ MQTT disabled:', e.message);
}

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const { db, init } = require('./db');
const { signDevice, deviceAuthMiddleware } = require('./auth');
const notifications = require('./services/notifications');
const { publish } = require('./mqtt/client');

init();
const app = express();

/* =====================
   MIDDLEWARE
===================== */
app.use(cors({
  origin: '*',           // allow Vercel frontend
  methods: ['GET','POST'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.use(bodyParser.json());

/* =====================
   ADMIN CONFIG
===================== */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@pasafe.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-admin-secret';

function signAdmin(email) {
  return jwt.sign({ role: 'admin', email }, JWT_SECRET, { expiresIn: '6h' });
}

/* =====================
   UTIL
===================== */
const lastEvent = {};
function debounce(key, windowMs = 5000) {
  const now = Date.now();
  if (lastEvent[key] && now - lastEvent[key] < windowMs) return false;
  lastEvent[key] = now;
  return true;
}

/* =====================
   USERS
===================== */
app.post('/v1/users/register', (req, res) => {
  const { name, phone, emergency_contacts } = req.body;
  if (!name || !phone)
    return res.status(400).json({ error: 'name & phone required' });

  const id = uuidv4();
  db.run(
    `INSERT INTO users(id, name, phone, emergency_contacts, identity_card_id)
     VALUES (?,?,?,?,?)`,
    [id, name, phone, JSON.stringify(emergency_contacts || []), `ID-${id.slice(0, 8)}`],
    err => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true, user_id: id });
    }
  );
});

/* =====================
   DEVICE REGISTER
===================== */
app.post('/v1/devices/register', (req, res) => {
  const { hw_serial, owner_id } = req.body;
  if (!hw_serial)
    return res.status(400).json({ error: 'hw_serial required' });

  const id = uuidv4();
  db.run(
    `INSERT INTO devices(id, owner_id, hw_serial, last_seen, status)
     VALUES (?,?,?,?,?)`,
    [id, owner_id || null, hw_serial, Date.now(), 'active'],
    err => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ device_id: id, token: signDevice(id) });
    }
  );
});

/* =====================
   READINGS (HTTP INGEST)
===================== */
app.post('/v1/readings', deviceAuthMiddleware, (req, res) => {
  const device_id = req.deviceId;
  const { ts, type, value, raw, lat, lon, acc } = req.body;

  const id = uuidv4();
  const timestamp = ts || Date.now();

  db.run(
    `INSERT INTO readings(id, device_id, type, value, raw, lat, lon, acc, ts)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      device_id,
      type,
      value || null,
      JSON.stringify(raw || {}),
      lat || null,
      lon || null,
      acc || null,
      timestamp,
    ],
    err => {
      if (err) return res.status(500).json({ error: 'db error' });

      const threshold = parseFloat(process.env.ALCOHOL_THRESHOLD || 0.2);

      if (type === 'alcohol' && parseFloat(value) >= threshold) {
        if (!debounce(`${device_id}:alcohol`, 8000)) return res.json({ ok: true });

        const alertId = uuidv4();
        db.run(
          `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [alertId, device_id, null, 'alcohol_alert', value, lat, lon, 'pending', Date.now()]
        );

        notifications?.notifyNearbyEmergency?.({
          lat, lon, type: 'alcohol_alert', device_id
        });

        publish?.(`devices/${device_id}/commands`, {
          id: uuidv4(),
          cmd: 'lock_engine',
          reason: 'alcohol_detected'
        });
      }

      res.json({ ok: true, reading_id: id });
    }
  );
});

/* =====================
   BLE TRIGGER
===================== */
app.post('/v1/ble/trigger', (req, res) => {
  const { device_id, type, lat, lon } = req.body;
  if (!device_id || !type)
    return res.status(400).json({ error: 'device_id & type required' });

  const id = uuidv4();
  const ts = Date.now();

  db.run(
    `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, device_id, null, `ble_${type}`, null, lat, lon, 'pending', ts],
    err => {
      if (err) return res.status(500).json({ error: 'db error' });

      publish?.(`devices/${device_id}/commands`, {
        id: uuidv4(),
        cmd: 'siren',
        reason: `ble_${type}`
      });

      res.json({ ok: true, alert_id: id });
    }
  );
});

/* =====================
   FRONTEND APIs
===================== */
app.get('/api/alerts', (req, res) => {
  db.all(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'db error' });
    res.json(rows || []);
  });
});

app.get('/api/readings/latest/:deviceId', (req, res) => {
  db.get(
    `SELECT * FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1`,
    [req.params.deviceId],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'db error' });
      if (!row) return res.json(null);

      res.json({ ...row, raw: row.raw ? JSON.parse(row.raw) : {} });
    }
  );
});

/* =====================
   ADMIN
===================== */
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid credentials' });

  res.json({ token: signAdmin(email) });
});

app.get('/api/admin/me', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    res.json({ ok: true, admin: jwt.verify(token, JWT_SECRET) });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Server running on', PORT);
});
