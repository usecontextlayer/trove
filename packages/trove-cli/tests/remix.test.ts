import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { manifestSchema, mintId } from "@usecontextlayer/trove-standard"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assembleArtifact } from "@/src/assemble"
import { parseCanonicalUrl, readRemixMarker, remixArtifact } from "@/src/remix"

// The far side of remix is OUR OWN standard: a local server serving a
// REAL assembled artifact (built by assembleArtifact, digests and all) at
// canonical-shaped paths — the state a remixing agent sees after the
// registry's subtree redirect resolves.

const artifactId = mintId()
let server: http.Server
let registryUrl: string
let canonicalUrl: string
let assembledDir: string

beforeAll(async () => {
	assembledDir = path.join(mkdtempSync(path.join(os.tmpdir(), "trove-remix-src-")), "a")
	assembleArtifact({
		destDir: assembledDir,
		id: artifactId,
		sourceDir: makeSource(),
	})

	server = http.createServer((request, response) => {
		const prefix = `/a/${artifactId}`
		if (!request.url?.startsWith(prefix)) {
			response.writeHead(404).end()
			return
		}
		const artifactPath = request.url.slice(prefix.length) || "/"
		const file = artifactPath === "/" ? "index.html" : artifactPath.slice(1)
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
	registryUrl = `http://127.0.0.1:${address.port}`
	canonicalUrl = `${registryUrl}/a/${artifactId}`
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

describe("parseCanonicalUrl", () => {
	it("accepts a canonical URL", () => {
		expect(
			parseCanonicalUrl(
				"https://trove.usecontextlayer.com",
				`https://trove.usecontextlayer.com/a/${artifactId}`,
			),
		).toBe(`https://trove.usecontextlayer.com/a/${artifactId}`)
	})

	it("rejects a host URL, naming what canonical looks like", () => {
		expect(() =>
			parseCanonicalUrl(
				"https://trove.usecontextlayer.com",
				"https://trove-abc.some-account.workers.dev",
			),
		).toThrow(/canonical URL/)
	})
})

describe("remixArtifact", () => {
	it("fetches, verifies, strips identity, and records lineage", async () => {
		const destDir = path.join(
			mkdtempSync(path.join(os.tmpdir(), "trove-remix-out-")),
			"r",
		)
		const { fileCount } = await remixArtifact({ canonicalUrl, destDir })
		expect(fileCount).toBe(3)

		// Files landed and match the origin bytes.
		expect(readFileSync(path.join(destDir, "data.csv"), "utf8")).toBe("a,b\n1,2\n")

		// Inherited identity is stripped: the data-trove attribute is cleared
		// (the parent id lawfully remains in the block's TEXT until publish
		// strips the remnant block — the round-trip test covers that) and the
		// parent's trove.json was never written.
		const html = readFileSync(path.join(destDir, "index.html"), "utf8")
		expect(html).toContain('data-trove=""')
		expect(html).not.toContain(`data-trove="${artifactId}"`)
		expect(() => readFileSync(path.join(destDir, "trove.json"))).toThrow()

		// The marker pins the parent version: parentDigest is the hash of the
		// manifest bytes exactly as served.
		const marker = readRemixMarker(destDir)
		const servedManifest = readFileSync(path.join(assembledDir, "trove.json"))
		expect(marker).toEqual({
			parent: canonicalUrl,
			parentDigest: `sha256:${createHash("sha256").update(servedManifest).digest("hex")}`,
		})
	})

	it("round-trips: a remixed folder republishes with lineage", async () => {
		const destDir = path.join(
			mkdtempSync(path.join(os.tmpdir(), "trove-remix-out2-")),
			"r",
		)
		await remixArtifact({ canonicalUrl, destDir })
		const marker = readRemixMarker(destDir)
		if (marker === null) {
			throw new Error("marker missing")
		}

		const childId = mintId()
		const childDest = path.join(
			mkdtempSync(path.join(os.tmpdir(), "trove-remix-pub-")),
			"a",
		)
		const manifest = assembleArtifact({
			destDir: childDest,
			id: childId,
			parent: marker.parent,
			parentDigest: marker.parentDigest,
			sourceDir: destDir,
		})
		expect(manifestSchema.parse(manifest).parent).toBe(canonicalUrl)
		// The child's page carries the child's id, not the parent's.
		const html = readFileSync(path.join(childDest, "index.html"), "utf8")
		expect(html).toContain(`data-trove="${childId}"`)
		expect(html).not.toContain(artifactId)
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
			await expect(remixArtifact({ canonicalUrl, destDir })).rejects.toThrow(
				/do not trust it/,
			)
		} finally {
			writeFileSync(path.join(assembledDir, "data.csv"), original)
		}
	})
})
