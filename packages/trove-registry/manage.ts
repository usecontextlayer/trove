import { execSync } from "node:child_process"
import { globSync, rmSync } from "node:fs"
import * as path from "node:path"
import { Command } from "commander"

// The registry's schema-ops CLI, mirroring the ContextLayer `manage` shape
// (db-infra/manage.ts) over Cloudflare-idiomatic tooling: wrangler owns
// migration state (`d1_migrations` bookkeeping, per-file batch atomicity),
// kysely-codegen regenerates the typed models from the real migrated local
// database, biome formats them. Actions: latest | drop | codegen | biome.
// A migrate action chains codegen + biome afterward unless --no-auto-*.
//
// `latest` is LOCAL by default; `latest --remote` applies to the production
// D1 (wrangler prompts unless run non-interactively). `drop` is local-only by
// design — there is deliberately no remote drop.

const DATABASE_NAME = "trove-registry"
const MODELS_FILE = "database/models/DB.ts"
// The local D1 database is a real SQLite file miniflare keys by an opaque
// Durable Object id — glob for it, excluding miniflare's own metadata.sqlite.
const LOCAL_D1_GLOB = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite"

function run(command: string): void {
	execSync(command, { cwd: import.meta.dirname, stdio: "inherit" })
}

function latest(remote: boolean): void {
	const target = remote ? "--remote" : "--local"
	run(`npx wrangler d1 migrations apply ${DATABASE_NAME} ${target}`)
}

function drop(): void {
	rmSync(path.join(import.meta.dirname, ".wrangler/state/v3/d1"), {
		force: true,
		recursive: true,
	})
}

function codegen(): void {
	// Regenerate from a freshly-migrated local database so the models always
	// reflect the full migration chain, never a stale working copy.
	drop()
	latest(false)
	const files = globSync(LOCAL_D1_GLOB, { cwd: import.meta.dirname }).filter(
		(file) => !file.endsWith("metadata.sqlite"),
	)
	const dbFile = files[0]
	if (files.length !== 1 || !dbFile) {
		throw new Error(
			`Expected exactly one local D1 database at ${LOCAL_D1_GLOB}, found: ${files.join(", ") || "none"}`,
		)
	}
	run(
		`npx kysely-codegen --dialect sqlite --url "${dbFile}" --exclude-pattern "(_cf_*|d1_migrations|sqlite_*)" --out-file ${MODELS_FILE}`,
	)
}

function biome(): void {
	run(`../../node_modules/.bin/biome check --write ${path.dirname(MODELS_FILE)}`)
}

const ACTIONS: Record<string, (remote: boolean) => void> = {
	biome,
	codegen,
	drop,
	latest,
}

const parsed = new Command()
	.argument("<action>", "latest | drop | codegen | biome")
	.option("--remote", "apply migrations to the production D1 (latest only)", false)
	.option("--no-auto-biome")
	.option("--no-auto-codegen")
	.parse()

const action = parsed.args[0]
if (!action) {
	throw new Error("An action is required (latest | drop | codegen | biome).")
}
const { autoBiome, autoCodegen, remote } = parsed.opts()
if (remote && action !== "latest") {
	throw new Error("--remote is only valid with the latest action.")
}

const queue = [action]
if (!remote) {
	if (autoCodegen) {
		queue.push("codegen")
	}
	if (autoBiome) {
		queue.push("biome")
	}
}
const deduped = [...new Set(queue.reverse())].reverse()
for (const name of deduped) {
	const fn = ACTIONS[name]
	if (!fn) {
		throw new Error(`Unknown action: ${name}`)
	}
	fn(remote)
}
