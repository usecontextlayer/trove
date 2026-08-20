import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { manifestSchema, mintId } from "@usecontextlayer/trove-standard"
import mime from "mime"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assembleTrove } from "@/src/assemble"
import { readRemixMarker, remixTrove } from "@/src/remix"
import { describeNonConformance } from "@/src/report"

// The far side of remix is OUR OWN standard: a local server serving a REAL
// assembled trove (built by assembleTrove, digests and all) at its own root —
// which is how a trove is actually served, and since the registry stopped
// redirecting a subtree, the only way one is reachable at all.

const troveId = mintId()
let server: http.Server
let troveUrl: string
let assembledDir: string
/** Flipped by the non-conformance test: dropping it fails check 5 without touching a single byte, so digests still match and the remix still completes. */
let noindex = true

beforeAll(async () => {
	assembledDir = path.join(mkdtempSync(path.join(os.tmpdir(), "trove-remix-src-")), "a")
	assembleTrove({
		destDir: assembledDir,
		id: troveId,
		sourceDir: makeSource(),
	})

	// Serves the assembled trove the way the real host does — correct media type
	// per extension and X-Robots-Tag on every response. remix now runs the §6.1
	// checker against this, so a server that answered without content types would
	// fail checks 1, 2 and 3 and put every test on the unhappy path.
	server = http.createServer((request, response) => {
		const trovePath = request.url || "/"
		const file = trovePath === "/" ? "index.html" : trovePath.slice(1)
		try {
			const body = readFileSync(path.join(assembledDir, file))
			const headers: Record<string, string> = {
				"content-type": mime.getType(file) ?? "application/octet-stream",
			}
			if (noindex) {
				headers["x-robots-tag"] = "noindex"
			}
			response.writeHead(200, headers).end(body)
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
	writeFileSync(
		path.join(dir, "index.html"),
		Buffer.concat([
			Buffer.from(
				'<!doctype html><html><head><meta charset="iso-8859-1"></head><body><p>caf',
			),
			Buffer.from([0xe9]),
			Buffer.from(" cr"),
			Buffer.from([0xe8]),
			Buffer.from("me</p></body></html>"),
		]),
	)
	return dir
}

// The URL boundary all three commands share now lives in trove-url.test.ts.

describe("remixTrove", () => {
	it("runs the standard's checker over the parent — the third position", async () => {
		// "One checker, three positions" was asserted in the standard, the README
		// and the repo's own AGENTS.md while remix called it in none of them.
		const destDir = path.join(
			mkdtempSync(path.join(os.tmpdir(), "trove-remix-chk-")),
			"r",
		)
		const { report } = await remixTrove({ destDir, troveUrl })
		expect(report.ok).toBe(true)
		// files/caps are not-checked HERE on purpose: remix verifies every file's
		// digest itself as it writes it, so running check 4 too would fetch the
		// whole trove twice to answer the same question.
		expect(
			report.checks.filter((check) => check.status === "not-checked").map((c) => c.name),
		).toEqual(["files", "caps"])
	})

	it("warns but still completes when the parent does not conform", async () => {
		// Owner-ruled: forking something slightly broken in order to fix it is
		// legitimate, so a failing check must not gate the remix — it must be
		// impossible to miss instead. Dropping the header changes no bytes, so
		// every digest still matches and the copy still succeeds.
		noindex = false
		try {
			const destDir = path.join(
				mkdtempSync(path.join(os.tmpdir(), "trove-remix-warn-")),
				"r",
			)
			const { fileCount, report } = await remixTrove({ destDir, troveUrl })
			// It completed: the remix is not gated on conformance.
			expect(fileCount).toBe(3)
			expect(readFileSync(path.join(destDir, "data.csv"), "utf8")).toBe("a,b\n1,2\n")
			// And it said so loudly enough for the caller to act on.
			expect(report.ok).toBe(false)
			const banner = describeNonConformance(troveUrl, report)
			expect(banner).toContain("DOES NOT CONFORM")
			expect(banner).toContain("noindex")
			expect(banner).toContain("trove verify")
		} finally {
			noindex = true
		}
	})

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

	it("preserves a non-UTF-8 parent page except for clearing its inherited identity", async () => {
		const destDir = path.join(
			mkdtempSync(path.join(os.tmpdir(), "trove-remix-latin1-")),
			"r",
		)
		await remixTrove({ destDir, troveUrl })

		const parent = readFileSync(path.join(assembledDir, "index.html"))
		const inheritedIdentity = Buffer.from(`data-trove="${troveId}"`)
		const identityStart = parent.indexOf(inheritedIdentity)
		expect(identityStart).toBeGreaterThanOrEqual(0)
		const expected = Buffer.concat([
			parent.subarray(0, identityStart),
			Buffer.from('data-trove=""'),
			parent.subarray(identityStart + inheritedIdentity.byteLength),
		])
		const remixed = readFileSync(path.join(destDir, "index.html"))

		expect(remixed.equals(expected)).toBe(true)
		expect(remixed.includes(Buffer.from([0xe9]))).toBe(true)
		expect(remixed.includes(Buffer.from([0xe8]))).toBe(true)
		expect(remixed.includes(Buffer.from("�", "utf8"))).toBe(false)
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
