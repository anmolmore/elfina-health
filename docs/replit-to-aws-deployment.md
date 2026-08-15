# Replit → AWS App Runner — Deployment Migration

How `companion-app` and `booking-app` moved off Replit's autoscale deployment
onto AWS, and how to operate them there.

## Why App Runner

Both services are small stateless Express apps with no persistent local
state (all data lives in Airtable, per `migration-strategy.md` /
`airtable-to-rds-migration-plan.md`). That rules out anything needing a VPC,
load balancer, or orchestration to justify itself:

- **App Runner** — push a container, AWS handles the HTTPS endpoint,
  load balancing, and scaling. Closest match to what Replit's autoscale
  deployment was already doing. Chosen.
- ECS Fargate — more control (own VPC, task defs), but that control has no
  use yet with zero other services to network with. Worth revisiting once
  the RDS migration lands and a backend service needs to sit inside a VPC
  next to the database.
- Elastic Beanstalk — PaaS-y like App Runner but more legacy tooling for no
  extra benefit here.

This is a demo deployment on a **low budget** — every choice below optimizes
for "cheapest way to have a real, clickable HTTPS URL," not for production
scale.

## What exists in AWS (account `010221970625`, region `ap-south-1`)

| Resource | Name | Purpose |
|---|---|---|
| ECR repo | `elfina-companion-app` | Container image for companion-app |
| ECR repo | `elfina-booking-app` | Container image for booking-app |
| SSM Parameter (SecureString) | `/elfina/AIRTABLE_PAT` | Airtable token, injected at runtime |
| SSM Parameter (SecureString) | `/elfina/AIRTABLE_BASE_ID` | Airtable base ID, injected at runtime |
| IAM role | `AppRunnerECRAccessRole` | Lets App Runner pull images from ECR |
| IAM role | `AppRunnerElfinaInstanceRole` | Lets running containers read the two SSM params (`ssm:GetParameters` + `kms:Decrypt`, scoped to those two params and the `aws/ssm` key only) |
| App Runner service | `elfina-companion-app` | Runs the companion app, `0.25 vCPU / 0.5 GB` (smallest tier) |
| App Runner service | `elfina-booking-app` | Runs the booking app, `0.25 vCPU / 0.5 GB` (smallest tier) |

Neither service has auto-deploy-on-push enabled — a new image in ECR does
nothing until a deployment is explicitly triggered (see below).

## What changed in the repo

- `elfina-platform/services/companion-app/Dockerfile` and
  `.../booking-app/Dockerfile` — new. Build context is `elfina-platform/`
  (not the service subfolder) because both services import
  `shared/airtable.mjs` via a relative path (`../../../shared/airtable.mjs`),
  and the workspace `package.json`/lockfile live at that level too.
- `elfina-platform/.dockerignore` — excludes `node_modules`, `.env`, logs.
- Both services already read `PORT` from `process.env` (defaulting to
  4003/4004 locally); the Dockerfiles set `PORT=8080` and `EXPOSE 8080`
  because that's App Runner's expected container port.
- Nothing in application code changed. Airtable credentials still come from
  `process.env.AIRTABLE_PAT` / `AIRTABLE_BASE_ID` — only *where* those env
  vars come from changed (Replit Secrets → SSM SecureString params, wired in
  as App Runner runtime environment secrets, decrypted only inside the
  running container, never baked into the image).

## Redeploying after a code change

```bash
cd elfina-platform

# companion-app
docker build -f services/companion-app/Dockerfile -t elfina-companion-app:local .
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 010221970625.dkr.ecr.ap-south-1.amazonaws.com
docker tag elfina-companion-app:local 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-companion-app:latest
docker push 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-companion-app:latest
aws apprunner start-deployment --region ap-south-1 \
  --service-arn arn:aws:apprunner:ap-south-1:010221970625:service/elfina-companion-app/4ea7de82541e4c7e8757e5b468b0a75a

# booking-app — same pattern, swap the repo name and service ARN
docker build -f services/booking-app/Dockerfile -t elfina-booking-app:local .
docker tag elfina-booking-app:local 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-booking-app:latest
docker push 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-booking-app:latest
aws apprunner start-deployment --region ap-south-1 \
  --service-arn arn:aws:apprunner:ap-south-1:010221970625:service/elfina-booking-app/00b91e6a04d342fe9787ccb6d1f6ae59
```

