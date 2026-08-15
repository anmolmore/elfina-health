// One-off: applies scripts/rds-schema.sql against DATABASE_URL. Avoids
// needing psql installed locally. Idempotent (schema uses IF NOT EXISTS).
//
// Usage: DATABASE_URL=postgres://... node scripts/apply-schema.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.join(__dirname, "rds-schema.sql"), "utf8");

const client = new Client({
  connectionString: requireEnv("DATABASE_URL"),
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(sql);
  console.log("[apply-schema] schema applied successfully");
} finally {
  await client.end();
}
