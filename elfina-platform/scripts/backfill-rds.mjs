// One-off backfill: Airtable -> Postgres, idempotent upsert by airtable_id.
// Reads via shared/airtable.mjs directly (admin script, not a request path
// -- shared/store.mjs's dual-write is for the running services only).
//
// Order matters: Clients, Therapists first (nothing depends on them);
// Availability, Matches next (depend on Therapists/Clients); Sessions next
// (depends on Matches/Clients/Therapists); Feedback last (depends on
// Sessions/Clients). Matches docs/airtable-to-rds-migration-plan.md phase 3.
//
// Usage: DATABASE_URL=postgres://... AIRTABLE_PAT=... AIRTABLE_BASE_ID=... node scripts/backfill-rds.mjs

import pg from "pg";
import { airtableClient, firstLink } from "../shared/airtable.mjs";

const { Client } = pg;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const at = airtableClient();
const db = new Client({ connectionString: requireEnv("DATABASE_URL"), ssl: { rejectUnauthorized: false } });
await db.connect();

async function resolveId(table, airtableId) {
  if (!airtableId) return null;
  const { rows } = await db.query(`select id from ${table} where airtable_id = $1`, [airtableId]);
  return rows[0]?.id ?? null;
}

let counts = {};

async function backfillClients() {
  const records = await at.list("Clients");
  for (const r of records) {
    const f = r.fields;
    await db.query(
      `insert into clients (airtable_id, name, email, phone, intake_notes, status)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (airtable_id) do update set
         name = excluded.name, email = excluded.email, phone = excluded.phone,
         intake_notes = excluded.intake_notes, status = excluded.status, updated_at = now()`,
      [r.id, f.Name, f.Email, f.Phone ?? null, f["Intake Notes"] ?? null, f.Status ?? "intake"]
    );
  }
  counts.clients = records.length;
}

async function backfillTherapists() {
  const records = await at.list("Therapists");
  for (const r of records) {
    const f = r.fields;
    await db.query(
      `insert into therapists (airtable_id, name, email, age, years_of_experience, education, bio, specialties, languages_spoken, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (airtable_id) do update set
         name = excluded.name, email = excluded.email, age = excluded.age,
         years_of_experience = excluded.years_of_experience, education = excluded.education,
         bio = excluded.bio, specialties = excluded.specialties, languages_spoken = excluded.languages_spoken,
         status = excluded.status, updated_at = now()`,
      [
        r.id, f.Name, f.Email ?? "", f.Age ?? null, f["Years of Experience"] ?? null,
        f.Education ?? null, f.Bio ?? null, f.Specialties ?? [], f["Languages Spoken"] ?? [],
        f.Status ?? "active",
      ]
    );
  }
  counts.therapists = records.length;
}

async function backfillAvailability() {
  const records = await at.list("Availability");
  let inserted = 0;
  for (const r of records) {
    const f = r.fields;
    const therapistId = await resolveId("therapists", firstLink(f.Therapist));
    if (!therapistId) {
      console.warn(`[backfill] skipping Availability ${r.id}: therapist not found`);
      continue;
    }
    const days = (f["Available Days"] || []).map((d) => DAY_NAMES.indexOf(d)).filter((i) => i >= 0);
    await db.query(
      `insert into availability (airtable_id, therapist_id, weekly_capacity, status, available_days, start_time, end_time)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (airtable_id) do update set
         weekly_capacity = excluded.weekly_capacity, status = excluded.status,
         available_days = excluded.available_days, start_time = excluded.start_time,
         end_time = excluded.end_time, updated_at = now()`,
      [r.id, therapistId, f["Weekly Capacity"] ?? 0, f.Status ?? "active", days, f["Start Time"] ?? "09:00", f["End Time"] ?? "17:00"]
    );
    inserted++;
  }
  counts.availability = inserted;
}

async function backfillMatches() {
  const records = await at.list("Matches");
  let inserted = 0;
  for (const r of records) {
    const f = r.fields;
    const clientId = await resolveId("clients", firstLink(f.Client));
    const therapistId = await resolveId("therapists", firstLink(f.Therapist));
    if (!clientId || !therapistId) {
      console.warn(`[backfill] skipping Match ${r.id}: client or therapist not found`);
      continue;
    }
    await db.query(
      `insert into matches (airtable_id, client_id, therapist_id, status)
       values ($1, $2, $3, $4)
       on conflict (airtable_id) do update set status = excluded.status, updated_at = now()`,
      [r.id, clientId, therapistId, f.Status ?? "accepted"]
    );
    inserted++;
  }
  counts.matches = inserted;
}

async function backfillSessions() {
  const records = await at.list("Sessions");
  let inserted = 0;
  for (const r of records) {
    const f = r.fields;
    const clientId = await resolveId("clients", firstLink(f.Client));
    if (!clientId) {
      console.warn(`[backfill] skipping Session ${r.id}: client not found`);
      continue;
    }
    const matchId = await resolveId("matches", firstLink(f.Match));
    const therapistId = await resolveId("therapists", firstLink(f.Therapist));
    await db.query(
      `insert into sessions
         (airtable_id, match_id, client_id, therapist_id, slot_start, slot_end, meeting_link, status, booked_by, raw_source_payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (airtable_id) do update set
         slot_start = excluded.slot_start, slot_end = excluded.slot_end,
         meeting_link = excluded.meeting_link, status = excluded.status, updated_at = now()`,
      [
        r.id, matchId, clientId, therapistId,
        f["Slot Start"] ?? null, f["Slot End"] ?? null, f["Meeting Link"] ?? null,
        f.Status ?? "scheduled", f["Booked By"] ?? "unknown",
        f["Booked By"] === "neetocal" ? JSON.stringify(f) : null,
      ]
    );
    inserted++;
  }
  counts.sessions = inserted;
}

async function backfillFeedback() {
  const records = await at.list("Feedback");
  let inserted = 0;
  for (const r of records) {
    const f = r.fields;
    const sessionId = await resolveId("sessions", firstLink(f.Session));
    const clientId = await resolveId("clients", firstLink(f.Client));
    if (!sessionId || !clientId) {
      console.warn(`[backfill] skipping Feedback ${r.id}: session or client not found`);
      continue;
    }
    await db.query(
      `insert into feedback (airtable_id, session_id, client_id, rating, comment)
       values ($1, $2, $3, $4, $5)
       on conflict (airtable_id) do update set rating = excluded.rating, comment = excluded.comment`,
      [r.id, sessionId, clientId, f.Rating ?? null, f.Comment ?? null]
    );
    inserted++;
  }
  counts.feedback = inserted;
}

try {
  await backfillClients();
  await backfillTherapists();
  await backfillAvailability();
  await backfillMatches();
  await backfillSessions();
  await backfillFeedback();
  console.log("[backfill] done:", counts);
} finally {
  await db.end();
}
