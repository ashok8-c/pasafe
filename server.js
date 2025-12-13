require('dotenv').config();
require('./mqtt/client');
const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db, init } = require('./db');
const { signDevice, deviceAuthMiddleware } = require('./auth');
const notifications = require('./services/notifications');
// const { validateHeaderName } = require('http'); // unused, safe to remove

init();
const app = express();
app.use(bodyParser.json());

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// 🔐 Simple admin credentials & JWT setup
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@pasafe.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-admin-secret';

// helper to create admin token
function signAdmin(email) {
  return jwt.sign(
    { role: 'admin', email },
    JWT_SECRET,
    { expiresIn: '6h' }
  );
}

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
  console.log('MQTT connected to', MQTT_BROKER);
  mqttClient.subscribe('devices/+/telemetry');
});

const lastEvent = {};
function debounce(key, windowMs = 5000) {
  const now = Date.now();
  if (lastEvent[key] && now - lastEvent[key] < windowMs) return false;
  lastEvent[key] = now;
  return true;
}

mqttClient.on('message', (topic, msg) => {
  try {
    const parts = topic.split('/');
    if (parts[0] === 'devices' && parts[2] === 'telemetry') {
      const deviceId = parts[1];
      const payload = JSON.parse(msg.toString());

      const id = uuidv4();
      const ts = Date.now();
      db.run(
        `INSERT INTO readings(id, device_id, type, value, raw, lat, lon, acc, ts)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          id,
          deviceId,
          payload.type,
          payload.value,
          JSON.stringify(payload.raw || {}),
          payload.lat || null,
          payload.lon || null,
          payload.acc || null,
          ts,
        ]
      );

      const threshold = parseFloat(process.env.ALCOHOL_THRESHOLD || 0.2);

      // 🔔 HIGH ALCOHOL via MQTT
      if (payload.type === 'alcohol' && parseFloat(payload.value) >= threshold) {
        if (!debounce(`${deviceId}:alcohol`, 8000)) return;

        const alertId = uuidv4();
        db.run(
          `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            alertId,
            deviceId,
            null,
            'alcohol_alert',
            payload.value,
            payload.lat || null,
            payload.lon || null,
            'pending',
            ts,
          ]
        );

        // 👉 notify nearby emergency contacts (police/hospital/authority)
        if (notifications && typeof notifications.notifyNearbyEmergency === 'function') {
          notifications.notifyNearbyEmergency({
            lat: payload.lat || null,
            lon: payload.lon || null,
            type: 'alcohol_alert',
            device_id: deviceId,
          }).catch(err => {
            console.error('notifyNearbyEmergency (alcohol) error:', err.message);
          });
        }

        const cmdId = uuidv4();
        const cmdPayload = {
          cmd: 'lock_engine',
          reason: 'alcohol_detected',
        };

        db.run(
          `INSERT INTO commands(id, device_id, command, payload, status, created_at)
           VALUES (?,?,?,?,?,?)`,
          [
            cmdId,
            deviceId,
            'lock_engine',
            JSON.stringify(cmdPayload),
            'pending',
            ts,
          ],
          () => {
            mqttClient.publish(
              `devices/${deviceId}/commands`,
              JSON.stringify({ id: cmdId, ...cmdPayload })
            );
          }
        );
      }

      // 🔔 FALL (ACCIDENT) via MQTT
      if (payload.type === 'fall' && payload.value === 1) {
        if (!debounce(`${deviceId}:fall`, 5000)) return;

        const alertId = uuidv4();
        db.run(
          `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            alertId,
            deviceId,
            null,
            'fall_detected',
            payload.value,
            payload.lat || null,
            payload.lon || null,
            'pending',
            ts,
          ]
        );

        // 👉 notify nearby emergency contacts
        if (notifications && typeof notifications.notifyNearbyEmergency === 'function') {
          notifications.notifyNearbyEmergency({
            lat: payload.lat || null,
            lon: payload.lon || null,
            type: 'fall_detected',
            device_id: deviceId,
          }).catch(err => {
            console.error('notifyNearbyEmergency (fall) error:', err.message);
          });
        }
      }

      // 🔔 SOS via MQTT
      if (payload.type === 'sos' && payload.value === 1) {
        if (!debounce(`${deviceId}:sos`, 3000)) return;

        const alertId = uuidv4();
        db.run(
          `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            alertId,
            deviceId,
            null,
            'sos_pressed',
            payload.value,
            payload.lat || null,
            payload.lon || null,
            'pending',
            ts,
          ]
        );

        // 👉 notify nearby emergency contacts
        if (notifications && typeof notifications.notifyNearbyEmergency === 'function') {
          notifications.notifyNearbyEmergency({
            lat: payload.lat || null,
            lon: payload.lon || null,
            type: 'sos_pressed',
            device_id: deviceId,
          }).catch(err => {
            console.error('notifyNearbyEmergency (sos) error:', err.message);
          });
        }
      }
    }
  } catch (e) {
    console.error('Error handling MQTT message', e);
  }
});

// USERS
app.post('/v1/users/register', (req, res) => {
  const { name, phone, emergency_contacts } = req.body;
  if (!name || !phone)
    return res.status(400).json({ error: 'name & phone required' });

  const id = uuidv4();
  db.run(
    `INSERT INTO users(id, name, phone, emergency_contacts, identity_card_id)
     VALUES (?,?,?,?,?)`,
    [
      id,
      name,
      phone,
      JSON.stringify(emergency_contacts || []),
      `ID-${id.slice(0, 8)}`,
    ],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true, user_id: id });
    }
  );
});

