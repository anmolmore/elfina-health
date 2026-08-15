# Platform (Companion App + Booking App)

Two real Node/Express services that read and write a live Airtable base
directly — no mocks. Built to mirror the actual production architecture:
Companion App (client-facing) and a separate Booking App, both treating
Airtable as the system of record.

WhaleSync is deliberately **not** wired in yet — both services talk to the
Airtable REST API directly (which is what WhaleSync would proxy anyway).
Adding WhaleSync means picking a sync target in their UI and is a follow-up
once the core loop is proven.

## Services

- `services/companion-app` — client intake form, client profile + session
  view. Port `4003` locally, `$PORT` on Replit.
- `services/booking-app` — therapist list, generated weekly availability
  (checked against real booked Sessions), booking, fake Google Meet links.
  Port `4004` locally, `$PORT` on Replit.
- `shared/airtable.mjs` — thin REST client for the real Airtable API used by
  both services.

## Data model

Real Airtable base, 5 tables with proper linked-record fields: Clients,
Therapists, Matches (Client↔Therapist), Sessions (Match/Client/Therapist),
Feedback (Session/Client). Created via `scripts/create-base.mjs`.

**Known Airtable gotcha**: `filterByFormula` can't search a linked-record
field by record id — `ARRAYJOIN({LinkField})` returns the linked record's
*display name*, not its id, so `SEARCH(id, ARRAYJOIN(...))` silently never
matches. Both services fetch and filter in application code instead. That's
fine at this table size and stops being fine well before 3x volume — worth
tracking as a real constraint, not just a mock one (see `migration-strategy.md`).

## NeetoCal booking (companion-app)

`services/companion-app` has a second, NeetoCal-backed booking path
alongside the booking-app's own slot picker: `/clients/:id/book` embeds
NeetoCal's scheduling page in an iframe (prefilled with the client's
name/email), listens for the `message` event NeetoCal's embed posts on
booking, and writes the resulting Session to Airtable client-side →
`POST /clients/:id/book/confirm`.

The exact NeetoCal postMessage payload shape isn't published, so the
handler extracts common field-name variants defensively and **always**
appends the raw payload to the client's Intake Notes — if the extraction
guesses are wrong, the slot/time is still recoverable by hand from there.
Verify against a real NeetoCal booking before relying on the extracted
Slot Start/End.

Set `NEETOCAL_BOOKING_URL` to override the default scheduling link
(`https://elfina-health-anmol.neetocal.com/meeting-with-anmol-more`).

## Running locally

Requires `.env` (gitignored) with:
```
AIRTABLE_PAT=pat...
AIRTABLE_BASE_ID=app...
NEETOCAL_BOOKING_URL=https://...   # optional, has a default
```

```
npm install
npm run seed   # populates Therapists/Clients/Matches
npm run dev    # both services, :4003 and :4004
```

Walk the loop: open `http://localhost:4003`, submit an intake, note the
client id from the URL; open `http://localhost:4004`, pick a therapist,
paste the client id, book a slot; reload the companion-app client page to
see the session appear.

## Deploying to Replit

1. Import this GitHub repo into two Repls (one per service), or one Repl
   running both via a process manager — start with two, since that's the
   real target architecture.
2. Set Repl **Secrets** (not `.env` — don't commit real credentials):
   `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`.
3. Run command per service: `npm start --workspace=companion-app` /
   `npm start --workspace=booking-app` (or `cd services/<name> && npm start`
   if the Repl root is the service directory itself).
4. Replit injects `$PORT`; both services already read it.

## What's deliberately not built yet

- No auth — client/booking pages are unauthenticated links, matching "ship
  fast" but explicitly a known gap (see `migration-strategy.md`).
- No real Google Calendar/Meet integration — links are generated strings.
- No real WhatsApp/email sending.
- Booking safety is a single-process in-memory lock, not a real constraint
  at the data layer (Airtable has none) — fine for one Repl, not for two.
