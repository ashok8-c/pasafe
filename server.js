require('dotenv').config();

/* =====================
   SAFE MQTT LOAD
===================== */
let publish = null;
try {
  ({ publish } = require('./mqtt/client'));
} catch (e) {
  console.warn('⚠️ MQTT disabled:', e.message);
}

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const { init, getDb } = require('./db');
const { signDevice, deviceAuthMiddleware } = require('./auth');
const notifications = require('./services/notifications');

const app = express();

/* =====================
   INIT DATABASE
===================== */
init()
  .then(() => console.log('✅ MongoDB initialized successfully'))
  .catch(err => {
    console.error('❌ MongoDB init failed', err);
    process.exit(1);
  });

/* =====================
   MIDDLEWARE
===================== */
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());

/* =====================
   ADMIN CONFIG
===================== */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@pasafe.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function signAdmin(email) {
  return jwt.sign({ role: 'admin', email }, JWT_SECRET, { expiresIn: '6h' });
}

/* =====================
   USERS
===================== */
app.post('/v1/users/register', async (req, res) => {
  try {
    const { name, phone, emergency_contacts } = req.body;
    if (!name || !phone)
      return res.status(400).json({ error: 'name & phone required' });

    const db = getDb();
    const user = {
      id: uuidv4(),
      name,
      phone,
      emergency_contacts: emergency_contacts || [],
      identity_card_id: `ID-${Date.now()}`
    };

    await db.collection('users').insertOne(user);
    res.json({ ok: true, user_id: user.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

/* =====================
   DEVICE REGISTER
===================== */
app.post('/v1/devices/register', async (req, res) => {
  try {
    const { hw_serial, owner_id } = req.body;
    if (!hw_serial)
      return res.status(400).json({ error: 'hw_serial required' });

    const db = getDb();
    const device = {
      id: uuidv4(),
      owner_id: owner_id || null,
      hw_serial,
      last_seen: Date.now(),
      status: 'active'
    };

    await db.collection('devices').insertOne(device);
    res.json({ device_id: device.id, token: signDevice(device.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

/* =====================
   READINGS (DEVICE DATA)
===================== */
app.post('/v1/readings', deviceAuthMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const device_id = req.deviceId;
    const { ts, type, value, raw, lat, lon, acc } = req.body;

    const reading = {
      id: uuidv4(),
      device_id,
      type,
      value: value ?? null,
      raw: raw || {},
      lat: lat ?? null,
      lon: lon ?? null,
      acc: acc ?? null,
      ts: ts || Date.now()
    };

    await db.collection('readings').insertOne(reading);

    /* ---- Alcohol Detection ---- */
    const threshold = parseFloat(process.env.ALCOHOL_THRESHOLD || 0.2);
    if (type === 'alcohol' && parseFloat(value) >= threshold) {
      const alert = {
        id: uuidv4(),
        device_id,
        user_id: null,
        type: 'alcohol_alert',
        value,
        lat,
        lon,
        status: 'pending',
        created_at: Date.now()
      };

      await db.collection('alerts').insertOne(alert);

      notifications?.notifyNearbyEmergency?.({
        lat, lon, type: 'alcohol_alert', device_id
      });

      publish?.(`devices/${device_id}/commands`, {
        id: uuidv4(),
        cmd: 'lock_engine',
        reason: 'alcohol_detected'
      });
    }

    res.json({ ok: true, reading_id: reading.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

/* =====================
   BLE EMERGENCY TRIGGER
===================== */
app.post('/v1/ble/trigger', async (req, res) => {
  try {
    const { device_id, type, lat, lon } = req.body;
    if (!device_id || !type)
      return res.status(400).json({ error: 'device_id & type required' });

    const db = getDb();
    const alert = {
      id: uuidv4(),
      device_id,
      user_id: null,
      type: `ble_${type}`,
      value: null,
      lat,
      lon,
      status: 'pending',
      created_at: Date.now()
    };

    await db.collection('alerts').insertOne(alert);

    publish?.(`devices/${device_id}/commands`, {
      id: uuidv4(),
      cmd: 'siren',
      reason: `ble_${type}`
    });

    res.json({ ok: true, alert_id: alert.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

/* =====================
   FRONTEND APIs
===================== */
app.get('/api/alerts', async (req, res) => {
  try {
    const db = getDb();
    const alerts = await db
      .collection('alerts')
      .find({})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    res.json(alerts);
  } catch {
    res.status(500).json({ error: 'db error' });
  }
});

app.get('/api/readings/latest/:deviceId', async (req, res) => {
  try {
    const db = getDb();
    const row = await db
      .collection('readings')
      .find({ device_id: req.params.deviceId })
      .sort({ ts: -1 })
      .limit(1)
      .next();

    res.json(row || null);
  } catch {
    res.status(500).json({ error: 'db error' });
  }
});

/* =====================
   🚨 MANUAL NOTIFY API (DEMO CORE)
===================== */
app.post('/api/notify', async (req, res) => {
  try {
    const { alert_id, authority } = req.body;

    if (!alert_id || !authority)
      return res.status(400).json({
        error: 'alert_id and authority required'
      });

    const db = getDb();
    await db.collection('notifications').insertOne({
      id: uuidv4(),
      alert_id,
      authority,
      notified_at: new Date(),
      mode: 'manual-demo'
    });

    console.log(`📢 ${authority.toUpperCase()} notified for alert ${alert_id}`);

    res.json({
      ok: true,
      message: `${authority.toUpperCase()} notified successfully`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'notification failed' });
  }
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

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 PASAFE server running on', PORT);
});
