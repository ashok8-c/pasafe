// services/notifications.js
require('dotenv').config();
const twilio = require('twilio');

// Twilio config
const TWILIO_SID   = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_FROM;

let smsClient = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  smsClient = twilio(TWILIO_SID, TWILIO_TOKEN);
}

// Emergency contacts demo list
// Change phone & coordinates for your real testing
const EMERGENCY_POINTS = [
  {
    id: 'hosp-1',
    type: 'hospital',
    name: 'Calcutta Medical Hospital',
    phone: '+91XXXXXXXXXX',
    lat: 22.5728,
    lon: 88.3629
  },
  {
    id: 'police-1',
    type: 'police',
    name: 'Local Police Station',
    phone: '+91YYYYYYYYYY',
    lat: 22.5710,
    lon: 88.3600
  }
];

// Calculate distance KM (haversine)
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d*(Math.PI/180);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

/**
 * Notify hospitals & police within X km
 */
async function notifyNearbyEmergency(alert, radiusKm = 3) {
  const { lat, lon, type, device_id } = alert;

  if (!lat || !lon) {
    console.warn('❌ Missing coordinates, cannot notify emergency contacts');
    return;
  }

  console.log(`🛰 Searching emergency contacts within ${radiusKm} km`);

  const targets = EMERGENCY_POINTS.filter(p =>
    distanceKm(lat, lon, p.lat, p.lon) <= radiusKm
  );

  if (!targets.length) {
    console.log('ℹ No emergency contacts found within range');
    return;
  }

  const msg = `PA-SAFE ALERT: ${type.toUpperCase()} detected.
Location: (${lat.toFixed(4)}, ${lon.toFixed(4)})
Device: ${device_id}`;

  console.log('📡 Notifying:', targets.map(t => t.name));

  // If Twilio not configured, fallback to console logs
  if (!smsClient || !TWILIO_FROM) {
    console.log('⚠ Twilio not configured - SMS not sent');
    console.log('📍 SMS message that would be sent:\n', msg);
    return;
  }

  await Promise.all(
    targets.map(t =>
      smsClient.messages.create({
        body: msg,
        from: TWILIO_FROM,
        to: t.phone
      })
    )
  );

  console.log('📬 SMS alerts delivered successfully');
}

module.exports = {
  notifyNearbyEmergency
};
