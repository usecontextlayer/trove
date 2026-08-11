import { defineConfig } from "tsdown"

// Browser app bundle: one self-contained classic script, served as
// https://trove.usecontextlayer.com/trove.js and byte-identical for every
// artifact (§4 of the standard). `iife` is the format loadable via a plain
// <script src> tag; no globalName because the script is purely side-effecting.
// `target` and `dts` are explicit because tsdown's auto-detection would
// otherwise resolve target from engines.node and dts from the base tsconfig's
// `declaration: true` — both wrong for a browser artifact (measured).
export default defineConfig({
	clean: true,
	dts: false,
	entry: { trove: "src/trove.ts" },
	format: ["iife"],
	minify: true,
	outDir: "dist",
	outputOptions: { entryFileNames: "[name].js" },
	platform: "browser",
	sourcemap: false,
	target: ["es2022"],
})
