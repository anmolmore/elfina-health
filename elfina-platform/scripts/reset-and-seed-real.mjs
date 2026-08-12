// Wipes the demo data created so far and rebuilds the base with:
//  - the real 42 therapists scraped from elfinahealth.com/therapists
//  - a matching Availability row per therapist
//  - ~120 synthetic clients
//  - ~120 matches (one per client)
//  - a year of Session history (~450-500 records, day-to-day variance,
//    growth trend matching the brief's "~800/mo, +10% MoM" shape, scaled
//    down to stay well under Airtable's 1,000-record free-tier base cap
//    once every table is counted)
//  - 100 Feedback records against completed sessions
import { airtableClient, linkOne } from "../shared/airtable.mjs";
import { THERAPISTS } from "./therapists-data.mjs";

const at = airtableClient();
const now = () => new Date().toISOString();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

async function wipe() {
  for (const table of ["Feedback", "Sessions", "Matches", "Availability", "Clients", "Therapists"]) {
    const n = await at.deleteAll(table);
    console.log(`  wiped ${n} from ${table}`);
  }
}

async function seedTherapists() {
  const records = THERAPISTS.map((t) => ({
    Name: t.name,
    Email: t.name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "") + "@elfinahealth.com",
    Age: t.age,
    "Years of Experience": t.years,
    Education: t.education,
    "Languages Spoken": t.languages,
    Specialties: t.specialties,
    Bio: t.bio,
    "Updated At": now(),
  }));
  const created = await at.createBatch("Therapists", records, { typecast: true });
  console.log(`  created ${created.length} therapists`);
  return created;
}

const SHIFT_PATTERNS = [
  ["09:00", "17:00"],
  ["10:00", "18:00"],
  ["08:00", "16:00"],
  ["11:00", "19:00"],
];
const DAY_SETS = [
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  ["Monday", "Wednesday", "Friday"],
  ["Tuesday", "Wednesday", "Thursday", "Friday"],
  ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"],
  ["Monday", "Tuesday", "Wednesday"],
];

async function seedAvailability(therapists) {
  const records = therapists.map((t) => {
    const [start, end] = pick(SHIFT_PATTERNS);
    const days = pick(DAY_SETS);
    const status = Math.random() < 0.9 ? "active" : "on_leave";
    return {
      Label: `${t.fields.Name} — ${days.join("/")} ${start}-${end}`,
      Therapist: linkOne(t.id),
      "Weekly Capacity": randInt(10, 25),
      Status: status,
      "Available Days": days,
      "Start Time": start,
      "End Time": end,
      "Updated At": now(),
    };
  });
  const created = await at.createBatch("Availability", records, { typecast: true });
  console.log(`  created ${created.length} availability rows`);
  return created;
}

const FIRST_NAMES = ["Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Ayaan", "Krishna", "Ishaan", "Ananya", "Diya", "Aadhya", "Myra", "Sara", "Anika", "Navya", "Kiara", "Riya", "Pari", "Aisha", "Meera", "Rohan", "Karan", "Nikhil", "Rahul", "Priya", "Neha", "Pooja", "Divya", "Sneha", "Anjali", "Kavya", "Sanya", "Tara", "Arnav", "Vedant", "Kabir", "Advait", "Yash"];
const LAST_NAMES = ["Sharma", "Verma", "Gupta", "Mehta", "Shah", "Iyer", "Nair", "Menon", "Reddy", "Rao", "Kapoor", "Malhotra", "Chopra", "Bose", "Chatterjee", "Banerjee", "Joshi", "Desai", "Patel", "Kulkarni", "Agarwal", "Bhatt", "Pillai", "Krishnan", "Nambiar", "Sen", "Ghosh", "Mukherjee", "Das", "Roy"];
const CLIENT_STATUSES = ["active", "active", "active", "matched", "paused", "discharged"];

function makeClientName(i) {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}${i}`; // numeric suffix keeps names+emails unique
}

async function seedClients(count) {
  const records = [];
  for (let i = 1; i <= count; i++) {
    const name = makeClientName(i);
    records.push({
      Name: name.replace(/\d+$/, ""),
      Email: name.toLowerCase().replace(/\s+/g, ".") + "@example.com",
      Phone: "+91" + randInt(7000000000, 9999999999),
      "Intake Notes": "Synthetic client for year-of-history demo data.",
      Status: pick(CLIENT_STATUSES),
      "Updated At": now(),
    });
  }
  const created = await at.createBatch("Clients", records, { typecast: true });
  console.log(`  created ${created.length} clients`);
  return created;
}

async function seedMatches(clients, therapists) {
  const records = clients.map((c) => {
    const t = pick(therapists);
    return {
      Label: `${c.fields.Name} <-> ${t.fields.Name}`,
      Client: linkOne(c.id),
      Therapist: linkOne(t.id),
      Status: "accepted",
      "Updated At": now(),
      _therapistId: t.id, // stripped before sending; kept for local lookup
    };
  });
  const clean = records.map(({ _therapistId, ...f }) => f);
  const created = await at.createBatch("Matches", clean, { typecast: true });
  return created.map((m, i) => ({ ...m, therapistId: records[i]._therapistId, clientId: clients[i].id }));
}

function sessionsCountForDay(daysAgo) {
  const progress = (365 - daysAgo) / 365; // 0 = a year ago, 1 = yesterday
  const base = 0.6 + progress * 1.6; // grows over the year, same shape as ~10%/mo compounding
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const dow = date.getDay();
  const weekdayMult = dow === 0 || dow === 6 ? 0.35 : 1.2;
  const holidayDip = Math.random() < 0.04 ? 0.2 : 1; // occasional very quiet day
  const jitter = 0.6 + Math.random() * 0.8;
  return Math.max(0, Math.round(base * weekdayMult * holidayDip * jitter));
}

const MEET_SEG = () => Math.random().toString(36).slice(2, 6);
const fakeMeetLink = () => `https://meet.google.com/${MEET_SEG()}-${MEET_SEG()}-${MEET_SEG()}`;

