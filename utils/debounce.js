const lastEvent = {};

function debounce(key, windowMs = 5000) {
  const now = Date.now();

  if (lastEvent[key] && now - lastEvent[key] < windowMs) {
    return false;
  }

  lastEvent[key] = now;
  return true;
}

module.exports = debounce;
