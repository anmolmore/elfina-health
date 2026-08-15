// Seam between the services and Airtable. Same client shape as
// shared/airtable.mjs (list/get/create/update) so call sites need only
// swap the import -- this is the "zero behavior change" refactor step of
// docs/airtable-to-rds-migration-plan.md.
//
// STORE_MODE controls the Postgres mirror:
//   "airtable" (default) -- pure passthrough, no Postgres involved at all.
//   "dual"               -- Airtable write happens first and is what the
//                            caller waits on; a best-effort mirror write to
//                            Postgres is then fired and its failure only
//                            logged, never thrown. This is what lets RDS be
//                            stopped without breaking the app: worst case
//                            is a logged connection failure per write.
//
// Reads (list/get) always go to Airtable -- the migration plan keeps reads
// on Airtable through dual-write, cutting over table-by-table only after a
// drift check.

import { airtableClient } from "./airtable.mjs";
import { mirrorCreate, mirrorUpdate } from "./store-postgres.mjs";

export function createStore() {
  const at = airtableClient();
  const mode = process.env.STORE_MODE || "airtable";
  console.log(`[store] initialized in mode=${mode}`);

  return {
    async list(table, opts) {
      return at.list(table, opts);
    },
    async get(table, id) {
      return at.get(table, id);
    },
    async create(table, fields, opts) {
      const record = await at.create(table, fields, opts);
      if (mode === "dual") {
        mirrorCreate(table, record)
          .then(() => console.log(`[store] postgres mirror create ok for ${table}/${record.id}`))
          .catch((err) =>
            console.error(`[store] postgres mirror create failed for ${table}/${record.id}`, err.message)
          );
      }
      return record;
    },
    async update(table, id, fields) {
      const record = await at.update(table, id, fields);
      if (mode === "dual") {
        mirrorUpdate(table, id, fields)
          .then(() => console.log(`[store] postgres mirror update ok for ${table}/${id}`))
          .catch((err) =>
            console.error(`[store] postgres mirror update failed for ${table}/${id}`, err.message)
          );
      }
      return record;
    },
  };
}
