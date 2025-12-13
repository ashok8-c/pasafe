const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

// Create an alert manually (phone, BLE gateway, app)
router.post('/', (req, res) => {
  const { device_id, user_id, type, value, lat, lon } = req.body;

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
      user_id || null,
      type,
      value || null,
      lat || null,
      lon || null,
      'pending',
      ts
    ],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true, alert_id: id });
    }
  );
});

// Get all alerts (limit)
router.get('/', (req, res) => {
  db.all(
    `SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json(rows);
    }
  );
});

// Get single alert
router.get('/:id', (req, res) => {
  db.get(
    `SELECT * FROM alerts WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'db error' });
      if (!row) return res.status(404).json({ error: 'alert not found' });
      res.json(row);
    }
  );
});

// Update alert status (resolved, dismissed, etc.)
router.put('/:id/status', (req, res) => {
  const { status } = req.body;

  db.run(
    `UPDATE alerts SET status = ? WHERE id = ?`,
    [status, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true });
    }
  );
});

module.exports = router;
