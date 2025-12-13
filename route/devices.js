const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { signDevice, deviceAuthMiddleware } = require('../auth');

// Register new device
router.post('/register', (req, res) => {
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

// Get device info
router.get('/:id', (req, res) => {
  db.get(
    `SELECT * FROM devices WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'db error' });
      if (!row) return res.status(404).json({ error: 'device not found' });
      res.json(row);
    }
  );
});

// HTTP fallback — get pending commands
router.get('/:id/commands', (req, res) => {
  db.all(
    `SELECT * FROM commands WHERE device_id = ? AND status = 'pending'`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ commands: rows || [] });
    }
  );
});

// Device acknowledges a command
router.post('/:id/ack', (req, res) => {
  const { command_id, status } = req.body;

  db.run(
    `UPDATE commands SET status = ? WHERE id = ? AND device_id = ?`,
    [status || 'done', command_id, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true });
    }
  );
});

// Device posts reading via HTTP
router.post('/readings', deviceAuthMiddleware, (req, res) => {
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
      timestamp
    ],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true, reading_id: id });
    }
  );
});

module.exports = router;
