// One-off script: creates the real Elfina Health Airtable base with the
// five tables from the brief (Clients, Therapists, Matches, Sessions,
// Feedback), then adds the linked-record fields in a second pass (Airtable's
// create-base API can't forward-reference tables created in the same call).
import { readFileSync } from "node:fs";

const envFile = readFileSync(new URL("../.env", import.meta.url), "utf-8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const PAT = process.env.AIRTABLE_PAT;
const WORKSPACE_ID = process.argv[2];
if (!PAT || !WORKSPACE_ID) {
  console.error("Usage: node scripts/create-base.mjs <workspaceId>");
  process.exit(1);
}

const API = "https://api.airtable.com/v0";
const headers = { Authorization: `Bearer ${PAT}`, "content-type": "application/json" };

async function api(path, init) {
  const resp = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const body = await resp.json();
  if (!resp.ok) throw new Error(`${path} -> ${resp.status}: ${JSON.stringify(body)}`);
  return body;
}

const dateTimeOpts = {
  dateFormat: { name: "iso" },
  timeFormat: { name: "24hour" },
  timeZone: "utc",
};

const tables = [
  {
    name: "Clients",
    description: "Clients seeking therapy. System-of-record for identity + intake status.",
    fields: [
      { name: "Name", type: "singleLineText" },
      { name: "Email", type: "email" },
      { name: "Phone", type: "phoneNumber" },
      { name: "Intake Notes", type: "multilineText" },
      {
        name: "Status",
        type: "singleSelect",
        options: { choices: [{ name: "intake" }, { name: "matched" }, { name: "active" }, { name: "paused" }, { name: "discharged" }] },
      },
      { name: "Updated At", type: "dateTime", options: dateTimeOpts },
    ],
  },
  {
    name: "Therapists",
    description: "Therapists available for matching.",
    fields: [
      { name: "Name", type: "singleLineText" },
      { name: "Email", type: "email" },
      {
        name: "Specialties",
        type: "multipleSelects",
        options: { choices: ["CBT", "EMDR", "Trauma", "Anxiety", "Couples", "Family", "DBT", "Grief"].map((name) => ({ name })) },
      },
      { name: "Weekly Capacity", type: "number", options: { precision: 0 } },
      {
        name: "Status",
        type: "singleSelect",
        options: { choices: [{ name: "active" }, { name: "on_leave" }, { name: "inactive" }] },
      },
      { name: "Updated At", type: "dateTime", options: dateTimeOpts },
    ],
  },
  {
    name: "Matches",
    description: "A proposed/accepted pairing of one client with one therapist.",
    fields: [
      { name: "Label", type: "singleLineText" },
      {
        name: "Status",
        type: "singleSelect",
        options: { choices: [{ name: "proposed" }, { name: "accepted" }, { name: "declined" }, { name: "ended" }] },
      },
      { name: "Updated At", type: "dateTime", options: dateTimeOpts },
    ],
  },
  {
    name: "Sessions",
    description: "Booked therapy sessions, written both by the Booking App and manually by ops.",
    fields: [
      { name: "Label", type: "singleLineText" },
      { name: "Slot Start", type: "dateTime", options: dateTimeOpts },
      { name: "Slot End", type: "dateTime", options: dateTimeOpts },
      { name: "Meeting Link", type: "url" },
      {
        name: "Status",
        type: "singleSelect",
        options: { choices: [{ name: "scheduled" }, { name: "completed" }, { name: "cancelled" }, { name: "no_show" }] },
      },
      {
        name: "Booked By",
        type: "singleSelect",
        options: { choices: [{ name: "booking-app" }, { name: "ops-manual" }] },
      },
      { name: "Updated At", type: "dateTime", options: dateTimeOpts },
    ],
  },
  {
    name: "Feedback",
    description: "Post-session client feedback.",
    fields: [
      { name: "Label", type: "singleLineText" },
      { name: "Rating", type: "number", options: { precision: 0 } },
      { name: "Comment", type: "multilineText" },
      { name: "Created At", type: "dateTime", options: dateTimeOpts },
    ],
  },
];

console.log(`Creating base "Elfina Health" in workspace ${WORKSPACE_ID}...`);
const base = await api("/meta/bases", {
  method: "POST",
  body: JSON.stringify({ name: "Elfina Health", workspaceId: WORKSPACE_ID, tables }),
});
console.log(`Base created: ${base.id}`);

const tableIdByName = Object.fromEntries(base.tables.map((t) => [t.name, t.id]));
console.log("Tables:", tableIdByName);

// --- Phase 2: link fields, now that every table has an id -----------------
async function addField(tableName, field) {
  const tableId = tableIdByName[tableName];
  const created = await api(`/meta/bases/${base.id}/tables/${tableId}/fields`, {
    method: "POST",
    body: JSON.stringify(field),
  });
  console.log(`  + ${tableName}.${created.name}`);
  return created;
}

console.log("Adding linked-record fields...");
await addField("Matches", { name: "Client", type: "multipleRecordLinks", options: { linkedTableId: tableIdByName.Clients } });
await addField("Matches", { name: "Therapist", type: "multipleRecordLinks", options: { linkedTableId: tableIdByName.Therapists } });

await addField("Sessions", { name: "Match", type: "multipleRecordLinks", options: { linkedTableId: tableIdByName.Matches } });
await addField("Sessions", { name: "Client", type: "multipleRecordLinks", options: { linkedTableId: tableIdByName.Clients } });
await addField("Sessions", { name: "Therapist", type: "multipleRecordLinks", options: { linkedTableId: tableIdByName.Therapists } });

await addField("Feedback", { name: "Session", type: "multipleRecordLinks", options: { linkedTableId: tableIdByName.Sessions } });
await addField("Feedback", { name: "Client", type: "multipleRecordLinks", options: { linkedTableId: tableIdByName.Clients } });

console.log("\nDone. Base ID:", base.id);

const fs = await import("node:fs");
fs.appendFileSync(new URL("../.env", import.meta.url), `\nAIRTABLE_BASE_ID=${base.id}\n`);
console.log("Wrote AIRTABLE_BASE_ID to .env");