## Cost control: pause between demos

App Runner has no true scale-to-zero — the smallest instance still bills
continuously while the service is running. For a demo used intermittently,
pause it between sessions instead:

```bash
# before/after a demo
aws apprunner pause-service --region ap-south-1 --service-arn <service-arn>
aws apprunner resume-service --region ap-south-1 --service-arn <service-arn>   # ~1 min to come back up
```

Paused services keep their config/image and cost ~$0 compute while paused.

## Live URLs

- Companion App: `https://nxpq75mzhp.ap-south-1.awsapprunner.com`
- Booking App: `https://jhj7bph4ar.ap-south-1.awsapprunner.com`

## Current state (as of the RDS migration work)

Both App Runner services are **paused** and the NAT Gateway has been
**deleted** to hold cost near-zero while nothing is being demoed (see "Cost:
current paused state" below). Bring them back with the two commands in
"Resuming for a demo".

## Airtable → RDS dual-write (`STORE_MODE`)

Following `airtable-to-rds-migration-plan.md`, both services now go through
`shared/store.mjs` instead of calling `shared/airtable.mjs` directly.
`store.mjs` exposes the exact same `list/get/create/update` shape, so this
was a "zero behavior change" swap — the only new thing is a switch:

- **`STORE_MODE=airtable`** (current default) — pure passthrough, no
  Postgres involved at all.
- **`STORE_MODE=dual`** — Airtable write happens first and is what the
  caller/response waits on; a best-effort mirror write to Postgres
  (`shared/store-postgres.mjs`) is then fired and its failure only logged
  (`[store] postgres mirror create/update failed for <table>/<id> <reason>`),
  never thrown. This was verified live: with `STORE_MODE=dual` and the RDS
  instance stopped, a real booking through the Booking App still returned
  200 and completed in Airtable, with only a logged
  `Connection terminated due to connection timeout` in CloudWatch.

Set via SSM `String` parameter `/elfina/STORE_MODE`, read by the App Runner
`RuntimeEnvironmentVariables`.

### What exists for RDS (all in `ap-south-1`, account `010221970625`)

| Resource | Name / Id | Notes |
|---|---|---|
| RDS instance | `elfina-rds` | `db.t4g.micro`, single-AZ, 20GB gp3, Postgres 17.9, **not publicly accessible**, encrypted. Currently **stopped**. |
| DB subnet group | `elfina-rds-subnet-group` | Default VPC's 3 subnets |
| Security group | `elfina-rds-sg` | Allows 5432 only from the App Runner VPC connector's SG (and a now-terminated bastion's SG, harmless leftover rule) |
| SSM Parameter (SecureString) | `/elfina/DATABASE_URL` | Postgres connection string |
| SSM Parameter (String) | `/elfina/STORE_MODE` | `dual` or `airtable` |
| App Runner VPC Connector | `elfina-vpc-connector` | Currently **detached** from both services (their `NetworkConfiguration.EgressConfiguration` is back to `DEFAULT`) |

Schema: `elfina-platform/scripts/rds-schema.sql` (applied via
`scripts/apply-schema.mjs`). Backfill: `elfina-platform/scripts/backfill-rds.mjs`,
idempotent upsert by `airtable_id`, already run once (122 clients, 42
therapists, 42 availability, 122 matches, 472 sessions, 100 feedback).

RDS has **no public endpoint** — reaching it (for schema/backfill/manual
inspection) requires a tunnel. The pattern used: a short-lived `t4g.nano` EC2
instance in the same VPC with an SSM-only IAM role (`elfina-bastion-ssm-role`
/ `elfina-bastion-ssm-profile`, `AmazonSSMManagedInstanceCore`), reachable
with no SSH key via:

