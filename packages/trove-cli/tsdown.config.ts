import { defineConfig } from "tsdown"

// CLI app bundle: inline the workspace libs + pure-JS deps into a single
// Node-runnable `dist/cli.mjs`, keeping only `dependencies` external — which
// here is exactly `wrangler`, pinned to the EXACT version whose measured
// behaviors (the undocumented --temporary flag, the claim-URL output shape)
// this CLI depends on. No `dts` — this is an executable, not a library.
export default defineConfig({
	clean: true,
	dts: false,
	entry: ["cli.ts"],
	format: ["esm"],
	minify: false,
	outDir: "dist",
	platform: "node",
	sourcemap: true,
})
