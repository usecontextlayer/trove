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
		expect(report.checks.filter((check) => check.status === "failed")).toEqual([])
		expect(report.ok).toBe(true)

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

	it.each([
		["one", "İstanbul"],
		["three", "İstanbul, İzmir, İnegöl"],
		// Seven is exactly "</body>".length — the skew that moved the block
		// outside the body while leaving the tag looking intact.
		["seven", "İİİİİİİ"],
	])(
		"keeps the closing tag intact with %s dotted capital I in the body",
		(_label, text) => {
			// `toLowerCase` is not length-preserving: "İ" becomes two code units, so
			// an index computed on the lowered copy and applied to the original cut
			// the closing tag apart. The corrupted page rendered a literal "/body>"
			// to every visitor and still passed all seven checks.
			const id = mintId()
			const dest = destDir()
			assembleTrove({
				destDir: dest,
				id,
				sourceDir: makeSourceDir({
					"AGENTS.md": AGENTS,
					"index.html": `<!doctype html>\n<html lang="tr">\n<body>\n<p>${text}</p>\n</body>\n</html>\n`,
				}),
			})
			const html = readFileSync(path.join(dest, "index.html"), "utf8")
			expect(html).toContain("</body>")
			expect(html).not.toContain("/body>\n</html>\n/body>")
			expect(html.indexOf(`data-trove="${id}"`)).toBeLessThan(html.lastIndexOf("</body>"))
			expect(html).toContain(`<p>${text}</p>`)
		},
	)

	it.each([
		["a data-trove-prefixed attribute", '<div data-trove-count="3">Three troves</div>'],
		["a bare data-trove-prefixed attribute", "<div data-troves>All my troves</div>"],
		[
			"a nested div inside one",
			'<div data-trove-count="3"><span>Three</span><div class="inner">nested</div>tail</div>',
		],
	])("preserves the creator's own %s", (_label, markup) => {
		// The strip regex had no attribute-name boundary, so any `data-trove*`
		// div was deleted from the published page — and its non-greedy `</div>`
		// stop left an orphan closing tag behind when the div had a nested one.
		const dest = destDir()
		assembleTrove({
			destDir: dest,
			id: mintId(),
			sourceDir: makeSourceDir({
				"AGENTS.md": AGENTS,
				"index.html": `<html><body><h1>Mine</h1>${markup}</body></html>`,
			}),
		})
		const html = readFileSync(path.join(dest, "index.html"), "utf8")
		expect(html).toContain(markup)
	})

	it("preserves a non-UTF-8 index.html byte for byte", () => {
		// index.html is the one file that round-trips through a JS string.
		// Reading it as "utf8" replaced every non-UTF-8 byte with U+FFFD, and
		// the manifest digest was then computed over the mojibake — so a
		// corrupted page shipped with all seven checks green.
		const dir = mkdtempSync(path.join(os.tmpdir(), "trove-test-latin1-"))
		writeFileSync(path.join(dir, "AGENTS.md"), AGENTS)
		// "café crème" in ISO-8859-1: 0xe9 and 0xe8 are not valid UTF-8.
		const source = Buffer.concat([
			Buffer.from(
				'<!doctype html>\n<html><head><meta charset="iso-8859-1"></head><body><p>caf',
			),
			Buffer.from([0xe9]),
			Buffer.from(" cr"),
			Buffer.from([0xe8]),
			Buffer.from("me</p>\n</body>\n</html>\n"),
		])
		writeFileSync(path.join(dir, "index.html"), source)

		const dest = destDir()
		const manifest = assembleTrove({ destDir: dest, id: mintId(), sourceDir: dir })
		const out = readFileSync(path.join(dest, "index.html"))
		expect(out.includes(Buffer.from([0xe9]))).toBe(true)
		expect(out.includes(Buffer.from([0xe8]))).toBe(true)
		expect(out.includes(Buffer.from("�", "utf8"))).toBe(false)

		// And the manifest describes the bytes that are actually on disk.
		const entry = manifest.files.find((file) => file.path === "/")
		expect(entry?.size).toBe(out.byteLength)
		expect(entry?.digest).toBe(`sha256:${createHash("sha256").update(out).digest("hex")}`)
	})

	it("escapes markup in the AGENTS.md heading it lifts into the generated page", () => {
		// After a remix the heading is a STRANGER's prose, and the generated
		// page is what a folder without its own index.html gets.
		const dest = destDir()
		assembleTrove({
			destDir: dest,
			id: mintId(),
			sourceDir: makeSourceDir({
				"AGENTS.md": '# Recipes <script>fetch("https://evil.example")</script>\n',
			}),
		})
		const html = readFileSync(path.join(dest, "index.html"), "utf8")
		expect(html).not.toContain("<script>fetch")
		expect(html).toContain("&lt;script&gt;")
	})
})
