// mqtt/client.js (Render-safe)
const mqtt = require('mqtt');
const { v4: uuidv4 } = require('uuid');
const { processTelemetry } = require('../services/ruleEngine');

/**
 * Enable MQTT only when explicitly allowed
 * Example:
 *   MQTT_ENABLED=true
 */
const MQTT_ENABLED = process.env.MQTT_ENABLED === 'true';

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const TELEMETRY_TOPIC =
  process.env.MQTT_TELEMETRY_TOPIC || 'pasafe/readings';

let client = null;

if (!MQTT_ENABLED) {
  console.log('⚠️ MQTT is disabled (safe mode for Render deployment)');
} else {
  try {
    client = mqtt.connect(MQTT_BROKER, {
      clientId: `pasafe-backend-${uuidv4()}`,
      reconnectPeriod: 2000,
    });

    client.on('connect', () => {
      console.log('✅ MQTT connected to', MQTT_BROKER);

      client.subscribe(TELEMETRY_TOPIC, (err) => {
        if (err) {
          console.error('❌ MQTT subscription error:', err.message);
        } else {
          console.log('📡 Subscribed to topic:', TELEMETRY_TOPIC);
        }
      });
    });

    client.on('error', (err) => {
      console.error('❌ MQTT error:', err.message);
    });

    client.on('message', async (topic, message) => {
      if (topic !== TELEMETRY_TOPIC) return;

      let payload;
      try {
        payload = JSON.parse(message.toString());
      } catch (e) {
        console.error('❌ Invalid JSON from device:', message.toString());
        return;
      }

      const { deviceId, ...rest } = payload;

      if (!deviceId) {
        console.warn('⚠️ Missing deviceId in payload:', payload);
        return;
      }

      console.log('📥 Telemetry received:', payload);

      try {
        await processTelemetry(deviceId, rest);
      } catch (e) {
        console.error(
          '❌ ruleEngine.processTelemetry error:',
          e.message
        );
      }
    });
  } catch (e) {
    console.error('❌ MQTT initialization failed:', e.message);
  }
}

// Safe publish (won’t crash if MQTT disabled)
function publish(topic, message, opts = {}, cb = () => {}) {
  if (!MQTT_ENABLED || !client) {
    console.log('⚠️ MQTT publish skipped (disabled)');
    return;
  }

  const payload =
    typeof message === 'string' ? message : JSON.stringify(message);

  client.publish(topic, payload, opts, cb);
}

module.exports = {
  publish,
};
