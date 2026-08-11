import { applyD1Migrations, env, reset } from "cloudflare:test"
import type { D1Migration } from "@cloudflare/vitest-pool-workers"
import { afterEach, beforeEach, inject } from "vitest"

declare module "vitest" {
	interface ProvidedContext {
		fixtureArtifactId: string
		fixtureHostUrl: string
		fixtureMirrorHostUrl: string
		migrations: D1Migration[]
	}
}

// Per-test isolation: reset() wipes ALL binding data including the schema, so
// migrations re-apply before every test rather than once per file.
beforeEach(async () => {
	await applyD1Migrations(env.DB, inject("migrations"))
})

afterEach(async () => {
	await reset()
})
