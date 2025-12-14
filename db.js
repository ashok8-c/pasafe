const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "pasafe";

let client;
let db;

async function init() {
  if (db) return db;

  client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db(DB_NAME);

  // Create collections (safe if already exist)
  await Promise.all([
    db.createCollection("users").catch(() => {}),
    db.createCollection("devices").catch(() => {}),
    db.createCollection("readings").catch(() => {}),
    db.createCollection("alerts").catch(() => {}),
    db.createCollection("commands").catch(() => {})
  ]);

  // Indexes (same purpose as SQLite indexes)
  await db.collection("readings").createIndex(
    { device_id: 1, ts: -1 }
  );

  await db.collection("alerts").createIndex(
    { device_id: 1, created_at: -1 }
  );

  console.log("✅ MongoDB initialized successfully");
  return db;
}

function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}

module.exports = {
  init,
  getDb
};

