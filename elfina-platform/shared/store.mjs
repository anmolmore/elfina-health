// Seam between the services and Airtable. Same client shape as
// shared/airtable.mjs (list/get/create/update) so call sites need only
// swap the import.

import { airtableClient } from "./airtable.mjs";

export function createStore() {
  const at = airtableClient();

  return {
    async list(table, opts) {
      return at.list(table, opts);
    },
    async get(table, id) {
      return at.get(table, id);
    },
    async create(table, fields, opts) {
      return at.create(table, fields, opts);
    },
    async update(table, id, fields) {
      return at.update(table, id, fields);
    },
  };
}
