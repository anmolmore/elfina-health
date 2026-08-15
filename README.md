# elfina-health

Two Node.js/Express services (Companion App + Booking App) backed by
Airtable, in `elfina-platform/`. See `replit.md` for running locally on
Replit and `elfina-platform/README.md` for full setup.

## Live URLs

- Companion App: https://nxpq75mzhp.ap-south-1.awsapprunner.com
- Booking App: https://jhj7bph4ar.ap-south-1.awsapprunner.com

(May need resuming if paused — see `docs/replit-to-aws-deployment.md`.)

## Required secrets

- `AIRTABLE_PAT` — Airtable Personal Access Token
- `AIRTABLE_BASE_ID` — Airtable base ID

## Docs

- `docs/migration-strategy.md` — why/what/when for moving off Airtable + Replit
- `docs/airtable-to-rds-migration-plan.md` — schema + dual-write implementation detail
- `docs/replit-to-aws-deployment.md` — AWS App Runner deployment + operations
- `docs/target-vision-architecture.md` — longer-term product architecture
