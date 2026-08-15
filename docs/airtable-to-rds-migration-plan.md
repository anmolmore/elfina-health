# Airtable → RDS Postgres — Migration Plan

Tactical companion to `migration-strategy.md` (strategic case + sequencing).
This is the "how," grounded in the actual code in `elfina-platform/`.

## Architecture: earlier vs. now

**Earlier** — no shared data-access layer. `companion-app` and `booking-app`
each called `shared/airtable.mjs` directly for every read and write.
Airtable was the only store, with no schema constraints, no audit trail,
and no coordination between the two write paths (see "Current state" below
for the specific gaps this caused).

**Now** — both services import `shared/store.mjs` instead of
`shared/airtable.mjs` directly (Phase 2, "seam refactor," is done). RDS
Postgres exists alongside Airtable with the full target schema applied
(`scripts/rds-schema.sql` via `scripts/apply-schema.mjs`, matching section 1
below), and historical data has been backfilled into it
(`scripts/backfill-rds.mjs`, idempotent upsert by `airtable_id`). The store
seam runs in one of two modes via `STORE_MODE`:

- `airtable` (default) — pure passthrough to `shared/airtable.mjs`. No
  Postgres involved. This is still what production runs today.
- `dual` — Airtable write happens first and is what the caller waits on
  and what the response depends on; a mirror write to Postgres
  (`shared/store-postgres.mjs`) is then fired and its failure only logged,
  never thrown or surfaced to the user. Reads still always go to Airtable
  in both modes — nothing reads from Postgres yet.

In short: Phases 1–3 (schema, seam refactor, backfill) are built. Phase 4
(dual-write) is implemented and gated behind `STORE_MODE=dual`, not yet the
default — turning it on for real traffic, then running Phase 5's drift
check, are the next steps before any read traffic or cutover happens.

## 0. Current state (updated)

- No backend service yet. Three write paths hit Airtable directly, not one:
  `companion-app` (intake, and now NeetoCal-booked sessions via
  `/clients/:id/book/confirm`), `booking-app` (its own slot picker), and
  ops editing the Airtable UI by hand. Adding the NeetoCal path made this
  worse, not better — one more uncoordinated writer.
- 6 tables (`scripts/create-base.mjs`,
  `scripts/add-profile-and-availability.mjs`): **Clients, Therapists,
  Matches, Sessions, Feedback, Availability**. Linked-record fields carry
  the relations.
