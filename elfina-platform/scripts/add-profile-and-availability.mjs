// One-off migration on the live base:
//  1. Adds the profile fields the real elfinahealth.com/therapists page
//     shows that our Therapists table was missing.
//  2. Creates a separate "Availability" table for operational data (weekly
//     capacity, active status, recurring open days/hours) -- profile and
//     capacity are different concerns with different owners (marketing/ops
//     vs. scheduling), so they don't belong in one table.
//
// Leaves the old "Weekly Capacity" / "Status" fields on Therapists in place
// (unused going forward) rather than deleting them -- field deletion is a
// destructive, hard-to-reverse schema change on the real base, not worth it
// for a rename. Ops can drop them by hand in the Airtable UI if they want.
import { readFileSync } from "node:fs";

const envFile = readFileSync(new URL("../.env", import.meta.url), "utf-8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const API = "https://api.airtable.com/v0";
const headers = { Authorization: `Bearer ${PAT}`, "content-type": "application/json" };

async function api(path, init) {
  const resp = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const body = await resp.json();
  if (!resp.ok) throw new Error(`${path} -> ${resp.status}: ${JSON.stringify(body)}`);
  return body;
}

const dateTimeOpts = { dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "utc" };

const schema = await api(`/meta/bases/${BASE_ID}/tables`);
const therapistsTable = schema.tables.find((t) => t.name === "Therapists");
if (!therapistsTable) throw new Error("Therapists table not found");

const existingFieldNames = new Set(therapistsTable.fields.map((f) => f.name));

console.log("Adding profile fields to Therapists (matching elfinahealth.com/therapists)...");
const profileFields = [
  { name: "Age", type: "number", options: { precision: 0 } },
  { name: "Years of Experience", type: "number", options: { precision: 0 } },
  { name: "Education", type: "multilineText" },
  {
    name: "Languages Spoken",
    type: "multipleSelects",
    options: { choices: ["English", "Spanish", "French", "Hindi", "Mandarin", "Arabic", "Portuguese", "German"].map((name) => ({ name })) },
  },
  { name: "Bio", type: "multilineText" },
];
for (const field of profileFields) {
  if (existingFieldNames.has(field.name)) {
    console.log(`  (skip, already exists) ${field.name}`);
    continue;
  }
  await api(`/meta/bases/${BASE_ID}/tables/${therapistsTable.id}/fields`, { method: "POST", body: JSON.stringify(field) });
  console.log(`  + Therapists.${field.name}`);
}

console.log('\nCreating "Availability" table (weekly capacity, status, recurring open days/hours)...');
const existingAvailability = schema.tables.find((t) => t.name === "Availability");
let availabilityTable;
if (existingAvailability) {
  console.log("  (skip, table already exists)");
  availabilityTable = existingAvailability;
} else {
  availabilityTable = await api(`/meta/bases/${BASE_ID}/tables`, {
    method: "POST",
    body: JSON.stringify({
      name: "Availability",
      description: "Operational scheduling data, separate from Therapists profile fields: weekly capacity, active status, recurring open days/hours.",
      fields: [
        { name: "Label", type: "singleLineText" },
        { name: "Therapist", type: "multipleRecordLinks", options: { linkedTableId: therapistsTable.id } },
        { name: "Weekly Capacity", type: "number", options: { precision: 0 } },
        {
          name: "Status",
          type: "singleSelect",
          options: { choices: [{ name: "active" }, { name: "on_leave" }, { name: "inactive" }] },
        },
        {
          name: "Available Days",
          type: "multipleSelects",
          options: { choices: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((name) => ({ name })) },
        },
        { name: "Start Time", type: "singleLineText" }, // "09:00", 24h
        { name: "End Time", type: "singleLineText" }, // "17:00", 24h
        { name: "Updated At", type: "dateTime", options: dateTimeOpts },
      ],
    }),
  });
  console.log(`  Created table: ${availabilityTable.id}`);
}

console.log("\nDone.");
