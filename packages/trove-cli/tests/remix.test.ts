import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { manifestSchema, mintId } from "@usecontextlayer/trove-standard"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assembleTrove } from "@/src/assemble"
import { parseTroveUrl, readRemixMarker, remixTrove } from "@/src/remix"

// The far side of remix is OUR OWN standard: a local server serving a REAL
// assembled trove (built by assembleTrove, digests and all) at its own root —
// which is how a trove is actually served, and since the registry stopped
// redirecting a subtree, the only way one is reachable at all.

const troveId = mintId()
let server: http.Server
let troveUrl: string
let assembledDir: string

beforeAll(async () => {
	assembledDir = path.join(mkdtempSync(path.join(os.tmpdir(), "trove-remix-src-")), "a")
	assembleTrove({
		destDir: assembledDir,
		id: troveId,
		sourceDir: makeSource(),
	})

	server = http.createServer((request, response) => {
		const trovePath = request.url || "/"
		const file = trovePath === "/" ? "index.html" : trovePath.slice(1)
		try {
			response.writeHead(200).end(readFileSync(path.join(assembledDir, file)))
		} catch {
			response.writeHead(404).end()
		}
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (address === null || typeof address === "string") {
		throw new Error("server did not bind a port")
	}
	troveUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => {
	server.close()
})

function makeSource(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "trove-remix-origin-"))
	writeFileSync(path.join(dir, "AGENTS.md"), "# Remixable\n\nRemix me.\n")
	writeFileSync(path.join(dir, "data.csv"), "a,b\n1,2\n")
	return dir
}

describe("parseTroveUrl", () => {
	it("accepts a trove's own URL", () => {
		expect(
			parseTroveUrl(
				"https://trove.usecontextlayer.com",
				"https://trove-abc.some-account.workers.dev",
			),
		).toBe("https://trove-abc.some-account.workers.dev")
	})

	// The two URL-taking commands take different URLs, so an agent will
	// eventually hand each the other's. A registry URL 302s to a trove and has
	// no subtree, so every path built under it 404s — worth naming rather than
	// letting the caller discover it one failed fetch at a time.
	it("rejects a registry URL, naming where the trove's own URL is published", () => {
		expect(() =>
			parseTroveUrl(
				"https://trove.usecontextlayer.com",
				`https://trove.usecontextlayer.com/a/${troveId}`,
			),
		).toThrow(/hostUrl/)
	})

	it("rejects something that is not a URL", () => {
		expect(() =>
			parseTroveUrl("https://trove.usecontextlayer.com", "trove-abc.workers.dev"),
		).toThrow(/not a URL/)
	})

	// §2.1: troves live at a host root. A URL carrying a path parses fine and
	// then resolves every manifest entry against the wrong base, so it has to be
	// refused here rather than normalized away — silently dropping the path
	// would act on a URL the caller never passed.
	it.each([
		["a path", "https://trove-abc.some-account.workers.dev/sub/path"],
		["a query", "https://trove-abc.some-account.workers.dev/?a=1"],
		["a fragment", "https://trove-abc.some-account.workers.dev/#x"],
	])("rejects a trove URL carrying %s", (_label, given) => {
		expect(() => parseTroveUrl("https://trove.usecontextlayer.com", given)).toThrow(
			/host root/,
		)
	})
})

describe("remixTrove", () => {
	it("fetches, verifies, strips identity, and records lineage", async () => {
		const destDir = path.join(
			mkdtempSync(path.join(os.tmpdir(), "trove-remix-out-")),
			"r",
		)
		const { fileCount } = await remixTrove({ destDir, troveUrl })
		expect(fileCount).toBe(3)

		// Files landed and match the origin bytes.
		expect(readFileSync(path.join(destDir, "data.csv"), "utf8")).toBe("a,b\n1,2\n")

		// Inherited identity is stripped: the data-trove attribute is cleared
		// (the parent id lawfully remains in the block's TEXT until publish
		// strips the remnant block — the round-trip test covers that) and the
		// parent's trove.json was never written.
		const html = readFileSync(path.join(destDir, "index.html"), "utf8")
		expect(html).toContain('data-trove=""')
		expect(html).not.toContain(`data-trove="${troveId}"`)
		expect(() => readFileSync(path.join(destDir, "trove.json"))).toThrow()

		// The marker pins the parent version: parentDigest is the hash of the
		// manifest bytes exactly as served.
		const marker = readRemixMarker(destDir)
		const servedManifest = readFileSync(path.join(assembledDir, "trove.json"))
		expect(marker).toEqual({
			parent: troveUrl,
			parentDigest: `sha256:${createHash("sha256").update(servedManifest).digest("hex")}`,
		})
	})

	it("round-trips: a remixed folder republishes with lineage", async () => {
		const destDir = path.join(
			mkdtempSync(path.join(os.tmpdir(), "trove-remix-out2-")),
			"r",
		)
		await remixTrove({ destDir, troveUrl })
		const marker = readRemixMarker(destDir)
		if (marker === null) {
			throw new Error("marker missing")
		}

		const childId = mintId()
		const childDest = path.join(
			mkdtempSync(path.join(os.tmpdir(), "trove-remix-pub-")),
			"a",
		)
		const manifest = assembleTrove({
			destDir: childDest,
			id: childId,
			parent: marker.parent,
			parentDigest: marker.parentDigest,
			sourceDir: destDir,
		})
		expect(manifestSchema.parse(manifest).parent).toBe(troveUrl)
		// The child's page carries the child's id, not the parent's.
		const html = readFileSync(path.join(childDest, "index.html"), "utf8")
		expect(html).toContain(`data-trove="${childId}"`)
		expect(html).not.toContain(troveId)
	})

	it("aborts loudly when served bytes do not match the manifest digest", async () => {
		// Tamper with the served file AFTER the manifest was generated.
		const original = readFileSync(path.join(assembledDir, "data.csv"))
		writeFileSync(path.join(assembledDir, "data.csv"), "tampered\n")
		try {
			const destDir = path.join(
				mkdtempSync(path.join(os.tmpdir(), "trove-remix-out3-")),
				"r",
			)
			await expect(remixTrove({ destDir, troveUrl })).rejects.toThrow(/do not trust it/)
		} finally {
			writeFileSync(path.join(assembledDir, "data.csv"), original)
		}
	})
})
