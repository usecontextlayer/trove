import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { TROVE_ORIGIN } from "@usecontextlayer/trove-standard"
import { describe, expect, it } from "vitest"

// The platform's own trove.json is committed, not built (deploys/builds stay
// as-is — owner-ruled), so THIS test is what keeps it honest: it recomputes
// every listed digest from the real bytes under public/ and fails CI the
// moment an edit lands without a `manage manifest` rerun.

const publicDir = path.join(import.meta.dirname, "..", "public")

interface PlatformManifest {
	files: { digest: string; mediaType: string; path: string; size: number }[]
	id: string
	standard: number
}

const manifest = JSON.parse(
	readFileSync(path.join(publicDir, "trove.json"), "utf8"),
) as PlatformManifest

describe("the platform's own trove.json", () => {
	it("carries the special id — the platform's own URL", () => {
		// Trove is a trove in spirit, not in exactness: its id is its URL.
		// NOTE for consumers: nothing may treat this CLAIM as proof of being the
		// platform — trove.json can be faked; platform detection is by location.
		expect(manifest.id).toBe(TROVE_ORIGIN)
		expect(manifest.standard).toBe(1)
	})

	it("lists the four stable authored files, and only those", () => {
		expect(manifest.files.map((file) => file.path).sort()).toEqual([
			"/",
			"/AGENTS.md",
			"/skills/remixing-troves/SKILL.md",
			"/skills/writing-troves/SKILL.md",
		])
	})

	it("elides /trove.js — the entry that would need the deferred build symmetry", () => {
		expect(manifest.files.map((file) => file.path)).not.toContain("/trove.js")
	})

	it("matches the real bytes under public/ — digest and size per file", () => {
		for (const file of manifest.files) {
			const source = file.path === "/" ? "index.html" : file.path.slice(1)
			const content = readFileSync(path.join(publicDir, source))
			const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`
			expect(
				file.digest,
				`${file.path} is stale — rerun: npx tsx manage.ts manifest`,
			).toBe(digest)
			expect(file.size).toBe(content.byteLength)
		}
	})
})
