// seedDevice.js
const { db } = require('./db');

const deviceId = 1;

db.run(
  `INSERT OR IGNORE INTO devices (id) VALUES (?)`,
  [deviceId],
  (err) => {
    if (err) {
      console.error('Error inserting device:', err.message);
    } else {
      console.log('✅ Device inserted (or already existed) with id =', deviceId);
    }
    db.close();
  }
);
