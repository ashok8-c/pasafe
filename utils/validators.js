function requireFields(obj, fields) {
  const missing = [];

  fields.forEach((f) => {
    if (obj[f] === undefined || obj[f] === null) {
      missing.push(f);
    }
  });

  return missing;
}

module.exports = {
  requireFields
};
