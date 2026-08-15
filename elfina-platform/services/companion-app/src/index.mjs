import express from "express";
import { linkOne } from "../../../shared/airtable.mjs";
import { createStore } from "../../../shared/store.mjs";

const at = createStore();
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// NeetoCal is a separately hosted scheduling page -- this is the one
// bookable link for now (single host), not per-therapist. Override per
// environment; the value below is Elfina's real link.
const NEETOCAL_BOOKING_URL =
  process.env.NEETOCAL_BOOKING_URL || "https://elfina-health-anmol.neetocal.com/meeting-with-anmol-more";

function page(title, body) {
  return `<!doctype html><html><head><title>${title} — Elfina Health</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:3rem auto;padding:0 1.5rem;color:#1a1a2e;background:#fafafa}
    h1{font-size:1.4rem} label{display:block;margin-top:1rem;font-weight:600;font-size:.9rem}
    input,textarea{width:100%;padding:.6rem;margin-top:.3rem;border:1px solid #ccc;border-radius:6px;font:inherit;box-sizing:border-box}
    button{margin-top:1.5rem;padding:.7rem 1.4rem;border:none;border-radius:6px;background:#2f6f4f;color:white;font-weight:600;cursor:pointer}
    .card{background:white;border:1px solid #e5e5e5;border-radius:10px;padding:1.2rem;margin-top:1rem}
    .muted{color:#777;font-size:.85rem} a{color:#2f6f4f}
    .status{display:inline-block;padding:.15rem .6rem;border-radius:999px;background:#eef5f0;font-size:.75rem;font-weight:600}
  </style></head><body>${body}</body></html>`;
}

app.get("/", (_req, res) => {
  res.send(
    page(
      "Companion App",
      `<h1>Elfina Health — Companion App</h1>
       <p class="muted">Client-facing intake. Writes directly to the live Airtable base.</p>
       <div class="card">
         <form method="post" action="/intake">
           <label>Name<input name="name" required></label>
           <label>Email<input name="email" type="email" required></label>
           <label>Phone<input name="phone"></label>
           <label>What brings you here?<textarea name="intakeNotes" rows="3"></textarea></label>
           <button type="submit">Submit intake</button>
         </form>
       </div>`
    )
  );
});

app.post("/intake", async (req, res) => {
  const { name, email, phone, intakeNotes } = req.body;
  const rec = await at.create("Clients", {
    Name: name,
    Email: email,
    Phone: phone || "",
    "Intake Notes": intakeNotes || "",
    Status: "intake",
    "Updated At": new Date().toISOString(),
  });
  res.redirect(`/clients/${rec.id}`);
});

app.get("/clients/:id", async (req, res) => {
  let client;
  try {
    client = await at.get("Clients", req.params.id);
  } catch {
    return res.status(404).send(page("Not found", "<p>No client with that id.</p>"));
  }
  // Airtable's filterByFormula can't search linked-record fields by id --
  // ARRAYJOIN() on a link field yields the linked record's display name, not
  // its id. At this table size, fetching all Sessions and filtering in code
  // is simpler and correct; it stops being fine well before 3x volume, which
  // is exactly the kind of thing worth calling out in the memo.
  const allSessions = await at.list("Sessions");
  const sessions = allSessions
    .filter((s) => (s.fields.Client || []).includes(req.params.id))
    .sort((a, b) => (a.fields["Slot Start"] || "").localeCompare(b.fields["Slot Start"] || ""));

  res.send(
    page(
      client.fields.Name,
      `<h1>${client.fields.Name}</h1>
       <p><span class="status">${client.fields.Status}</span></p>
       <div class="card">
         <p><strong>Email:</strong> ${client.fields.Email}</p>
         <p><strong>Phone:</strong> ${client.fields.Phone || "—"}</p>
         <p class="muted">Client ID: ${client.id} — bookmark this URL, there's no login yet.</p>
       </div>
       <p><a href="/clients/${client.id}/book">Book a session via NeetoCal →</a></p>
       <h2>Sessions</h2>
       ${
         sessions.length === 0
           ? `<p class="muted">No sessions yet.</p>`
           : sessions
               .map(
                 (s) => `<div class="card">
                   <p><strong>${new Date(s.fields["Slot Start"]).toLocaleString()}</strong>
                      <span class="status">${s.fields.Status}</span></p>
                   ${s.fields["Meeting Link"] ? `<p><a href="${s.fields["Meeting Link"]}">${s.fields["Meeting Link"]}</a></p>` : ""}
                 </div>`
               )
               .join("")
       }
       <p class="muted"><a href="/">← Back to intake</a></p>`
    )
  );
});

