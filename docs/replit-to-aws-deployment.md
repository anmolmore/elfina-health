# Replit → AWS App Runner — Deployment Migration

How `companion-app` and `booking-app` moved off Replit's autoscale deployment
onto AWS App Runner, and how to redeploy them there if needed again.

## Current state: torn down

Everything described below (App Runner services, ECR repos, their IAM
roles) was deleted to bring AWS spend to ~$0 while the project is idle.
There is no live deployment right now. Redeploying means recreating these
resources from scratch — see "Redeploying from scratch" below.

The Airtable → RDS dual-write experiment (Postgres mirror, `STORE_MODE`)
was separately reverted; `shared/store.mjs` is a pure Airtable passthrough
again. See git history around the `dev-basic` branch for that removal.

## Why App Runner

Both services are small stateless Express apps with no persistent local
state (all data lives in Airtable). That rules out anything needing a VPC,
load balancer, or orchestration to justify itself:

- **App Runner** — push a container, AWS handles the HTTPS endpoint,
  load balancing, and scaling. Closest match to what Replit's autoscale
  deployment was already doing. Chosen.
- ECS Fargate — more control (own VPC, task defs), but that control has no
  use without other services to network with.
- Elastic Beanstalk — PaaS-y like App Runner but more legacy tooling for no
  extra benefit here.

This is a demo deployment on a **low budget** — every choice below optimizes
for "cheapest way to have a real, clickable HTTPS URL," not for production
scale.

## What changed in the repo for this deployment

- `elfina-platform/services/companion-app/Dockerfile` and
  `.../booking-app/Dockerfile` — build context is `elfina-platform/`
  (not the service subfolder) because both services import
  `shared/airtable.mjs` via a relative path (`../../../shared/airtable.mjs`),
  and the workspace `package.json`/lockfile live at that level too.
- `elfina-platform/.dockerignore` — excludes `node_modules`, `.env`, logs.
- Both services already read `PORT` from `process.env` (defaulting to
  4003/4004 locally); the Dockerfiles set `PORT=8080` and `EXPOSE 8080`
  because that's App Runner's expected container port.
- Nothing else in application code changed. Airtable credentials come from
  `process.env.AIRTABLE_PAT` / `AIRTABLE_BASE_ID`.

## Redeploying from scratch

Account `010221970625`, region `ap-south-1`.

1. **ECR repos**:
   ```bash
   aws ecr create-repository --region ap-south-1 --repository-name elfina-companion-app
   aws ecr create-repository --region ap-south-1 --repository-name elfina-booking-app
   ```
2. **SSM params** (`/elfina/AIRTABLE_PAT`, `/elfina/AIRTABLE_BASE_ID` as
   SecureString) — these were left in place and don't need recreating;
   confirm with `aws ssm describe-parameters --parameter-filters
   "Key=Name,Option=BeginsWith,Values=/elfina"`.
3. **IAM roles**:
   - `AppRunnerECRAccessRole` — trust policy for `build.apprunner.amazonaws.com`,
     attach `arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess`.
   - `AppRunnerElfinaInstanceRole` — trust policy for `tasks.apprunner.amazonaws.com`,
     inline policy granting `ssm:GetParameters` on the two SSM param ARNs
     and `kms:Decrypt` on the `aws/ssm` key.
4. **Build and push images**:
   ```bash
   cd elfina-platform
   aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 010221970625.dkr.ecr.ap-south-1.amazonaws.com

   docker build -f services/companion-app/Dockerfile -t elfina-companion-app:local .
   docker tag elfina-companion-app:local 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-companion-app:latest
   docker push 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-companion-app:latest

   docker build -f services/booking-app/Dockerfile -t elfina-booking-app:local .
   docker tag elfina-booking-app:local 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-booking-app:latest
   docker push 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-booking-app:latest
   ```
5. **Create App Runner services** (`0.25 vCPU / 0.5 GB`, smallest tier,
   port 8080, `RuntimeEnvironmentSecrets` pointing at the two SSM param
   ARNs, `AutoDeploymentsEnabled: false`) via console or
   `aws apprunner create-service`.

## Redeploying after a code change (once services exist again)

```bash
cd elfina-platform
docker build -f services/companion-app/Dockerfile -t elfina-companion-app:local .
docker tag elfina-companion-app:local 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-companion-app:latest
docker push 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-companion-app:latest
aws apprunner start-deployment --region ap-south-1 --service-arn <companion-app-service-arn>

docker build -f services/booking-app/Dockerfile -t elfina-booking-app:local .
docker tag elfina-booking-app:local 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-booking-app:latest
docker push 010221970625.dkr.ecr.ap-south-1.amazonaws.com/elfina-booking-app:latest
aws apprunner start-deployment --region ap-south-1 --service-arn <booking-app-service-arn>
```

## Cost control: pause between demos

App Runner has no true scale-to-zero — the smallest instance still bills
continuously while the service is running. For a demo used intermittently,
pause it between sessions instead of leaving it running (or delete the
service entirely, as was done here, if it'll sit idle for a long stretch):

```bash
aws apprunner pause-service --region ap-south-1 --service-arn <service-arn>
aws apprunner resume-service --region ap-south-1 --service-arn <service-arn>   # ~1 min to come back up
```

Paused services keep their config/image and cost ~$0 compute while paused.
A deleted service costs nothing but must be recreated from scratch
(steps above).

## What this doesn't do yet

- No custom domain — the old default `*.awsapprunner.com` URLs are gone
  along with the services; a redeploy gets new ones.
- No CI/CD — deploys are the manual `docker build && push && start-deployment`
  steps above, matching the low-budget/demo scope. Worth automating (e.g.
  GitHub Actions → ECR → App Runner) if this becomes more than a demo.
