import { createHash } from "node:crypto"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import {
	AGENTS_MD_PATH,
	canonicalUrlForId,
	MANIFEST_PATH,
	renderMandatedBlock,
} from "@usecontextlayer/trove-standard"
import { defineConfig } from "vitest/config"
import {
	unitTestExclude,
	unitTestInclude,
	workerUnitTestInclude,
	// biome-ignore lint/style/noRestrictedImports: vitest.shared sits at the monorepo root, outside this package — no @/ alias reaches it
} from "../../vitest.shared"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

// A conformant fixture trove, built at config-load time from trove-standard's
// REAL block template and manifest shape — so the fixture can never drift from
// the standard — and served by an auxiliary miniflare worker on a *.workers.dev
// route. The registry Worker's outbound manifest fetch during POST /register
// resolves against it inside miniflare, with no seam in production code.
const FIXTURE_TROVE_ID = "0123456789abcdefghjkmnpq"
const FIXTURE_HOST_URL = "https://trove-fixture.test-account.workers.dev"
// A second host serving the SAME trove bytes — §7's copy-and-re-point
// attack, which the registry's no-rebind rule must reject.
const FIXTURE_MIRROR_HOST_URL = "https://trove-mirror.test-account.workers.dev"

function digest(content: string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

const indexHtml = `<!doctype html>
<html>
<head><title>Fixture trove</title></head>
<body>
<h1>Fixture trove</h1>
${renderMandatedBlock(FIXTURE_TROVE_ID)}
</body>
</html>
`
const agentsMd = "# Fixture trove\n\nA tiny trove used by the registry's tests.\n"
const dataCsv = "a,b\n1,2\n"
const manifest = {
	canonical: canonicalUrlForId(FIXTURE_TROVE_ID),
	files: [
		{
			digest: digest(indexHtml),
			mediaType: "text/html",
			path: "/",
			size: Buffer.byteLength(indexHtml),
		},
		{
			digest: digest(agentsMd),
			mediaType: "text/markdown",
			path: AGENTS_MD_PATH,
			size: Buffer.byteLength(agentsMd),
		},
		{
			digest: digest(dataCsv),
			mediaType: "text/csv",
			path: "/data.csv",
			size: Buffer.byteLength(dataCsv),
		},
	],
	id: FIXTURE_TROVE_ID,
	standard: 1,
}

const fixtureResponses: Record<string, { body: string; contentType: string }> = {
	"/": { body: indexHtml, contentType: "text/html; charset=utf-8" },
	"/data.csv": { body: dataCsv, contentType: "text/csv; charset=utf-8" },
	[AGENTS_MD_PATH]: { body: agentsMd, contentType: "text/markdown; charset=utf-8" },
	[MANIFEST_PATH]: { body: JSON.stringify(manifest), contentType: "application/json" },
}

const troveHostScript = `
const RESPONSES = ${JSON.stringify(fixtureResponses)};
export default {
	async fetch(request) {
		const url = new URL(request.url);
		const entry = RESPONSES[url.pathname];
		if (!entry) {
			return new Response("not found", { status: 404 });
		}
		return new Response(entry.body, {
			headers: { "content-type": entry.contentType, "x-robots-tag": "noindex" },
		});
	},
};
`

const migrations = await readD1Migrations(
	path.join(projectRoot, "database", "migrations"),
)

export default defineConfig({
	test: {
		projects: [
			{
				resolve: { tsconfigPaths: true },
				test: {
					// The worker-unit exclude lives HERE, not in the shared
					// unitTestExclude: only a package whose worker project claims the
					// `.worker.` files may drop them from node — elsewhere they run in
					// node and fail loud, so misplacement self-reports (vitest.shared.ts).
					exclude: [...unitTestExclude, ...workerUnitTestInclude],
					include: unitTestInclude,
					name: "trove-registry:node",
					root: projectRoot,
				},
			},
			{
				plugins: [
					cloudflareTest({
						miniflare: {
							// Auxiliary-worker `routes` handle INCOMING dispatch only —
							// they never intercept outbound fetch (measured: the register
							// handler's manifest fetch escaped to the real network).
							// outboundService is the interception point: every outbound
							// fetch from the test worker resolves against the fixture
							// host, which routes by pathname alone, so both fixture host
							// names serve the same trove.
							outboundService: "trove-host",
							workers: [
								{
									compatibilityDate: "2026-08-01",
									modules: true,
									name: "trove-host",
									script: troveHostScript,
								},
							],
						},
						wrangler: { configPath: path.join(projectRoot, "wrangler.jsonc") },
					}),
				],
				resolve: { tsconfigPaths: true },
				test: {
					include: workerUnitTestInclude,
					name: "trove-registry:worker",
					provide: {
						fixtureHostUrl: FIXTURE_HOST_URL,
						fixtureMirrorHostUrl: FIXTURE_MIRROR_HOST_URL,
						fixtureTroveId: FIXTURE_TROVE_ID,
						migrations,
					},
					root: projectRoot,
					setupFiles: ["./tests/apply-migrations.ts"],
				},
			},
		],
	},
})