```bash
aws ssm start-session --region ap-south-1 --target <instance-id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["15432"]}'
# then point DATABASE_URL at postgres://...@localhost:15432/elfina
```

Requires the `session-manager-plugin` (`brew install --cask
session-manager-plugin`, needs sudo). The instance used for this has since
been terminated — recreate one if RDS needs inspecting again (`ami-07c8b91119c5b1b1e`,
Amazon Linux 2023 arm64, subnet in the default VPC, `elfina-bastion-ssm-profile`).

### Why a NAT Gateway was needed, and why it's gone now

Attaching an App Runner VPC connector routes **all** outbound traffic
through the VPC, not just DB traffic — so once attached, the services lost
their route to the internet (Airtable) entirely, since the default VPC's
subnets had no NAT. A NAT Gateway + a new private route table
(`0.0.0.0/0 -> NAT`) associated with the connector's 3 subnets fixed that.

The NAT Gateway billed a flat ~$0.045/hour regardless of use (~$8/week) —
once RDS testing was done and the demo doesn't need live RDS access (the app
runs fine on Airtable alone, `STORE_MODE=airtable` default), both services
were reverted to `EgressType: DEFAULT` and the NAT Gateway + its EIP were
deleted. The VPC connector resource itself still exists (no charge) but is
unattached.

### Resuming RDS + dual-write later (not needed for a plain demo)

1. Recreate the NAT Gateway in the existing NAT subnet, in the existing
   route table (`0.0.0.0/0` route was left pointing at the old, now-deleted
   NAT id — replace it with the new one).
2. Re-attach `elfina-vpc-connector` to both services
   (`NetworkConfiguration.EgressConfiguration.EgressType: VPC`) and
   redeploy.
3. `aws rds start-db-instance --db-instance-identifier elfina-rds`.
4. Set `/elfina/STORE_MODE` back to `dual` if it's been flipped to
   `airtable`, and redeploy if changed.

Roughly 15-20 minutes end to end, not instant — plan ahead if this is ever
needed live rather than doing it mid-demo.

## Cost: current paused state

- App Runner (both services): **paused**, ~$0 compute.
- NAT Gateway: **deleted**, $0 (no stop/start state exists for this resource
  type — deletion was the only way to stop the ~$8/week charge).
- RDS: **stopped**, only 20GB storage billing (~$0.50-0.60/week). AWS
  auto-restarts a stopped RDS instance after 7 days regardless of anything
  done here — re-stop it (`aws rds stop-db-instance`) if that happens before
  it's needed again.
- Everything else (VPC, subnets, security groups, IAM roles, ECR images,
  SSM parameters, the applied schema and backfilled rows in RDS storage) has
  no ongoing hourly cost and was left in place.

## Resuming for a demo

Only the two App Runner services need to come back — the demo doesn't
depend on RDS/NAT/VPC connector at all:

```bash
aws apprunner resume-service --region ap-south-1 --service-arn arn:aws:apprunner:ap-south-1:010221970625:service/elfina-companion-app/4ea7de82541e4c7e8757e5b468b0a75a
aws apprunner resume-service --region ap-south-1 --service-arn arn:aws:apprunner:ap-south-1:010221970625:service/elfina-booking-app/00b91e6a04d342fe9787ccb6d1f6ae59
```

~1 minute each. Pause again after with `aws apprunner pause-service` using
the same service ARNs.

## What this doesn't do yet

- No custom domain — using the default `*.awsapprunner.com` URLs, fine for a
  demo.
- No CI/CD — deploys are the manual `docker build && push && start-deployment`
  steps above, matching the low-budget/demo scope. Worth automating (e.g.
  GitHub Actions → ECR → App Runner) once this is more than a demo.
- Reads still go to Airtable even with `STORE_MODE=dual` (dual-write, not
  dual-read) — matches the migration plan's phased cutover, which only
  moves reads over after a drift-checked soak period.
- No shadow-read/drift-check job, no table-by-table cutover, no Airtable
  retirement — this covers migration plan phases 1-3 (schema, seam,
  backfill) plus a manually-verified dual-write, not the full phased
  rollout.
