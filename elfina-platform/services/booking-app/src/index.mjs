import express from "express";
import { airtableClient, linkOne } from "../../../shared/airtable.mjs";

// See companion-app/src/index.mjs for why: Airtable's filterByFormula can't
// search linked-record fields by id, so we fetch and filter in code.

const at = airtableClient();
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serializes booking attempts for the same (therapist, slot) within this one
// process. Real protection against concurrent double-booking needs a unique
// constraint at the data layer (Airtable has none) -- this in-process lock
// only holds as long as there's exactly one process, which is itself one of
// the things worth flagging about a single-instance Booking App at 3x load.
const locks = new Map();
async function withLock(key, fn) {
  while (locks.get(key)) await locks.get(key);
  let release;
  locks.set(key, new Promise((r) => (release = r)));
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function getAvailability(therapistId) {
  const all = await at.list("Availability");
  return all.find((a) => (a.fields.Therapist || []).includes(therapistId));
}

// Expands a therapist's recurring weekly availability (from the Availability
// table -- separate from their Therapists profile row) into concrete hourly
// slots over the next 14 days.
function generateSlots(therapistId, availability) {
  const days = new Set(availability.fields["Available Days"] || []);
  const [startHour] = (availability.fields["Start Time"] || "09:00").split(":").map(Number);
  const [endHour] = (availability.fields["End Time"] || "17:00").split(":").map(Number);
  const slots = [];
  const today = new Date();
  for (let day = 1; day <= 14; day++) {
    const date = new Date(today);
    date.setDate(date.getDate() + day);
    if (!days.has(DAY_NAMES[date.getDay()])) continue;
    for (let hour = startHour; hour < endHour; hour++) {
      const start = new Date(date);
      start.setHours(hour, 0, 0, 0);
      const end = new Date(start);
      end.setHours(hour + 1, 0, 0, 0);
      slots.push({ therapistId, slotStart: start.toISOString(), slotEnd: end.toISOString() });
    }
  }
  return slots;
}

function weekBounds(isoDate) {
  const d = new Date(isoDate);
  const day = d.getDay();
  const diffToMonday = (day + 6) % 7;
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - diffToMonday);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

function fakeMeetLink() {
  const seg = () => Math.random().toString(36).slice(2, 6);
  return `https://meet.google.com/${seg()}-${seg()}-${seg()}`;
}

function page(title, body) {
  return `<!doctype html><html><head><title>${title} — Booking</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:3rem auto;padding:0 1.5rem;color:#1a1a2e;background:#fafafa}
    h1{font-size:1.4rem} .card{background:white;border:1px solid #e5e5e5;border-radius:10px;padding:1.2rem;margin-top:1rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.6rem;margin-top:.8rem}
    .slot{border:1px solid #ccc;border-radius:6px;padding:.5rem;text-align:center;font-size:.85rem}
    .slot form{margin:0} button{width:100%;padding:.4rem;border:none;border-radius:5px;background:#2f6f4f;color:white;cursor:pointer;font:inherit}
    input{padding:.4rem;border:1px solid #ccc;border-radius:5px;font:inherit} .muted{color:#777;font-size:.85rem}
    a{color:#2f6f4f}
  </style></head><body>${body}</body></html>`;
}

app.get("/", async (_req, res) => {
  const [therapists, availabilityRows] = await Promise.all([at.list("Therapists"), at.list("Availability")]);
  const activeAvailabilityByTherapist = new Map(
    availabilityRows.filter((a) => a.fields.Status === "active").map((a) => [(a.fields.Therapist || [])[0], a])
  );
  const bookable = therapists.filter((t) => activeAvailabilityByTherapist.has(t.id));

  res.send(
    page(
      "Book a session",
      `<h1>Book a session</h1>
       <p class="muted">Availability generated from each therapist's real weekly schedule, minus what's already booked in Airtable.</p>
       ${bookable
         .map((t) => {
           const a = activeAvailabilityByTherapist.get(t.id);
           return `<div class="card"><strong>${t.fields.Name}</strong>
             <p class="muted">${(t.fields.Specialties || []).join(", ")}${t.fields["Years of Experience"] ? ` · ${t.fields["Years of Experience"]} yrs experience` : ""}</p>
             <p class="muted">${(a.fields["Available Days"] || []).join("/")} ${a.fields["Start Time"]}-${a.fields["End Time"]} · capacity ${a.fields["Weekly Capacity"]}/wk</p>
             <a href="/therapists/${t.id}">View availability →</a></div>`;
         })
         .join("") || `<p class="muted">No therapists have active availability configured.</p>`}`
    )
  );
});

app.get("/therapists/:id", async (req, res) => {
  const therapist = await at.get("Therapists", req.params.id);
  const availability = await getAvailability(req.params.id);
  if (!availability || availability.fields.Status !== "active") {
    return res.send(page(therapist.fields.Name, `<h1>${therapist.fields.Name}</h1><p class="muted">No active availability configured for this therapist.</p>`));
  }
  const candidateSlots = generateSlots(req.params.id, availability);
  const allSessions = await at.list("Sessions");
  const booked = allSessions.filter(
    (s) => (s.fields.Therapist || []).includes(req.params.id) && s.fields.Status !== "cancelled"
  );
  const bookedStarts = new Set(booked.map((s) => s.fields["Slot Start"]));
  const openSlots = candidateSlots.filter((s) => !bookedStarts.has(s.slotStart));

  res.send(
    page(
      therapist.fields.Name,
      `<h1>${therapist.fields.Name}</h1>
       <p class="muted">${therapist.fields.Bio || ""}</p>
       <p class="muted">Paste the Client ID from the Companion App (the URL after /clients/), then pick a slot.</p>
       <div class="card">
         <label>Client ID<br><input id="clientId" placeholder="recXXXXXXXXXXXXXX" style="width:100%"></label>
       </div>
       <div class="grid">
         ${openSlots
           .map(
             (s) => `<div class="slot">${new Date(s.slotStart).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric" })}
               <form onsubmit="this.clientId.value=document.getElementById('clientId').value; if(!this.clientId.value){alert('Enter a Client ID first');return false;}"
                     method="post" action="/book">
                 <input type="hidden" name="therapistId" value="${req.params.id}">
                 <input type="hidden" name="slotStart" value="${s.slotStart}">
                 <input type="hidden" name="slotEnd" value="${s.slotEnd}">
                 <input type="hidden" name="clientId">
                 <button type="submit">Book</button>
               </form></div>`
           )
           .join("")}
       </div>
       <p class="muted"><a href="/">← All therapists</a></p>`
    )
  );
});

app.post("/book", async (req, res) => {
  const { therapistId, clientId, slotStart, slotEnd } = req.body;
  if (!clientId) return res.status(400).send(page("Error", "<p>Missing Client ID.</p>"));

  const key = `${therapistId}|${slotStart}`;
  try {
    const session = await withLock(key, async () => {
      const allSessions = await at.list("Sessions");
      const existing = allSessions.filter(
        (s) =>
          (s.fields.Therapist || []).includes(therapistId) &&
          s.fields["Slot Start"] === slotStart &&
          s.fields.Status !== "cancelled"
      );
      if (existing.length > 0) throw new Error("SLOT_TAKEN");

      const availability = await getAvailability(therapistId);
      if (availability && typeof availability.fields["Weekly Capacity"] === "number") {
        const { start, end } = weekBounds(slotStart);
        const bookedThisWeek = allSessions.filter(
          (s) =>
            (s.fields.Therapist || []).includes(therapistId) &&
            s.fields.Status !== "cancelled" &&
            new Date(s.fields["Slot Start"]) >= start &&
            new Date(s.fields["Slot Start"]) < end
        ).length;
        if (bookedThisWeek >= availability.fields["Weekly Capacity"]) throw new Error("CAPACITY_REACHED");
      }

      const allMatches = await at.list("Matches");
      let match = allMatches.find(
        (m) => (m.fields.Client || []).includes(clientId) && (m.fields.Therapist || []).includes(therapistId)
      );
      if (!match) {
        const [client, therapist] = await Promise.all([at.get("Clients", clientId), at.get("Therapists", therapistId)]);
        match = await at.create("Matches", {
          Label: `${client.fields.Name} <-> ${therapist.fields.Name}`,
          Client: linkOne(clientId),
          Therapist: linkOne(therapistId),
          Status: "accepted",
          "Updated At": new Date().toISOString(),
        });
      }

      const meetingLink = fakeMeetLink();
      return at.create("Sessions", {
        Label: `${slotStart} — ${therapistId}`,
        Match: linkOne(match.id),
        Client: linkOne(clientId),
        Therapist: linkOne(therapistId),
        "Slot Start": slotStart,
        "Slot End": slotEnd,
        "Meeting Link": meetingLink,
        Status: "scheduled",
        "Booked By": "booking-app",
        "Updated At": new Date().toISOString(),
      });
    });

    res.send(
      page(
        "Booked",
        `<h1>Session booked</h1>
         <div class="card">
           <p><strong>${new Date(slotStart).toLocaleString()}</strong></p>
           <p><a href="${session.fields["Meeting Link"]}">${session.fields["Meeting Link"]}</a></p>
           <p class="muted">Session ID: ${session.id}</p>
         </div>
         <p><a href="/clients-redirect" onclick="return false" class="muted">View in Companion App: /clients/${clientId} (companion-app service)</a></p>
         <p class="muted"><a href="/">← Book another</a></p>`
      )
    );
  } catch (err) {
    if (err.message === "SLOT_TAKEN") {
      return res.status(409).send(page("Slot taken", `<p>That slot was just booked by someone else. <a href="/therapists/${therapistId}">Pick another</a>.</p>`));
    }
    if (err.message === "CAPACITY_REACHED") {
      return res.status(409).send(page("Capacity reached", `<p>This therapist is already at their weekly capacity for that week. <a href="/therapists/${therapistId}">Pick another week</a>.</p>`));
    }
    console.error("[booking-app] failed to book session", err);
    res.status(500).send(page("Error", "<p>Something went wrong while booking. Please try again.</p>"));
  }
});

const PORT = process.env.PORT || 4004;
app.listen(PORT, () => {
  console.log(`[booking-app] listening on :${PORT}, base ${process.env.AIRTABLE_BASE_ID}`);
});
