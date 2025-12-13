// simulator.js
// Fake PA-SAFE device sending telemetry to test backend

require('dotenv').config();
const mqtt = require('mqtt');

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';

// Which virtual device to simulate (must match what frontend uses, e.g. device 1)
const DEVICE_ID = process.env.SIM_DEVICE_ID || '1';

// This MUST match what server.js subscribes to: "devices/+/telemetry"
const TELEMETRY_TOPIC = `devices/${DEVICE_ID}/telemetry`;

// How often to send messages (ms)
const SEND_INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS || 3000);

const client = mqtt.connect(MQTT_BROKER, {
  clientId: 'pa-safe-simulator',
  reconnectPeriod: 2000,
});

client.on('connect', () => {
  console.log('✅ Simulator connected to', MQTT_BROKER);
  console.log('   Publishing as device', DEVICE_ID, 'to topic:', TELEMETRY_TOPIC);

  setInterval(() => {
    const event = buildRandomEvent();
    const payload = JSON.stringify(event);
    client.publish(TELEMETRY_TOPIC, payload);
    console.log('📤 Sent:', payload);
  }, SEND_INTERVAL_MS);
});

client.on('error', (err) => {
  console.error('Simulator MQTT error:', err.message);
});

/**
 * Build a fake telemetry event that the backend understands.
 *
 * Backend expects:
 *   payload.type  = 'alcohol' | 'fall' | 'sos'
 *   payload.value = number (for alcohol) or 1 (for fall/sos)
 *   payload.lat / payload.lon = coords (used for map & alerts)
 *   payload.raw  = optional extra sensor info (JSON)
 */
function buildRandomEvent() {
  const baseLat = 22.5726;  // Kolkata demo location
  const baseLon = 88.3639;

  // small random jitter so the map isn't static
  const lat = baseLat + (Math.random() - 0.5) * 0.01;
  const lon = baseLon + (Math.random() - 0.5) * 0.01;

  const base = {
    lat,
    lon,
    acc: 0.9,   // GPS accuracy (optional)
    raw: {
      speed: Math.floor(Math.random() * 80),   // km/h
      acc_x: (Math.random() - 0.5) * 2,
      acc_y: (Math.random() - 0.5) * 2,
    },
  };

  const r = Math.random();

  // ~20% chance: fall (accident)
  if (r < 0.2) {
    return {
      ...base,
      type: 'fall',   // ✅ backend treats this as fall_detected
      value: 1,
    };
  }

  // next ~20% chance: SOS
  if (r < 0.4) {
    return {
      ...base,
      type: 'sos',    // ✅ backend treats this as sos_pressed
      value: 1,
    };
  }

  // next ~30% chance: high alcohol (should trigger alert + engine lock)
  if (r < 0.7) {
    const highValue = 0.5 + Math.random() * 2.0; // > 0.2 threshold
    return {
      ...base,
      type: 'alcohol',
      value: Number(highValue.toFixed(2)),
    };
  }

  // remaining ~30%: low alcohol, normal driving (no alert)
  const lowValue = Math.random() * 0.15;         // below 0.2 threshold
  return {
    ...base,
    type: 'alcohol',
    value: Number(lowValue.toFixed(2)),
  };
}
