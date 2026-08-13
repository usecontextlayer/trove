import { describe, expect, it } from "vitest"
import { CURRENT_STANDARD, manifestSchema } from "@/index"

const id = "8k2mfq7xr3nv9wbz4tcy6hjd"

// A parent is named at its own URL now — where it is actually served.
const PARENT_URL = "https://trove-9xk2mfq7.mellow-harbor.workers.dev"

// The standard's §3 example, completed with a well-formed parent lineage.
function validManifest(): Record<string, unknown> {
	return {
		files: [
			{
				digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
				mediaType: "text/csv",
				path: "/data.csv",
				size: 1103,
			},
		],
		id,
		standard: CURRENT_STANDARD,
	}
}

describe("manifestSchema", () => {
	it("accepts the standard's example", () => {
		expect(manifestSchema.parse(validManifest())).toMatchObject({
			id,
			standard: CURRENT_STANDARD,
		})
	})

	it("accepts the index page listed as /", () => {
		const manifest = validManifest()
		manifest.files = [
			{
				digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
				mediaType: "text/html",
				path: "/",
				size: 42,
			},
		]
		expect(manifestSchema.safeParse(manifest).success).toBe(true)
	})

	it("accepts a remix carrying both parent and parentDigest", () => {
		const manifest = {
			...validManifest(),
			parent: PARENT_URL,
			parentDigest:
				"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		}
		expect(manifestSchema.safeParse(manifest).success).toBe(true)
	})

	it("rejects parent without parentDigest", () => {
		const manifest = { ...validManifest(), parent: PARENT_URL }
		expect(manifestSchema.safeParse(manifest).success).toBe(false)
	})

	it("rejects parentDigest without parent", () => {
		const manifest = {
			...validManifest(),
			parentDigest:
				"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		}
		expect(manifestSchema.safeParse(manifest).success).toBe(false)
	})

	it("rejects an uppercase-hex digest", () => {
		const manifest = validManifest()
		manifest.files = [
			{
				digest: "sha256:9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08",
				mediaType: "text/csv",
				path: "/data.csv",
				size: 1103,
			},
		]
		expect(manifestSchema.safeParse(manifest).success).toBe(false)
	})

	it("rejects a path without a leading slash", () => {
		const manifest = validManifest()
		manifest.files = [
			{
				digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
				mediaType: "text/csv",
				path: "data.csv",
				size: 1103,
			},
		]
		expect(manifestSchema.safeParse(manifest).success).toBe(false)
	})

	it("rejects a string standard version", () => {
		const manifest = { ...validManifest(), standard: String(CURRENT_STANDARD) }
		expect(manifestSchema.safeParse(manifest).success).toBe(false)
	})

	it("rejects a dotted standard version", () => {
		const manifest = { ...validManifest(), standard: CURRENT_STANDARD + 0.5 }
		expect(manifestSchema.safeParse(manifest).success).toBe(false)
	})

	// Only the current version CONFORMS — there is no backward compatibility.
	// But the schema is not where that verdict belongs: a manifest written to
	// another version is out of date or ahead of us, not corrupt, and a reader
	// needs to be told which. So both directions parse, and the checker names
	// the version problem.
	it.each([
		["newer than this implementation", CURRENT_STANDARD + 1],
		["older than this implementation", CURRENT_STANDARD - 1],
	])("parses a standard version %s", (_label, standard) => {
		const manifest = { ...validManifest(), standard }
		expect(manifestSchema.safeParse(manifest).success).toBe(true)
	})

	// §3's trove-path grammar. Each of these was accepted by "begins with a
	// slash", and each produced a real defect: `//host/x` is a protocol-relative
	// AUTHORITY, so resolving it left the trove's origin entirely; `..` escaped
	// the destination directory when a remixer wrote the file to disk.
	it.each([
		["a protocol-relative authority", "//evil.example/x"],
		["a backslash authority", "/\\evil.example/x"],
		["a parent-directory segment", "/../../etc/passwd"],
		["a nested parent-directory segment", "/a/../../outside.txt"],
		["a percent-encoded parent segment", "/a/%2e%2e/outside.txt"],
		["a current-directory segment", "/./data.csv"],
		["a query string", "/data.csv?x=1"],
		["a fragment", "/data.csv#top"],
	])("rejects %s", (_label, path) => {
		const manifest = validManifest()
		manifest.files = [
			{
				digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
				mediaType: "text/csv",
				path,
				size: 1103,
			},
		]
		expect(manifestSchema.safeParse(manifest).success).toBe(false)
	})

	it.each([
		["the index page", "/"],
		["a nested path", "/docs/guide.md"],
		["a dot in a filename", "/v1.2.3/data.csv"],
		["a leading-dot filename", "/.well-known/thing"],
	])("accepts %s", (_label, path) => {
		const manifest = validManifest()
		manifest.files = [
			{
				digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
				mediaType: "text/csv",
				path,
				size: 1103,
			},
		]
		expect(manifestSchema.safeParse(manifest).success).toBe(true)
	})
})
