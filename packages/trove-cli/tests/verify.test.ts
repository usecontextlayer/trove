import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { mintId } from "@usecontextlayer/trove-standard"
import mime from "mime"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { assembleTrove } from "@/src/assemble"
import {
	describeVerdict,
	parseVerifyTarget,
	type VerifyResult,
	verify,
} from "@/src/verify"

const REGISTRY = "https://trove.usecontextlayer.com"

// verify's far side is a real trove served over real HTTP by a local server, and
// the trove is built by assembleTrove — digests, mandated block and all — rather
// than hand-written. A hand-authored fixture here would be a guess about our own
// format, and the point of this command is to be the thing that does not guess.

const troveId = mintId()
let server: http.Server
let troveUrl: string
let assembledDir: string
/** Dropped by one test: it fails check 5 without altering a byte. */
let noindex = true

beforeAll(async () => {
	assembledDir = path.join(mkdtempSync(path.join(os.tmpdir(), "trove-verify-src-")), "a")
	const source = mkdtempSync(path.join(os.tmpdir(), "trove-verify-origin-"))
	writeFileSync(path.join(source, "AGENTS.md"), "# Verifiable\n\nCheck me.\n")
	writeFileSync(path.join(source, "data.csv"), "a,b\n1,2\n")
	assembleTrove({ destDir: assembledDir, id: troveId, sourceDir: source })

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

afterEach(() => {
	vi.restoreAllMocks()
	noindex = true
	// verify signals through the exit code; left set it would fail the run.
	process.exitCode = 0
})

describe("parseVerifyTarget", () => {
	// One command over two input types, so the discrimination has to be
	// unambiguous rather than clever. The scheme is what decides it.
	it("reads an http(s) URL as a live trove", () => {
		expect(
			parseVerifyTarget(REGISTRY, "https://trove-abc.some-account.workers.dev"),
		).toEqual({ kind: "url", troveUrl: "https://trove-abc.some-account.workers.dev" })
	})

	it("reads an existing directory as a folder", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "trove-verify-target-"))
		expect(parseVerifyTarget(REGISTRY, dir)).toEqual({ folder: dir, kind: "folder" })
	})

	it("still refuses a registry URL, which is neither", () => {
		expect(() => parseVerifyTarget(REGISTRY, `${REGISTRY}/a/${troveId}`)).toThrow(
			/hostUrl/,
		)
	})

	// The likeliest real mistake: a URL with the scheme left off. It is not a URL
	// and not a directory either, so an error naming only one of those sends the
	// reader looking in the wrong place.
	it("names BOTH readings when the argument is neither", () => {
		expect(() => parseVerifyTarget(REGISTRY, "trove-abc.workers.dev")).toThrow(
			/neither a folder that exists nor an http\(s\) URL/,
		)
		expect(() => parseVerifyTarget(REGISTRY, "trove-abc.workers.dev")).toThrow(
			/https:\/\/trove-abc\.workers\.dev/,
		)
	})
})

/** The verdict for one named check — what these tests are actually about. */
function statusOf(result: VerifyResult, name: string): string | undefined {
	return result.report.checks.find((check) => check.name === name)?.status
}

