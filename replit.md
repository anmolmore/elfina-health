# Replit Demo

Two Node.js/Express services backed by a live Airtable base.

## Services

| Service | Port | Purpose |
|---------|------|---------|
| **Companion App** | 5000 (preview) | Client intake form + session view |
| **Booking App** | 3000 | Therapist list + slot booking |

Both services are in `elfina-platform/services/`. They share `elfina-platform/shared/airtable.mjs`.

## Running

Two workflows are configured:
- **Companion App** — visible in the preview pane (port 5000)
- **Booking App** — accessible at the dev domain on port 3000

To walk the full loop:
1. Open Companion App → submit an intake → copy the client ID from the URL (`/clients/<id>`)
2. Switch preview to Booking App (port 3000) → pick a therapist → paste client ID → book a slot
3. Reload the Companion App client page to see the session appear

## Required Secrets

- `AIRTABLE_PAT` — Airtable Personal Access Token (`pat...`)
- `AIRTABLE_BASE_ID` — Airtable base ID (`app...`)

Set these as Replit Secrets (not in `.env`). Both services read them from `process.env`.

## Seeding

To populate Therapists, Clients, and Matches from scratch:

```
cd elfina-platform && AIRTABLE_PAT=<pat> AIRTABLE_BASE_ID=<base> node scripts/seed.mjs
```

Or create the full schema first: `node scripts/create-base.mjs`

## Architecture Notes

- No auth — client pages are unauthenticated links
- Booking safety is an in-process mutex (single-process only)
- `filterByFormula` can't search linked-record fields by ID — both services fetch all records and filter in application code
- WhaleSync not wired in; both services use the Airtable REST API directly

## User Preferences

- Run both services as separate workflows on separate ports
