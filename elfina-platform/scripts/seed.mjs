import { airtableClient, linkOne } from "../shared/airtable.mjs";

const at = airtableClient();
const now = () => new Date().toISOString();

async function main() {
  console.log("Seeding live Airtable base with therapists, clients, and matches...");

  const therapists = [];
  for (const t of [
    { Name: "Dr. Amara Osei", Specialties: ["CBT", "Anxiety"], "Weekly Capacity": 20 },
    { Name: "Dr. Priya Nair", Specialties: ["Trauma", "EMDR"], "Weekly Capacity": 15 },
    { Name: "Dr. Jonas Reyes", Specialties: ["Couples", "Family"], "Weekly Capacity": 18 },
  ]) {
    const rec = await at.create("Therapists", {
      ...t,
      Email: t.Name.toLowerCase().replace(/[^a-z]+/g, ".") + "@elfinahealth.com",
      Status: "active",
      "Updated At": now(),
    });
    therapists.push(rec);
    console.log(`  Therapist: ${rec.fields.Name} (${rec.id})`);
    await new Promise((r) => setTimeout(r, 210)); // stay under 5 req/sec
  }

  const clients = [];
  for (const name of ["Jordan Smith", "Priya Patel", "Alex Chen"]) {
    const rec = await at.create("Clients", {
      Name: name,
      Email: name.toLowerCase().replace(/\s+/g, ".") + "@example.com",
      Phone: "+1555" + Math.floor(1000000 + Math.random() * 8999999),
      "Intake Notes": "Seeded for the real end-to-end demo.",
      Status: "matched",
      "Updated At": now(),
    });
    clients.push(rec);
    console.log(`  Client: ${rec.fields.Name} (${rec.id})`);
    await new Promise((r) => setTimeout(r, 210));
  }

  const matches = [];
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const t = therapists[i % therapists.length];
    const rec = await at.create("Matches", {
      Label: `${c.fields.Name} <-> ${t.fields.Name}`,
      Client: linkOne(c.id),
      Therapist: linkOne(t.id),
      Status: "accepted",
      "Updated At": now(),
    });
    matches.push(rec);
    console.log(`  Match: ${rec.fields.Label} (${rec.id})`);
    await new Promise((r) => setTimeout(r, 210));
  }

  console.log("\nSeed complete.");
  console.log(JSON.stringify({ therapists: therapists.map((t) => t.id), clients: clients.map((c) => c.id), matches: matches.map((m) => m.id) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
