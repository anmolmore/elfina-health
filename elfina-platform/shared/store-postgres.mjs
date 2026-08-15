// Best-effort Postgres mirror for the store seam (shared/store.mjs). Only
// used when STORE_MODE=dual. Airtable stays authoritative -- every function
// here is fire-and-forget from the caller's perspective: failures are
// logged, never thrown, so a stopped/unreachable RDS instance can never
// break a request.
//
// Only Clients, Sessions, and Matches are ever created/updated by the
// running services (Therapists/Availability/Feedback only come from the
// one-off scripts in scripts/), so those are the only tables mapped here.
// Anything else is a silent no-op.

import pg from "pg";

const { Pool } = pg;

let pool;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Missing required env var DATABASE_URL for STORE_MODE=dual");
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 2000,
      statement_timeout: 3000,
      max: 5,
    });
    pool.on("error", (err) => console.error("[store-postgres] idle client error", err));
  }
  return pool;
}

async function resolveId(client, table, airtableId) {
  if (!airtableId) return null;
  const { rows } = await client.query(`select id from ${table} where airtable_id = $1`, [airtableId]);
  return rows[0]?.id ?? null;
}

const TABLES = {
  Clients: {
    table: "clients",
    async insert(client, record) {
      const f = record.fields;
      await client.query(
        `insert into clients (airtable_id, name, email, phone, intake_notes, status)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (airtable_id) do update set
           name = excluded.name, email = excluded.email, phone = excluded.phone,
           intake_notes = excluded.intake_notes, status = excluded.status, updated_at = now()`,
        [record.id, f.Name, f.Email, f.Phone ?? null, f["Intake Notes"] ?? null, f.Status ?? "intake"]
      );
    },
    async update(client, airtableId, fields) {
      const sets = [];
      const values = [];
      if ("Name" in fields) { values.push(fields.Name); sets.push(`name = $${values.length}`); }
      if ("Email" in fields) { values.push(fields.Email); sets.push(`email = $${values.length}`); }
      if ("Phone" in fields) { values.push(fields.Phone); sets.push(`phone = $${values.length}`); }
      if ("Intake Notes" in fields) { values.push(fields["Intake Notes"]); sets.push(`intake_notes = $${values.length}`); }
      if ("Status" in fields) { values.push(fields.Status); sets.push(`status = $${values.length}`); }
      if (sets.length === 0) return;
      values.push(airtableId);
      await client.query(`update clients set ${sets.join(", ")}, updated_at = now() where airtable_id = $${values.length}`, values);
    },
  },
  Matches: {
    table: "matches",
    async insert(client, record) {
      const f = record.fields;
      const clientId = await resolveId(client, "clients", f.Client?.[0]);
      const therapistId = await resolveId(client, "therapists", f.Therapist?.[0]);
      if (!clientId || !therapistId) {
        console.warn(`[store-postgres] skipping Matches mirror ${record.id}: client or therapist not backfilled yet`);
        return;
      }
      await client.query(
        `insert into matches (airtable_id, client_id, therapist_id, status)
         values ($1, $2, $3, $4)
         on conflict (airtable_id) do update set status = excluded.status, updated_at = now()`,
        [record.id, clientId, therapistId, f.Status ?? "accepted"]
      );
    },
    async update(client, airtableId, fields) {
      if (!("Status" in fields)) return;
      await client.query(`update matches set status = $1, updated_at = now() where airtable_id = $2`, [fields.Status, airtableId]);
    },
  },
  Sessions: {
    table: "sessions",
    async insert(client, record) {
      const f = record.fields;
      const clientId = await resolveId(client, "clients", f.Client?.[0]);
      if (!clientId) {
        console.warn(`[store-postgres] skipping Sessions mirror ${record.id}: client not backfilled yet`);
        return;
      }
      const matchId = await resolveId(client, "matches", f.Match?.[0]);
      const therapistId = await resolveId(client, "therapists", f.Therapist?.[0]);
      await client.query(
        `insert into sessions
           (airtable_id, match_id, client_id, therapist_id, slot_start, slot_end, meeting_link, status, booked_by, raw_source_payload)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (airtable_id) do update set
           slot_start = excluded.slot_start, slot_end = excluded.slot_end,
           meeting_link = excluded.meeting_link, status = excluded.status, updated_at = now()`,
        [
          record.id, matchId, clientId, therapistId,
          f["Slot Start"] ?? null, f["Slot End"] ?? null, f["Meeting Link"] ?? null,
          f.Status ?? "scheduled", f["Booked By"] ?? "unknown",
          f["Booked By"] === "neetocal" ? JSON.stringify(f) : null,
        ]
      );
    },
    async update(client, airtableId, fields) {
      const sets = [];
      const values = [];
      if ("Slot Start" in fields) { values.push(fields["Slot Start"]); sets.push(`slot_start = $${values.length}`); }
      if ("Slot End" in fields) { values.push(fields["Slot End"]); sets.push(`slot_end = $${values.length}`); }
      if ("Meeting Link" in fields) { values.push(fields["Meeting Link"]); sets.push(`meeting_link = $${values.length}`); }
      if ("Status" in fields) { values.push(fields.Status); sets.push(`status = $${values.length}`); }
      if (sets.length === 0) return;
      values.push(airtableId);
      await client.query(`update sessions set ${sets.join(", ")}, updated_at = now() where airtable_id = $${values.length}`, values);
    },
  },
};

export async function mirrorCreate(table, record) {
  const mapping = TABLES[table];
  if (!mapping) return;
  const client = await getPool().connect();
  try {
    await mapping.insert(client, record);
  } finally {
    client.release();
  }
}

export async function mirrorUpdate(table, airtableId, fields) {
  const mapping = TABLES[table];
  if (!mapping) return;
  const client = await getPool().connect();
  try {
    await mapping.update(client, airtableId, fields);
  } finally {
    client.release();
  }
}