// DEVICE REGISTER
app.post('/v1/devices/register', (req, res) => {
  const { hw_serial, owner_id } = req.body;
  if (!hw_serial)
    return res.status(400).json({ error: 'hw_serial required' });

  const id = uuidv4();
  db.run(
    `INSERT INTO devices(id, owner_id, hw_serial, last_seen, status)
     VALUES (?,?,?,?,?)`,
    [id, owner_id || null, hw_serial, Date.now(), 'active'],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });
      const token = signDevice(id);
      res.json({ device_id: id, token });
    }
  );
});

// READINGS (HTTP INGEST)
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
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });

      const threshold = parseFloat(process.env.ALCOHOL_THRESHOLD || 0.2);

      // 🔔 HIGH ALCOHOL via HTTP ingest
      if (type === 'alcohol' && parseFloat(value) >= threshold) {
        const alertId = uuidv4();
        db.run(
          `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            alertId,
            device_id,
            null,
            'alcohol_alert',
            value,
            lat || null,
            lon || null,
            'pending',
            Date.now(),
          ]
        );

        // 👉 notify nearby emergency contacts
        if (notifications && typeof notifications.notifyNearbyEmergency === 'function') {
          notifications.notifyNearbyEmergency({
            lat: lat || null,
            lon: lon || null,
            type: 'alcohol_alert',
            device_id,
          }).catch(err => {
            console.error('notifyNearbyEmergency (alcohol HTTP) error:', err.message);
          });
        }

        const cmdId = uuidv4();
        const cmdPayload = {
          cmd: 'lock_engine',
          reason: 'alcohol_detected',
        };

        db.run(
          `INSERT INTO commands(id, device_id, command, payload, status, created_at)
           VALUES (?,?,?,?,?,?)`,
          [
            cmdId,
            device_id,
            'lock_engine',
            JSON.stringify(cmdPayload),
            'pending',
            Date.now(),
          ],
          () => {
            mqttClient.publish(
              `devices/${device_id}/commands`,
              JSON.stringify({ id: cmdId, ...cmdPayload })
            );
          }
        );
      }

      res.json({ ok: true, reading_id: id });
    }
  );
});

// BLE TRIGGER
app.post('/v1/ble/trigger', (req, res) => {
  const { device_id, type, lat, lon } = req.body;
  if (!device_id || !type)
    return res.status(400).json({ error: 'device_id & type required' });

  const id = uuidv4();
  const ts = Date.now();

  db.run(
    `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      device_id,
      null,
      `ble_${type}`,
      null,
      lat || null,
      lon || null,
      'pending',
      ts,
    ],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });

      const cmdId = uuidv4();
      const cmdPayload = { cmd: 'siren', reason: `ble_${type}` };

      db.run(
        `INSERT INTO commands(id, device_id, command, payload, status, created_at)
         VALUES (?,?,?,?,?,?)`,
        [
          cmdId,
          device_id,
          'siren',
          JSON.stringify(cmdPayload),
          'pending',
          ts,
        ],
        () => {
          mqttClient.publish(
            `devices/${device_id}/commands`,
            JSON.stringify({ id: cmdId, ...cmdPayload })
          );
        }
      );

      res.json({ ok: true, alert_id: id });
    }
  );
});

// POLL COMMANDS
app.get('/v1/devices/:id/commands', (req, res) => {
  const deviceId = req.params.id;
  db.all(
    `SELECT * FROM commands WHERE device_id = ? AND status = 'pending'`,
    [deviceId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ commands: rows || [] });
    }
  );
});

// ACK COMMAND
app.post('/v1/devices/:id/ack', (req, res) => {
  const deviceId = req.params.id;
  const { command_id, status } = req.body;

  db.run(
    `UPDATE commands SET status = ? WHERE id = ? AND device_id = ?`,
    [status || 'done', command_id, deviceId],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true });
    }
  );
});

// GET ALL ALERTS (original v1 endpoint)
app.get('/v1/alerts', (req, res) => {
  db.all(
    `SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json(rows);
    }
  );
});

/* =======================
   FRONTEND-FRIENDLY APIs
   ======================= */

// GET /api/alerts?type=accident|alcohol (optional type)
app.get('/api/alerts', (req, res) => {
  const typeFilter = req.query.type;

  let sql = `SELECT * FROM alerts`;
  const params = [];

  if (typeFilter === 'alcohol') {
    sql += ` WHERE type = 'alcohol_alert'`;
  } else if (typeFilter === 'accident') {
    // treat everything except alcohol as "accident/emergency"
    sql += ` WHERE type != 'alcohol_alert'`;
  }

  sql += ` ORDER BY created_at DESC LIMIT 100`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'db error' });
    res.json(rows || []);
  });
});

// GET latest reading for a device
app.get('/api/readings/latest/:deviceId', (req, res) => {
  const deviceId = req.params.deviceId;

  db.get(
    `SELECT * FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1`,
    [deviceId],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'db error' });
      if (!row) return res.json(null);

      let raw = {};
      try {
        raw = row.raw ? JSON.parse(row.raw) : {};
      } catch {
        raw = {};
      }

      const response = {
        id: row.id,
        device_id: row.device_id,
        type: row.type,
        value: row.value,
        lat: row.lat,
        lon: row.lon,
        acc: row.acc,
        created_at: row.ts,
        ...raw, // expose speed, acc_x, etc if present
      };

      res.json(response);
    }
  );
});

/* =======================
   Admin login APIs
   ======================= */

// POST /api/admin/login  { email, password }
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signAdmin(email);
  res.json({ token });
});

// GET /api/admin/me   (verify token)
app.get('/api/admin/me', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ ok: true, admin: decoded });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on', PORT));
