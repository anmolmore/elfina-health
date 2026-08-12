import express from "express";
import { airtableClient } from "../../../shared/airtable.mjs";

const at = airtableClient();
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

const PORT = process.env.PORT || 4003;
app.listen(PORT, () => {
  console.log(`[companion-app] listening on :${PORT}, base ${process.env.AIRTABLE_BASE_ID}`);
});
