import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
	checkTrove,
	MANDATED_SCRIPT_TAG,
	manifestSchema,
	mintId,
} from "@usecontextlayer/trove-standard"
import { describe, expect, it } from "vitest"
import { assembleTrove, REMIX_MARKER_FILE } from "@/src/assemble"
import { localReader } from "@/src/local-reader"

function makeSourceDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "trove-test-src-"))
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
		writeFileSync(path.join(dir, file), content)
	}
	return dir
}

function destDir(): string {
	return path.join(mkdtempSync(path.join(os.tmpdir(), "trove-test-dest-")), "trove")
}

const AGENTS = "# Test trove\n\nA test trove.\n"

describe("assembleTrove", () => {
	it("assembles a conformant trove from a bare folder", async () => {
		const id = mintId()
		const dest = destDir()
		const manifest = assembleTrove({
			destDir: dest,
			id,
			sourceDir: makeSourceDir({ "AGENTS.md": AGENTS, "data.csv": "a,b\n1,2\n" }),
		})

		// The assembled output passes the standard's own §6.1 checker through the
		// local adapter — assembly and certification can never drift.
		const { report } = await checkTrove({ expectedId: id, read: localReader(dest) })
		expect(report.checks.filter((check) => !check.ok)).toEqual([])

		// The manifest round-trips through the standard's own schema.
		expect(manifestSchema.parse(manifest).id).toBe(id)

		// Membership rule: "/" listed (not /index.html); trove.json and
		// _headers excluded; every listed digest matches the bytes on disk.
		const paths = manifest.files.map((file) => file.path)
		expect(paths).toContain("/")
		expect(paths).toContain("/AGENTS.md")
		expect(paths).toContain("/data.csv")
		expect(paths).not.toContain("/index.html")
		expect(paths).not.toContain("/trove.json")
		expect(paths).not.toContain("/_headers")
		for (const file of manifest.files) {
			const onDisk = readFileSync(
				path.join(dest, file.path === "/" ? "index.html" : file.path.slice(1)),
			)
			const digest = `sha256:${createHash("sha256").update(onDisk).digest("hex")}`
			expect(file.digest).toBe(digest)
			expect(file.size).toBe(onDisk.byteLength)
		}

		// The generated page carries the block: the div with this id, the
		// byte-identical script tag, and no other hidden text.
		const html = readFileSync(path.join(dest, "index.html"), "utf8")
		expect(html).toContain(`data-trove="${id}"`)
		expect(html).toContain(MANDATED_SCRIPT_TAG)
		expect(html.match(/display:none/g)).toHaveLength(1)

		// Generated host headers.
		expect(readFileSync(path.join(dest, "_headers"), "utf8")).toContain(
			"X-Robots-Tag: noindex",
		)
	})

	it("injects the block into a creator-authored index.html", () => {
		const id = mintId()
		const dest = destDir()
		assembleTrove({
			destDir: dest,
			id,
			sourceDir: makeSourceDir({
				"AGENTS.md": AGENTS,
				"index.html": "<html><body><h1>Mine</h1></body></html>",
			}),
		})
		const html = readFileSync(path.join(dest, "index.html"), "utf8")
		expect(html).toContain("<h1>Mine</h1>")
		expect(html).toContain(`data-trove="${id}"`)
		const bodyClose = html.lastIndexOf("</body>")
		expect(html.indexOf(`data-trove="${id}"`)).toBeLessThan(bodyClose)
	})

	it("replaces a remix-cleared block instead of stacking a second one", () => {
		// A remixed index.html carries the parent's block with data-trove="".
		const parentId = mintId()
		const firstDest = destDir()
		assembleTrove({
			destDir: firstDest,
			id: parentId,
			sourceDir: makeSourceDir({ "AGENTS.md": AGENTS }),
		})
		const remixed = readFileSync(path.join(firstDest, "index.html"), "utf8").replace(
			/data-trove="[^"]*"/,
			'data-trove=""',
		)

		const childId = mintId()
		const secondDest = destDir()
		assembleTrove({
			destDir: secondDest,
			id: childId,
			sourceDir: makeSourceDir({ "AGENTS.md": AGENTS, "index.html": remixed }),
		})
		const html = readFileSync(path.join(secondDest, "index.html"), "utf8")
		expect(html.match(/data-trove=/g)).toHaveLength(1)
		expect(html).toContain(`data-trove="${childId}"`)
		expect(html.match(/<script src=/g)).toHaveLength(1)
	})

	it("records lineage from a remix marker", () => {
		const id = mintId()
		const parent = "https://trove.usecontextlayer.com/a/0123456789abcdefghjkmnpq"
		const parentDigest = `sha256:${"a".repeat(64)}`
		const manifest = assembleTrove({
			destDir: destDir(),
			id,
			parent,
			parentDigest,
			sourceDir: makeSourceDir({ "AGENTS.md": AGENTS }),
		})
		expect(manifest.parent).toBe(parent)
		expect(manifest.parentDigest).toBe(parentDigest)
	})

	it("excludes the remix marker from trove content", () => {
		const manifest = assembleTrove({
			destDir: destDir(),
			id: mintId(),
			sourceDir: makeSourceDir({
				"AGENTS.md": AGENTS,
				[REMIX_MARKER_FILE]: '{"parent":"x","parentDigest":"y"}',
			}),
		})
		expect(manifest.files.map((file) => file.path)).not.toContain(`/${REMIX_MARKER_FILE}`)
	})

	it("serves dotfile paths like .well-known", () => {
		const manifest = assembleTrove({
			destDir: destDir(),
			id: mintId(),
			sourceDir: makeSourceDir({
				".well-known/thing.json": "{}",
				"AGENTS.md": AGENTS,
			}),
		})
		expect(manifest.files.map((file) => file.path)).toContain("/.well-known/thing.json")
	})

	it("fails loudly without AGENTS.md", () => {
		expect(() =>
			assembleTrove({
				destDir: destDir(),
				id: mintId(),
				sourceDir: makeSourceDir({ "data.csv": "a\n" }),
			}),
		).toThrow(/AGENTS\.md/)
	})

	it("fails loudly on a creator-authored _headers", () => {
		expect(() =>
			assembleTrove({
				destDir: destDir(),
				id: mintId(),
				sourceDir: makeSourceDir({ _headers: "/*\n  X: y\n", "AGENTS.md": AGENTS }),
			}),
		).toThrow(/_headers/)
	})

	it("fails loudly on a file with no resolvable media type", () => {
		expect(() =>
			assembleTrove({
				destDir: destDir(),
				id: mintId(),
				sourceDir: makeSourceDir({ "AGENTS.md": AGENTS, noextension: "data" }),
			}),
		).toThrow(/media type/)
	})
})