// Embeds NeetoCal's iframe (their documented "Iframe" embed option --
// chosen over their JS widget/script because the iframe contract is just a
// URL, nothing to guess about an SDK global). Prefills name/email as query
// params, which is the common convention for these booking tools; NeetoCal
// ignores params it doesn't recognize, so this degrades safely if wrong.
//
// NeetoCal posts window "message" events on booking actions (confirmed by
// their docs -- exact event name/payload isn't published, so this listens
// broadly for anything from the NeetoCal origin and forwards the raw
// payload to the server, which extracts what it can and *always* records
// the raw payload for manual reconciliation. This is the part of the
// integration to verify against a real booking before trusting it blindly.
app.get("/clients/:id/book", async (req, res) => {
  let client;
  try {
    client = await at.get("Clients", req.params.id);
  } catch {
    return res.status(404).send(page("Not found", "<p>No client with that id.</p>"));
  }

  const embedUrl = new URL(NEETOCAL_BOOKING_URL);
  embedUrl.searchParams.set("embed", "true");
  if (client.fields.Name) embedUrl.searchParams.set("name", client.fields.Name);
  if (client.fields.Email) embedUrl.searchParams.set("email", client.fields.Email);

  res.send(
    page(
      `Book — ${client.fields.Name}`,
      `<h1>Find the right therapist – in the first go</h1>
       <ul class="muted" style="list-style:none;padding:0;margin:1rem 0">
         <li style="margin-bottom:.5rem">✓ A 30-min guided call with a therapy expert</li>
         <li style="margin-bottom:.5rem">✓ Structured questions to understand your needs</li>
         <li style="margin-bottom:.5rem">✓ No pressure to start – just guidance</li>
       </ul>
       <p style="font-weight:600">Book an assessment call for INR 99</p>
       <div class="card" style="padding:0;overflow:hidden">
         <iframe id="neetocal-frame" src="${embedUrl.toString()}" width="100%" height="700" frameborder="0" style="display:block"></iframe>
       </div>
       <div id="confirm-status" class="muted" style="margin-top:1rem"></div>
       <p class="muted"><a href="/clients/${client.id}">← Back to profile</a></p>
       <script>
         const clientId = ${JSON.stringify(client.id)};
         const statusEl = document.getElementById("confirm-status");
         const neetocalOrigin = new URL(${JSON.stringify(NEETOCAL_BOOKING_URL)}).origin;

         async function reportBooking(payload) {
           statusEl.textContent = "Saving your booking...";
           try {
             const resp = await fetch(\`/clients/\${clientId}/book/confirm\`, {
               method: "POST",
               headers: { "content-type": "application/json" },
               body: JSON.stringify(payload),
             });
             if (!resp.ok) throw new Error(await resp.text());
             statusEl.textContent = "Booked and saved to your profile.";
           } catch (err) {
             console.error("[neetocal] failed to save booking", err);
             statusEl.innerHTML = "Booking may have succeeded on NeetoCal, but saving it here failed. " +
               "Please tell ops your booking time so they can add it manually.";
           }
         }

         window.addEventListener("message", (event) => {
           if (event.origin !== neetocalOrigin) return;
           console.log("[neetocal] message event", event.data);
           const data = event.data || {};
           const type = String(data.type || data.event || "").toLowerCase();
           if (!type.includes("book")) return; // ignore resize/height/other embed chatter
           reportBooking(data);
         });
       </script>`
    )
  );
});

app.post("/clients/:id/book/confirm", async (req, res) => {
  const clientId = req.params.id;
  const payload = req.body || {};

  // Best-effort extraction across the field-name variants these embeds
  // commonly use (Calendly/Cal.com-style). Unverified against a real
  // NeetoCal payload -- the raw payload is always stored in Intake Notes
  // so nothing is lost if none of these match.
  const dig = (...paths) => {
    for (const path of paths) {
      const value = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), payload);
      if (value != null && value !== "") return value;
    }
    return null;
  };
  const slotStart = dig("startTime", "start_time", "payload.startTime", "payload.start_time", "data.startTime");
  const slotEnd = dig("endTime", "end_time", "payload.endTime", "payload.end_time", "data.endTime");
  const meetingLink = dig("meetingLink", "meeting_link", "location", "payload.location", "joinUrl", "join_url");

  try {
    const client = await at.get("Clients", clientId);
    const session = await at.create(
      "Sessions",
      {
        Label: `${client.fields.Name} — booked via NeetoCal`,
        Client: linkOne(clientId),
        ...(slotStart ? { "Slot Start": slotStart } : {}),
        ...(slotEnd ? { "Slot End": slotEnd } : {}),
        ...(meetingLink ? { "Meeting Link": meetingLink } : {}),
        Status: "scheduled",
        "Booked By": "neetocal",
        "Updated At": new Date().toISOString(),
      },
      { typecast: true } // lets "Booked By" pick up "neetocal" as a new select option
    );
    // Raw payload always kept, in case the field-name guesses above missed
    // something -- ops can reconcile Slot Start/End by hand from this.
    const notes = client.fields["Intake Notes"] || "";
    await at.update("Clients", clientId, {
      "Intake Notes": `${notes}${notes ? "\n\n" : ""}[NeetoCal raw payload, ${new Date().toISOString()}]\n${JSON.stringify(payload)}`,
    });
    res.json({ ok: true, sessionId: session.id });
  } catch (err) {
    console.error("[neetocal] failed to write session", err);
    res.status(500).send("Failed to save booking");
  }
});

const PORT = process.env.PORT || 4003;
app.listen(PORT, () => {
  console.log(`[companion-app] listening on :${PORT}, base ${process.env.AIRTABLE_BASE_ID}`);
});
