const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

// Register user
router.post('/register', (req, res) => {
  const { name, phone, emergency_contacts } = req.body;

  if (!name || !phone)
    return res.status(400).json({ error: 'name & phone required' });

  const id = uuidv4();
  const identityId = `ID-${id.slice(0, 8)}`;

  db.run(
    `INSERT INTO users(id, name, phone, emergency_contacts, identity_card_id)
     VALUES (?,?,?,?,?)`,
    [
      id,
      name,
      phone,
      JSON.stringify(emergency_contacts || []),
      identityId
    ],
    (err) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json({ ok: true, user_id: id, identity_card_id: identityId });
    }
  );
});

// Get user by ID
router.get('/:id', (req, res) => {
  db.get(
    `SELECT * FROM users WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'db error' });
      if (!row) return res.status(404).json({ error: 'user not found' });
      res.json(row);
    }
  );
});

module.exports = router;
