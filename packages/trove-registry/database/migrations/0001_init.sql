-- One row per artifact (§7 of the standard): id, host URL, lineage, and the
-- contract-check result from registration. `canonical` is never stored — it is
-- derived from `id` in code, so the canonical domain lives in exactly one
-- constant. `host_url` binds permanently at first registration (no rebind, no
-- host-move route); `registered_at` is the first registration time and never
-- moves on re-register.
CREATE TABLE artifact (
	id TEXT PRIMARY KEY,
	host_url TEXT NOT NULL,
	standard INTEGER NOT NULL,
	parent TEXT,
	contract_check TEXT NOT NULL,
	registered_at TEXT NOT NULL
) STRICT;
