import { Kysely } from "kysely"
import { D1Dialect } from "@/database/d1-dialect"
import type { DB } from "@/database/models/DB"

// Schema BINDING for the registry database — the composition root (the Worker's
// fetch handler) owns WHICH database (the D1 binding); this binder owns the
// schema typing. Construct inside the fetch handler, never at module scope:
// the binding does not exist at module-evaluation time in a Worker.
export function createRegistryDb(database: D1Database): Kysely<DB> {
	return new Kysely<DB>({ dialect: new D1Dialect({ database }) })
}

export type { DB, Trove } from "@/database/models/DB"
