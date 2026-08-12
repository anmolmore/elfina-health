// Backfills profile fields on the therapists already seeded, and creates
// their Availability rows (weekly capacity, status, recurring open days and
// hours) in the new separate table.
import { airtableClient, linkOne } from "../shared/airtable.mjs";

const at = airtableClient();
const now = () => new Date().toISOString();

const profiles = {
  "Dr. Amara Osei": {
    Age: 38,
    "Years of Experience": 12,
    Education: "Ph.D. Clinical Psychology, M.A. Counseling Psychology",
    "Languages Spoken": ["English", "French"],
    Bio: "Amara works with adults navigating anxiety and high-functioning burnout, drawing on CBT with a practical, collaborative style.",
    availability: { weeklyCapacity: 20, status: "active", days: ["Monday", "Tuesday", "Wednesday", "Thursday"], start: "09:00", end: "17:00" },
  },
  "Dr. Priya Nair": {
    Age: 41,
    "Years of Experience": 15,
    Education: "Psy.D. Clinical Psychology, EMDR Certified",
    "Languages Spoken": ["English", "Hindi"],
    Bio: "Priya specializes in trauma-focused care using EMDR, working primarily with clients processing acute and complex trauma.",
    availability: { weeklyCapacity: 15, status: "active", days: ["Tuesday", "Wednesday", "Thursday", "Friday"], start: "10:00", end: "16:00" },
  },
  "Dr. Jonas Reyes": {
    Age: 34,
    "Years of Experience": 8,
    Education: "M.A. Marriage and Family Therapy",
    "Languages Spoken": ["English", "Spanish", "Portuguese"],
    Bio: "Jonas works with couples and families navigating conflict, transitions, and communication breakdowns.",
    availability: { weeklyCapacity: 18, status: "active", days: ["Monday", "Wednesday", "Friday"], start: "09:00", end: "17:00" },
  },
};

async function main() {
  const therapists = await at.list("Therapists");
  for (const t of therapists) {
    const profile = profiles[t.fields.Name];
    if (!profile) {
      console.log(`  (skip, no seed profile defined) ${t.fields.Name}`);
      continue;
    }
    const { availability, ...fields } = profile;
    await at.update("Therapists", t.id, { ...fields, "Updated At": now() });
    console.log(`  Updated profile: ${t.fields.Name}`);
    await new Promise((r) => setTimeout(r, 210));

    const existingAvailability = await at.list("Availability");
    const already = existingAvailability.find((a) => (a.fields.Therapist || []).includes(t.id));
    if (already) {
      console.log(`  (skip, availability already exists) ${t.fields.Name}`);
      continue;
    }
    await at.create("Availability", {
      Label: `${t.fields.Name} — ${availability.days.join("/")} ${availability.start}-${availability.end}`,
      Therapist: linkOne(t.id),
      "Weekly Capacity": availability.weeklyCapacity,
      Status: availability.status,
      "Available Days": availability.days,
      "Start Time": availability.start,
      "End Time": availability.end,
      "Updated At": now(),
    });
    console.log(`  Created availability: ${t.fields.Name}`);
    await new Promise((r) => setTimeout(r, 210));
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