describe("verify", () => {
	it("passes a conformant trove and reports on all seven checks", async () => {
		const result = await verify({ registryUrl: REGISTRY, target: troveUrl })
		expect(result.report.ok).toBe(true)
		expect(result.subject).toBe(troveUrl)
		// Every check named, so the verdict says what it checked rather than only
		// what failed — the reader's whole picture of a stranger's trove.
		expect(result.report.checks.map((check) => check.name).sort()).toEqual(
			[
				"agents-md",
				"anti-cloaking",
				"caps",
				"files",
				"manifest",
				"mandated-block",
				"noindex",
			].sort(),
		)
	})

	it("VERIFIES the files, where the registry position declines to", async () => {
		// The registry reports files/caps as not-checked on purpose. A reader is
		// the position about to trust the bytes, so here they must actually run —
		// this is the difference that makes the command worth having, and
		// asserting the status is the only way to see it.
		const result = await verify({ registryUrl: REGISTRY, target: troveUrl })
		expect(statusOf(result, "files")).toBe("ok")
		expect(statusOf(result, "caps")).toBe("ok")
	})

	it("fails the FILES check specifically on a tampered file", async () => {
		const original = readFileSync(path.join(assembledDir, "data.csv"))
		writeFileSync(path.join(assembledDir, "data.csv"), "tampered\n")
		try {
			const result = await verify({ registryUrl: REGISTRY, target: troveUrl })
			expect(result.report.ok).toBe(false)
			// Which check caught it, not merely that something did.
			expect(statusOf(result, "files")).toBe("failed")
			expect(statusOf(result, "agents-md")).toBe("ok")
		} finally {
			writeFileSync(path.join(assembledDir, "data.csv"), original)
		}
	})

	it("fails the NOINDEX check on a trove whose bytes are all correct", async () => {
		// Every digest still matches. A digest-only check — which is what a
		// reader hand-rolls — passes this trove; the standard does not.
		noindex = false
		const result = await verify({ registryUrl: REGISTRY, target: troveUrl })
		expect(result.report.ok).toBe(false)
		expect(statusOf(result, "noindex")).toBe("failed")
		expect(statusOf(result, "files")).toBe("ok")
	})

	it("checks a FOLDER by assembling and serving it, exactly as publish would", async () => {
		// The other half of the command, and the half no test reached before: a
		// folder carries no mandated block and no manifest until assembly makes
		// them, so this answers "what would ship" rather than "what is on disk".
		const source = mkdtempSync(path.join(os.tmpdir(), "trove-verify-folder-"))
		writeFileSync(path.join(source, "AGENTS.md"), "# Folder\n\nCheck me first.\n")
		writeFileSync(path.join(source, "data.csv"), "a,b\n1,2\n")

		const result = await verify({ registryUrl: REGISTRY, target: source })
		expect(result.report.ok).toBe(true)
		expect(statusOf(result, "mandated-block")).toBe("ok")
		expect(statusOf(result, "files")).toBe("ok")
		expect(result.subject).toContain(source)
		// Strictly MORE than waitUntilServing's own 60s budget. Equal to it, the
		// runner kills the test at the same moment the code would have failed
		// with the last response it saw — so the loud error is unreachable and
		// every slow boot reports as an unexplained "Test timed out".
	}, 120_000)

	it("waits out a trove that is still propagating instead of failing it", async () => {
		// A fresh deployment flaps rather than coming up: measured, /trove.json
		// answered 200,404,200,200,404,200 at three-second intervals, and a
		// single-read check reported a healthy trove as broken. publish and
		// register both poll through this; verify now polls on the same terms.
		let attempts = 0
		const flapping = http.createServer((request, response) => {
			const trovePath = request.url || "/"
			if (trovePath === "/") {
				attempts += 1
				if (attempts < 3) {
					response.writeHead(503).end()
					return
				}
			}
			const file = trovePath === "/" ? "index.html" : trovePath.slice(1)
			try {
				const body = readFileSync(path.join(assembledDir, file))
				response
					.writeHead(200, {
						"content-type": mime.getType(file) ?? "application/octet-stream",
						"x-robots-tag": "noindex",
					})
					.end(body)
			} catch {
				response.writeHead(404).end()
			}
		})
		await new Promise<void>((resolve) => flapping.listen(0, "127.0.0.1", resolve))
		const address = flapping.address()
		if (address === null || typeof address === "string") {
			throw new Error("server did not bind a port")
		}

		const result = await verify({
			registryUrl: REGISTRY,
			target: `http://127.0.0.1:${address.port}`,
		})

		expect(attempts).toBeGreaterThanOrEqual(3)
		expect(result.report.ok).toBe(true)
		flapping.close()
	}, 120_000)

	it("says nothing is THERE, rather than calling an absent trove non-conformant", async () => {
		// A URL with nothing behind it is not a trove that fails seven checks.
		// The clock is faked because reaching this message costs the full poll.
		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch
		vi.useFakeTimers()
		try {
			const attempt = verify({
				registryUrl: REGISTRY,
				target: "https://trove-gone.example.workers.dev",
			}).then(
				() => new Error("verify resolved against a URL serving nothing"),
				(error: unknown) => error,
			)
			await vi.advanceTimersByTimeAsync(60_000)
			const thrown = String(await attempt)

			expect(thrown).toMatch(/nothing is serving a trove/)
			expect(thrown).not.toMatch(/does NOT conform/)
			// The likeliest real cause, named: an unclaimed preview that expired.
			expect(thrown).toMatch(/60 minutes/)
		} finally {
			vi.useRealTimers()
			globalThis.fetch = realFetch
		}
	})

	it("scopes a PASSING verdict to the format, so it cannot be read as a quality one", () => {
		// A trove of raw files behind a 14-byte placeholder manual passes all
		// seven checks — correctly, since check 3 asks only that AGENTS.md be
		// non-empty. The reader deciding whether to stop looking must not take
		// the tick for more than it is.
		const rendered = describeVerdict({
			report: { checks: [{ name: "agents-md", status: "ok" }], ok: true },
			subject: "https://trove-abc.example.workers.dev",
		})
		expect(rendered).toContain("conforms")
		expect(rendered).toMatch(/format verdict, not a quality one/)
	})

	it("renders the verdict for a reader", () => {
		const rendered = describeVerdict({
			report: { checks: [{ name: "noindex", status: "failed" }], ok: false },
			subject: "https://trove-abc.example.workers.dev",
		})
		expect(rendered).toContain("https://trove-abc.example.workers.dev")
		expect(rendered).toContain("noindex")
		expect(rendered).toContain("does NOT conform")
	})
})
