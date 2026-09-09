# Replit → AWS App Runner — Deployment Migration

How `companion-app` and `booking-app` moved off Replit's autoscale deployment
onto AWS, and how to operate them there.

## Why App Runner

Both services are small stateless Express apps with no persistent local
state (all data lives in Airtable, per
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

## Current state

Both App Runner services are **paused**. The RDS/dual-write experiment
described below has been **fully torn down** — Airtable is the only store
again, matching the app's pre-migration behavior.

## Airtable → RDS dual-write (removed)

For a while both services went through `shared/store.mjs` with a
`STORE_MODE=dual` option that mirrored writes to a Postgres RDS instance
(`shared/store-postgres.mjs`), per `airtable-to-rds-migration-plan.md`.
This was fully reverted:

- `shared/store.mjs` is back to a pure Airtable passthrough (no `STORE_MODE`
  branch).
- `shared/store-postgres.mjs` and the RDS-only scripts
  (`scripts/apply-schema.mjs`, `scripts/backfill-rds.mjs`,
  `scripts/rds-schema.sql`) were deleted.
- The `pg` dependency was dropped from both services' `package.json`.
- All RDS-related AWS resources were deleted: the `elfina-rds` instance (no
  final snapshot — Airtable was always the source of truth), its DB subnet
  group, its security group, the bastion security group, the App Runner VPC
  connector and its security group, the `/elfina/DATABASE_URL` and
  `/elfina/STORE_MODE` SSM parameters, and the DATABASE_URL/STORE_MODE
  grants on `AppRunnerElfinaInstanceRole`'s SSM policy.
- The NAT Gateway this setup needed had already been deleted earlier (see
  git history for that rationale if reviving RDS is ever wanted again).

Reviving RDS-backed storage later would mean redoing this migration from
scratch (new instance, new schema, new backfill) rather than "resuming"
anything — nothing paused/stopped survives this teardown.

## Cost: current paused state

- App Runner (both services): **paused**, ~$0 compute.
- RDS, NAT Gateway, VPC connector: **deleted**, $0.
- Everything else (VPC, subnets, remaining security groups, IAM roles, ECR
  images, `AIRTABLE_PAT`/`AIRTABLE_BASE_ID` SSM parameters) has no ongoing
  hourly cost and was left in place.

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
