import type {
	DatabaseConnection,
	Dialect,
	Driver,
	Kysely,
	QueryResult,
	TransactionSettings,
} from "kysely"
import {
	type CompiledQuery,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely"

// Vendored D1 dialect for Kysely, ~70 lines. Deliberately NOT the npm
// `kysely-d1` package: it is unmaintained (last publish 2025-04) and its
// `Dialect` no longer satisfies kysely 0.29's type. better-auth vendored this
// same shape for the same reasons (their PR #7519). Kysely is used purely as a
// typed query builder here — D1 has no interactive transactions (its one
// atomicity primitive is `D1Database.batch()`), so the transaction methods
// throw, and migrations run through wrangler, never through kysely.

class D1Connection implements DatabaseConnection {
	readonly #database: D1Database

	constructor(database: D1Database) {
		this.#database = database
	}

	async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		const results = await this.#database
			.prepare(compiledQuery.sql)
			.bind(...compiledQuery.parameters)
			.all<Record<string, unknown>>()
		return {
			numAffectedRows:
				results.meta.changes === undefined ? undefined : BigInt(results.meta.changes),
			rows: (results.results ?? []) as R[],
		}
	}

	// biome-ignore lint/correctness/useYield: the contract is to throw — D1 cannot stream
	async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
		throw new Error("D1 does not support streaming queries")
	}
}

class D1Driver implements Driver {
	readonly #connection: D1Connection

	constructor(database: D1Database) {
		this.#connection = new D1Connection(database)
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		return this.#connection
	}

	async beginTransaction(
		_connection: DatabaseConnection,
		_settings: TransactionSettings,
	): Promise<void> {
		throw new Error("D1 does not support transactions; use D1Database.batch()")
	}

	async commitTransaction(): Promise<void> {
		throw new Error("D1 does not support transactions; use D1Database.batch()")
	}

	async rollbackTransaction(): Promise<void> {
		throw new Error("D1 does not support transactions; use D1Database.batch()")
	}

	async releaseConnection(): Promise<void> {}

	async destroy(): Promise<void> {}
}

export class D1Dialect implements Dialect {
	readonly #database: D1Database

	constructor(config: { database: D1Database }) {
		this.#database = config.database
	}

	createAdapter(): SqliteAdapter {
		return new SqliteAdapter()
	}

	createDriver(): Driver {
		return new D1Driver(this.#database)
	}

	createQueryCompiler(): SqliteQueryCompiler {
		return new SqliteQueryCompiler()
	}

	// Never used at runtime (the registry only builds queries), but `Dialect`
	// requires it. Kysely's stock SQLite introspector fails on D1's SQL
	// authorizer if ever driven — acceptable for a method nothing calls.
	// biome-ignore lint/suspicious/noExplicitAny: kysely's own Dialect signature
	createIntrospector(db: Kysely<any>): SqliteIntrospector {
		return new SqliteIntrospector(db)
	}
}