- `shared/airtable.mjs` is the only shared code — a thin REST client. Its
  `list()` used to silently truncate at Airtable's 100-record page cap
  (fixed today); that bug was masking real data for any table past 100
  rows, including exactly the kind of check ("is this slot already
  booked?") that matters for compliance and correctness both.
- No auth, no audit trail, no uniqueness constraint on (therapist, slot) —
  booking safety is an in-process JS lock only, and now two separate
  processes (companion-app, booking-app) can both write a Session for the
  same slot with no coordination between them at all.
- Airtable record ids (`recXXXXXXXXXXXXXX`) are the de facto primary keys
  everywhere, including in URLs.

This changes the plan's framing slightly from the first pass: the
NeetoCal integration is a second demonstration that *every* new feature
built directly against Airtable adds another writer to coordinate later.
Reinforces the stance in `migration-strategy.md` — start the RDS migration
now, not after more surface area gets built on the old system.

## 1. Target schema (Postgres)

One-to-one mapping from the 6 Airtable tables, normalized, with real
constraints Airtable can't express, plus an append-only audit log.

```sql
create extension if not exists pgcrypto;
create extension if not exists citext;

create table clients (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,               -- backfill/reconciliation key, dropped after cutover
  name text not null,
  email citext not null,
  phone text,
  intake_notes text,
  status text not null check (status in ('intake','matched','active','paused','discharged')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table therapists (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  name text not null,
  email citext not null,
  age int,
  years_of_experience int,
  education text,
  bio text,
  specialties text[] not null default '{}',
  languages_spoken text[] not null default '{}',
  status text not null check (status in ('active','on_leave','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table availability (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  therapist_id uuid not null references therapists(id),
  weekly_capacity int not null,
  status text not null check (status in ('active','on_leave','inactive')),
  available_days smallint[] not null,   -- 0=Sunday..6=Saturday
  start_time time not null,
  end_time time not null,
  updated_at timestamptz not null default now(),
  unique (therapist_id)                 -- one active schedule per therapist, matches booking-app's own assumption
);

create table matches (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  client_id uuid not null references clients(id),
  therapist_id uuid not null references therapists(id),
  status text not null check (status in ('proposed','accepted','declined','ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, therapist_id)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  match_id uuid references matches(id),   -- nullable: NeetoCal-booked sessions don't create a Match today
  client_id uuid not null references clients(id),
  therapist_id uuid references therapists(id), -- nullable for the same reason
  slot_start timestamptz,
  slot_end timestamptz,
  meeting_link text,
  status text not null check (status in ('scheduled','completed','cancelled','no_show')),
  booked_by text not null,                -- 'booking-app' | 'ops-manual' | 'neetocal' (open text now, not enum — new booking sources keep appearing)
  raw_source_payload jsonb,               -- carries forward the "unverified NeetoCal payload" reconciliation trick from companion-app
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- the actual fix for the double-booking gap in migration-strategy.md section 1,
-- and now closes the *second* gap: booking-app and the NeetoCal path in
-- companion-app can no longer both take the same therapist/slot either.
create unique index sessions_therapist_slot_uq
  on sessions (therapist_id, slot_start)
  where status <> 'cancelled' and therapist_id is not null and slot_start is not null;

create table feedback (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  session_id uuid not null references sessions(id),
  client_id uuid not null references clients(id),
  rating int check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

-- DPDP: who touched what, when, why (migration-strategy.md section 7). Append-only.
create table audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor text not null,        -- 'client:<uuid>' | 'therapist:<uuid>' | 'ops:<email>' | 'system:<service>'
  action text not null,       -- 'create' | 'update' | 'read'
  entity_table text not null,
  entity_id uuid not null,
  reason text,                -- e.g. "booking-app slot booking", "neetocal webhook", "ops manual correction"
  diff jsonb
);
create index audit_log_entity_idx on audit_log (entity_table, entity_id, occurred_at desc);
```

Schema changes vs. the first draft of this plan: `sessions.match_id` and
`sessions.therapist_id` are now nullable, and `booked_by` is free text, not
a checked enum. Both are direct consequences of the NeetoCal path — it
writes a Session without going through the Matches table and without a
resolved Therapist record. Rather than force every new booking source to
fake a Match/Therapist to satisfy a constraint, the schema admits that
"who this session is with" isn't always known at write time yet.
`raw_source_payload` generalizes the "store the raw payload so nothing is
lost" pattern from `companion-app`'s NeetoCal handler into a real column
instead of a workaround (appending JSON into `Intake Notes` was never
meant to be permanent).

## 2. Data access layer — the real prerequisite (done)

Today three places write Airtable independently: `companion-app`'s
`/intake` and `/clients/:id/book/confirm`, and `booking-app`'s `/book`.
Dual-write is only tractable with one seam to write through.

`shared/store.mjs` now exists and both services' `src/index.mjs` import it
in place of `shared/airtable.mjs` directly. Its `list`/`get` are pure
Airtable passthrough (unchanged behavior); `create`/`update` add the
`STORE_MODE=dual` mirror-write branch described above. `shared/store.mjs`
kept the existing `list/get/create/update` shape of `shared/airtable.mjs`
rather than growing table-specific methods (`clients.create`,
`sessions.createFromBooking`, etc.) — call sites needed no changes beyond
the import swap, which is what made this a genuinely zero-behavior-change
refactor.

## 3. Phased rollout

**Phase 1 — Schema + audit log. Done.** `scripts/rds-schema.sql` (applied
via `scripts/apply-schema.mjs`, idempotent `create table if not exists`)
matches the DDL in section 1. Airtable remains sole source of truth — RDS
has the schema and the backfilled rows but nothing reads from or depends
on it yet.

**Phase 2 — Seam refactor. Done.** `shared/store.mjs`, covering all three
current write paths, as above.

**Phase 3 — Backfill. Done.** `scripts/backfill-rds.mjs`, idempotent
upsert-by-`airtable_id`, same style as `scripts/create-base.mjs`. Order:
Clients, Therapists → Availability, Matches → Sessions → Feedback.

**Phase 4 — Dual-write. Implemented, not yet the default.** `store.mjs`
writes Airtable (authoritative, blocking) + Postgres
(`shared/store-postgres.mjs`, best-effort, logged on failure, never blocks
the response) when `STORE_MODE=dual`. Production still runs the default
`airtable` mode. Next step: flip `STORE_MODE=dual` on and run it a few
days under real traffic — including real NeetoCal bookings, which is the
one write path with genuinely unverified shape right now.

**Phase 5 — Shadow-read / drift check. Not started.** Scheduled diff of Postgres vs.
Airtable per table via `airtable_id`. Cutover gate: flat drift for 48h,
not a calendar date (migration-strategy.md section 5).

**Phase 6 — Cutover, table by table, Sessions first** (migration-strategy.md section 4):
1. Sessions + Availability (booking-app depends on Availability directly).
   `sessions_therapist_slot_uq` now does the double-booking protection for
   real, across all three writers — the in-process `withLock` in
   `booking-app` becomes a perf optimization, not the only defense.
2. Clients, Therapists, Matches.
3. Feedback.
4. Full incident-free week on dual-write → stop writing Airtable, mark it
   read-only mirror.

**Phase 7 — Retire Airtable + WhaleSync.** Drop `airtable_id` columns in a
follow-up migration.

**Phase 8 — Companion App off Replit**, once it's a thin API client.

## 4. Rollback

Reversible through Phase 6 steps 1–3 by flipping `store.mjs`'s read source
back to Airtable — Airtable still gets every write until 6.4. After 6.4,
rollback means replaying the dual-write failure log back into Airtable,
which is exactly why Phase 5 has to show zero unexplained drift first. No
Friday cutovers (migration-strategy.md section 5).

## 5. Failure modes this closes

1. Double-booked slots, now across *all* current and future booking
   sources → `sessions_therapist_slot_uq`.
2. Old/new path drift during dual-write → Phase 5, continuous, alerted.
3. A booking source with an unverified payload shape (NeetoCal today,
   probably not the last one) silently losing data → `raw_source_payload`
   makes "store the raw thing, reconcile later" the norm instead of an
   ad hoc fix bolted onto one endpoint.

## 6. What this doesn't include (see migration-strategy.md section 8)

No ORM opinion — plain `pg` + hand-written migrations fits a 2-engineer
team the same way `shared/airtable.mjs` being hand-rolled did. No
field-level encryption yet (no clinical-content fields exist yet — Sessions/
Feedback have no free-text clinical field beyond `Feedback.comment`,
`Comment`). No ABDM integration. Same stance throughout: build the
constraint-bearing pieces (schema, audit log, uniqueness) now, defer
everything without a concrete trigger.
