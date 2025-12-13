// services/ruleEngine.js

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const notifications = require('./notifications');
const debounce = require('../utils/debounce');

// Try to get MQTT publish from mqtt/client (optional)
let mqttPublish;
try {
  mqttPublish = require('../mqtt/client').publish;
} catch (e) {
  mqttPublish = null;
}

/**
 * Thresholds
 * - ALCOHOL_THRESHOLD: minimum value to treat as alcohol event
 * - ACCIDENT_THRESHOLD: used if you send raw IMU data (ax, ay, az)
 */
const ALCOHOL_THRESHOLD = parseFloat(process.env.ALCOHOL_THRESHOLD || '0.2'); // adjust to MQ3 units
const ACCIDENT_THRESHOLD = parseFloat(process.env.ACCIDENT_THRESHOLD || '3.0'); // "g" units approx

/* ------------------------------------------------------------------
 *  ALCOHOL HANDLER
 * ------------------------------------------------------------------ */
/**
 * Expected payload:
 * {
 *   type: "alcohol",
 *   value: <number>,         // MQ3 level (voltage/ppm)
 *   lat?: <number|null>,
 *   lon?: <number|null>
 * }
 */
async function handleAlcohol(deviceId, payload) {
  const value = parseFloat(payload.value);
  if (isNaN(value) || value < ALCOHOL_THRESHOLD) return;

  // Debounce: avoid spamming alerts every few ms
  if (!debounce(`${deviceId}:alcohol`, 8000)) return;

  const ts = Date.now();
  const alertId = uuidv4();

  db.run(
    `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      alertId,
      deviceId,
      null,
      'alcohol_alert',               // for dashboard filter
      value,
      payload.lat || null,
      payload.lon || null,
      'pending',
      ts
    ]
  );

  // Optionally create a command to lock engine
  const cmdId = uuidv4();
  const cmdPayload = { cmd: 'lock_engine', reason: 'alcohol_detected', value };

  db.run(
    `INSERT INTO commands(id, device_id, command, payload, status, created_at)
     VALUES (?,?,?,?,?,?)`,
    [cmdId, deviceId, 'lock_engine', JSON.stringify(cmdPayload), 'pending', ts],
    () => {
      if (mqttPublish) {
        mqttPublish(`devices/${deviceId}/commands`, { id: cmdId, ...cmdPayload });
      }
    }
  );

  // Notifications (optional – safe to fail)
  try {
    await notifications.sendPush(null, {
      alert: 'alcohol_detected',
      deviceId,
      value
    });
  } catch (e) {}
}

/* ------------------------------------------------------------------
 *  ACCIDENT HANDLER (explicit trigger)
 * ------------------------------------------------------------------ */
/**
 * Expected payload (explicit accident event):
 * {
 *   type: "accident",
 *   value?: <number>,        // impact severity (optional)
 *   lat?: <number|null>,
 *   lon?: <number|null>
 * }
 *
 * Device or firmware decides when an accident happened.
 */
async function handleAccident(deviceId, payload) {
  if (!debounce(`${deviceId}:accident`, 5000)) return;

  const ts = Date.now();
  const alertId = uuidv4();

  db.run(
    `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      alertId,
      deviceId,
      null,
      'accident_alert',             // for dashboard
      payload.value || 1,
      payload.lat || null,
      payload.lon || null,
      'pending',
      ts
    ]
  );

  // Example command: flash lights / strobe for responders
  const cmdId = uuidv4();
  const cmdPayload = { cmd: 'strobe', reason: 'accident_detected' };

  db.run(
    `INSERT INTO commands(id, device_id, command, payload, status, created_at)
     VALUES (?,?,?,?,?,?)`,
    [cmdId, deviceId, 'strobe', JSON.stringify(cmdPayload), 'pending', ts],
    () => {
      if (mqttPublish) {
        mqttPublish(`devices/${deviceId}/commands`, { id: cmdId, ...cmdPayload });
      }
    }
  );

  try {
    await notifications.sendPush(null, {
      alert: 'accident_detected',
      deviceId
    });
  } catch (e) {}
}

/* ------------------------------------------------------------------
 *  OPTIONAL: ACCIDENT FROM RAW IMU (ax, ay, az)
 * ------------------------------------------------------------------ */
/**
 * If in future you send raw IMU frames instead of explicit "accident":
 * payload:
 * {
 *   type: "imu",
 *   ax: <number>, ay: <number>, az: <number>,
 *   lat?: <number|null>,
 *   lon?: <number|null>
 * }
 */
