import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"
// biome-ignore lint/style/noRestrictedImports: vitest.shared sits at the monorepo root, outside this package — no @/ alias reaches it
import { unitTestExclude, unitTestInclude } from "../../vitest.shared"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineProject({
	resolve: { tsconfigPaths: true },
	test: {
		exclude: unitTestExclude,
		// Three tests in two files each spawn a real `wrangler dev`, and with
		// files running in parallel those boots compete: measured, a boot that
		// normally takes about a second went past sixty and failed the run. They
		// are the only slow files here — the whole suite is a few seconds — so
		// serializing costs almost nothing and removes the contention entirely.
		fileParallelism: false,
		include: unitTestInclude,
		name: "@usecontextlayer/trove",
		root: projectRoot,
	},
})
