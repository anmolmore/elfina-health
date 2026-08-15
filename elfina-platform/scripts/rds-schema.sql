-- Target schema for the Airtable -> RDS migration.
-- Verbatim from docs/airtable-to-rds-migration-plan.md section 1.
-- Applied via scripts/apply-schema.mjs, idempotent (create if not exists).

create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists clients (
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

create table if not exists therapists (
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

create table if not exists availability (
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

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  client_id uuid not null references clients(id),
  therapist_id uuid not null references therapists(id),
  status text not null check (status in ('proposed','accepted','declined','ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, therapist_id)
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  match_id uuid references matches(id),   -- nullable: NeetoCal-booked sessions don't create a Match today
  client_id uuid not null references clients(id),
  therapist_id uuid references therapists(id), -- nullable for the same reason
  slot_start timestamptz,
  slot_end timestamptz,
  meeting_link text,
  status text not null check (status in ('scheduled','completed','cancelled','no_show')),
  booked_by text not null,                -- 'booking-app' | 'ops-manual' | 'neetocal' (open text now, not enum -- new booking sources keep appearing)
  raw_source_payload jsonb,               -- carries forward the "unverified NeetoCal payload" reconciliation trick from companion-app
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- the actual fix for the double-booking gap in migration-memo.md section 1,
-- and closes the second gap: booking-app and the NeetoCal path in
-- companion-app can no longer both take the same therapist/slot either.
create unique index if not exists sessions_therapist_slot_uq
  on sessions (therapist_id, slot_start)
  where status <> 'cancelled' and therapist_id is not null and slot_start is not null;

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  session_id uuid not null references sessions(id),
  client_id uuid not null references clients(id),
  rating int check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

-- DPDP: who touched what, when, why (migration-memo.md section 7). Append-only.
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor text not null,        -- 'client:<uuid>' | 'therapist:<uuid>' | 'ops:<email>' | 'system:<service>'
  action text not null,       -- 'create' | 'update' | 'read'
  entity_table text not null,
  entity_id uuid not null,
  reason text,                -- e.g. "booking-app slot booking", "neetocal webhook", "ops manual correction"
  diff jsonb
);
create index if not exists audit_log_entity_idx on audit_log (entity_table, entity_id, occurred_at desc);
