const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { deviceAuthMiddleware } = require('../auth');

// Post reading (device → HTTP)
// Protected by deviceAuthMiddleware
router.post('/', deviceAuthMiddleware, (req, res) => {
  const device_id = req.deviceId;
  const { ts, type, value, raw, lat, lon, acc } = req.body;

  if (!type)
    return res.status(400).json({ error: 'reading type required' });

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

      res.json({
        ok: true,
        reading_id: id
      });
    }
  );
});

// Get readings of a device
router.get('/:device_id', (req, res) => {
  db.all(
    `SELECT * FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 200`,
    [req.params.device_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json(rows);
    }
  );
});

module.exports = router;