async function seedSessions(matches) {
  const records = [];
  for (let daysAgo = 365; daysAgo >= 1; daysAgo--) {
    const count = sessionsCountForDay(daysAgo);
    for (let i = 0; i < count; i++) {
      const match = pick(matches);
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(randInt(9, 18), pick([0, 30]), 0, 0);
      const start = new Date(date);
      const end = new Date(start.getTime() + 60 * 60 * 1000);

      const statusRoll = Math.random();
      const status = statusRoll < 0.82 ? "completed" : statusRoll < 0.92 ? "cancelled" : "no_show";
      const bookedBy = Math.random() < 0.85 ? "booking-app" : "ops-manual";

      records.push({
        Label: `${start.toISOString().slice(0, 10)} ${match.fields.Label}`,
        Match: linkOne(match.id),
        Client: linkOne(match.clientId),
        Therapist: linkOne(match.therapistId),
        "Slot Start": start.toISOString(),
        "Slot End": end.toISOString(),
        "Meeting Link": fakeMeetLink(),
        Status: status,
        "Booked By": bookedBy,
        "Updated At": start.toISOString(),
      });
    }
  }
  console.log(`  generated ${records.length} session records across 365 days`);
  const created = await at.createBatch("Sessions", records, { typecast: true });
  console.log(`  created ${created.length} sessions`);
  return created;
}

const POSITIVE_COMMENTS = [
  "Really felt heard in this session.",
  "Practical tools I could use right away.",
  "Grateful for the space to process this.",
  "Session helped me see things differently.",
  "Appreciate the patience and structure.",
  "Left feeling lighter and more grounded.",
  "Great continuity from our last conversation.",
  "Helped me name what I was feeling.",
  "Felt safe to be honest about a hard week.",
  "Small breakthrough today, thank you.",
];
const NEUTRAL_COMMENTS = [
  "It was okay, still finding my footing with this approach.",
  "Session felt a bit rushed today.",
  "Would like more concrete homework next time.",
  "Still processing what came up today.",
];
const NEGATIVE_COMMENTS = [
  "Didn't feel like we covered much today.",
  "Session started late, threw off the flow.",
  "Not sure this approach is working for me.",
  "Felt disconnected during today's session.",
];

function weightedRating() {
  const roll = Math.random();
  if (roll < 0.03) return 1;
  if (roll < 0.1) return 2;
  if (roll < 0.25) return 3;
  if (roll < 0.6) return 4;
  return 5;
}

async function seedFeedback(sessions, count) {
  const completed = sessions.filter((s) => s.fields.Status === "completed");
  const chosen = [];
  const usedIdx = new Set();
  while (chosen.length < Math.min(count, completed.length)) {
    const idx = randInt(0, completed.length - 1);
    if (usedIdx.has(idx)) continue;
    usedIdx.add(idx);
    chosen.push(completed[idx]);
  }

  const records = chosen.map((s) => {
    const rating = weightedRating();
    const pool = rating >= 4 ? POSITIVE_COMMENTS : rating === 3 ? NEUTRAL_COMMENTS : NEGATIVE_COMMENTS;
    const createdAt = new Date(new Date(s.fields["Slot End"]).getTime() + randInt(1, 48) * 3600 * 1000);
    return {
      Label: `Feedback — ${s.fields.Label}`,
      Session: linkOne(s.id),
      Client: s.fields.Client ? linkOne(s.fields.Client[0]) : [],
      Rating: rating,
      Comment: pick(pool),
      "Created At": createdAt.toISOString(),
    };
  });
  const created = await at.createBatch("Feedback", records, { typecast: true });
  console.log(`  created ${created.length} feedback records`);
  return created;
}

async function main() {
  console.log("Wiping existing demo data...");
  await wipe();

  console.log("\nSeeding real therapists...");
  const therapists = await seedTherapists();

  console.log("\nSeeding availability...");
  await seedAvailability(therapists);

  console.log("\nSeeding synthetic clients...");
  const clients = await seedClients(120);

  console.log("\nSeeding matches...");
  const matches = await seedMatches(clients, therapists);

  console.log("\nSeeding a year of sessions...");
  const sessions = await seedSessions(matches);

  console.log("\nSeeding feedback...");
  await seedFeedback(sessions, 100);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
