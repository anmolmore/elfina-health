// Thin client for the real Airtable REST API. No mocking, no rate-limit
// simulation -- Airtable enforces its own 5 req/sec/base limit and this
// just surfaces whatever it returns (including real 429s).

const API = "https://api.airtable.com/v0";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function airtableClient() {
  const pat = requireEnv("AIRTABLE_PAT");
  const baseId = requireEnv("AIRTABLE_BASE_ID");
  const headers = { Authorization: `Bearer ${pat}`, "content-type": "application/json" };

  async function request(path, init) {
    const resp = await fetch(`${API}/${baseId}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Airtable ${init?.method ?? "GET"} ${path} -> ${resp.status}: ${body}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  return {
    async list(table, { filterByFormula, sort } = {}) {
      const params = new URLSearchParams();
      if (filterByFormula) params.set("filterByFormula", filterByFormula);
      if (sort) sort.forEach((s, i) => {
        params.set(`sort[${i}][field]`, s.field);
        params.set(`sort[${i}][direction]`, s.direction ?? "asc");
      });
      const qs = params.toString() ? `?${params}` : "";
      const body = await request(`/${encodeURIComponent(table)}${qs}`);
      return body.records;
    },
    async get(table, id) {
      return request(`/${encodeURIComponent(table)}/${id}`);
    },
    async create(table, fields) {
      return request(`/${encodeURIComponent(table)}`, { method: "POST", body: JSON.stringify({ fields }) });
    },
    async update(table, id, fields) {
      return request(`/${encodeURIComponent(table)}/${id}`, { method: "PATCH", body: JSON.stringify({ fields }) });
    },
    // Airtable allows up to 10 records per create/delete call -- batching
    // this way keeps a 1000-record seed well under the 5 req/sec cap
    // instead of needing one request per record.
    async createBatch(table, recordsFields, { typecast = false } = {}) {
      const created = [];
      for (let i = 0; i < recordsFields.length; i += 10) {
        const chunk = recordsFields.slice(i, i + 10).map((fields) => ({ fields }));
        const body = await request(`/${encodeURIComponent(table)}`, {
          method: "POST",
          body: JSON.stringify({ records: chunk, typecast }),
        });
        created.push(...body.records);
        await new Promise((r) => setTimeout(r, 220));
      }
      return created;
    },
    async deleteAll(table) {
      let deleted = 0;
      for (;;) {
        const body = await request(`/${encodeURIComponent(table)}?pageSize=10`);
        if (body.records.length === 0) break;
        const params = body.records.map((r) => `records[]=${r.id}`).join("&");
        await request(`/${encodeURIComponent(table)}?${params}`, { method: "DELETE" });
        deleted += body.records.length;
        await new Promise((r) => setTimeout(r, 220));
      }
      return deleted;
    },
  };
}

// Airtable stores linked-record fields as an array of record ids even when
// there's only ever one. These two helpers keep call sites honest about it.
export function linkOne(recordId) {
  return recordId ? [recordId] : [];
}
export function firstLink(fieldValue) {
  return Array.isArray(fieldValue) && fieldValue.length > 0 ? fieldValue[0] : null;
}

// Deliberately no filterByFormula-based "contains this linked record id"
// helper: ARRAYJOIN() on a link field returns the linked record's display
// name, not its id, so SEARCH(id, ARRAYJOIN(...)) silently never matches.
// Filter on fields.<LinkField> (an array of real ids) in application code
// instead -- see companion-app and booking-app.