async function handleImu(deviceId, payload) {
  const { ax, ay, az } = payload;
  if (ax == null || ay == null || az == null) return;

  const mag = Math.sqrt(ax * ax + ay * ay + az * az);
  if (mag < ACCIDENT_THRESHOLD) return;

  if (!debounce(`${deviceId}:accident`, 5000)) return;

  const ts = Date.now();
  const alertId = uuidv4();

  db.run(
    `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      alertId,
      deviceId,
      null,
      'accident_alert',
      mag,                            // store magnitude as severity
      payload.lat || null,
      payload.lon || null,
      'pending',
      ts
    ]
  );

  const cmdId = uuidv4();
  const cmdPayload = { cmd: 'strobe', reason: 'accident_detected_imu', mag };

  db.run(
    `INSERT INTO commands(id, device_id, command, payload, status, created_at)
     VALUES (?,?,?,?,?,?)`,
    [cmdId, deviceId, 'strobe', JSON.stringify(cmdPayload), 'pending', ts],
    () => {
      if (mqttPublish) {
        mqttPublish(`devices/${deviceId}/commands`, { id: cmdId, ...cmdPayload });
      }
    }
  );

  try {
    await notifications.sendPush(null, {
      alert: 'accident_detected_imu',
      deviceId,
      mag
    });
  } catch (e) {}
}

/* ------------------------------------------------------------------
 *  SOS HANDLER
 * ------------------------------------------------------------------ */
/**
 * payload:
 * {
 *   type: "sos",
 *   value?: <number>,
 *   lat?: <number|null>,
 *   lon?: <number|null>
 * }
 */
async function handleSos(deviceId, payload) {
  if (!debounce(`${deviceId}:sos`, 3000)) return;

  const ts = Date.now();
  const alertId = uuidv4();

  db.run(
    `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      alertId,
      deviceId,
      null,
      'sos_pressed',
      payload.value || 1,
      payload.lat || null,
      payload.lon || null,
      'pending',
      ts
    ]
  );

  const cmdId = uuidv4();
  const cmdPayload = { cmd: 'siren', reason: 'sos_pressed' };

  db.run(
    `INSERT INTO commands(id, device_id, command, payload, status, created_at)
     VALUES (?,?,?,?,?,?)`,
    [cmdId, deviceId, 'siren', JSON.stringify(cmdPayload), 'pending', ts],
    () => {
      if (mqttPublish) {
        mqttPublish(`devices/${deviceId}/commands`, { id: cmdId, ...cmdPayload });
      }
    }
  );

  try {
    await notifications.sendSms(null, `SOS pressed on device ${deviceId}`);
    await notifications.sendPush(null, { alert: 'sos_pressed', deviceId });
  } catch (e) {}
}

/* ------------------------------------------------------------------
 *  BLE TRIGGER HANDLER (generic BLE events)
 * ------------------------------------------------------------------ */
/**
 * payload:
 * {
 *   type: "ble" | "ble_custom",
 *   lat?: <number|null>,
 *   lon?: <number|null>
 * }
 */
async function handleBleTrigger(deviceId, payload) {
  if (!payload || !payload.type) return;
  if (!debounce(`${deviceId}:ble:${payload.type}`, 3000)) return;

  const ts = Date.now();
  const alertId = uuidv4();
  const alertType = `ble_${payload.type}`;

  db.run(
    `INSERT INTO alerts(id, device_id, user_id, type, value, lat, lon, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      alertId,
      deviceId,
      null,
      alertType,
      null,
      payload.lat || null,
      payload.lon || null,
      'pending',
      ts
    ]
  );

  const cmdId = uuidv4();
  const cmdPayload = { cmd: 'siren', reason: alertType };

  db.run(
    `INSERT INTO commands(id, device_id, command, payload, status, created_at)
     VALUES (?,?,?,?,?,?)`,
    [cmdId, deviceId, 'siren', JSON.stringify(cmdPayload), 'pending', ts],
    () => {
      if (mqttPublish) {
        mqttPublish(`devices/${deviceId}/commands`, { id: cmdId, ...cmdPayload });
      }
    }
  );

  try {
    await notifications.sendPush(null, { alert: alertType, deviceId });
  } catch (e) {}
}

/* ------------------------------------------------------------------
 *  MAIN ENTRY POINT
 * ------------------------------------------------------------------ */
/**
 * Called from mqtt/client.js, for example:
 *
 *   processTelemetry(deviceId, payload);
 *
 * where "payload" is an object parsed from JSON coming from device.
 */
async function processTelemetry(deviceId, payload) {
  if (!deviceId || !payload || !payload.type) return;

  const t = String(payload.type).toLowerCase();

  if (t === 'alcohol')  return handleAlcohol(deviceId, payload);
  if (t === 'accident') return handleAccident(deviceId, payload);
  if (t === 'imu' || t === 'motion') return handleImu(deviceId, payload); // optional
  if (t === 'sos')      return handleSos(deviceId, payload);
  if (t.startsWith('ble_') || t === 'ble') return handleBleTrigger(deviceId, payload);

  // Unknown type → ignore safely
  return;
}

module.exports = {
  processTelemetry,
  handleAlcohol,
  handleAccident,
  handleImu,
  handleSos,
  handleBleTrigger
};
