import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { mintId } from "@usecontextlayer/trove-standard"
import mime from "mime"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { assembleTrove } from "@/src/assemble"
import { parseVerifyTarget, verify } from "@/src/verify"

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

describe("verify", () => {
	it("passes a conformant trove, printing every verdict and exiting zero", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		await verify({ registryUrl: REGISTRY, target: troveUrl })

		const printed = log.mock.calls.map((call) => String(call[0])).join("\n")
		// All seven named, so the report says what it checked rather than only
		// what failed — this is the reader's whole picture of a stranger's trove.
		for (const name of [
			"mandated-block",
			"manifest",
			"agents-md",
			"files",
			"noindex",
			"caps",
			"anti-cloaking",
		]) {
			expect(printed).toContain(name)
		}
		expect(printed).toContain("conforms to the trove standard")
		expect(process.exitCode).toBeFalsy()
	})

	it("verifies the FILES, unlike the registry position", async () => {
		// The registry deliberately reports files/caps as not-checked. A reader is
		// the position that is about to trust the bytes, so here they must run —
		// this is the difference that makes the command worth having.
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		await verify({ registryUrl: REGISTRY, target: troveUrl })
		const printed = log.mock.calls.map((call) => String(call[0])).join("\n")
		expect(printed).not.toContain("----  files")
		expect(printed).not.toContain("this position does not verify manifest files")
	})

	it("fails, says which check, and exits non-zero on a tampered file", async () => {
		const original = readFileSync(path.join(assembledDir, "data.csv"))
		writeFileSync(path.join(assembledDir, "data.csv"), "tampered\n")
		try {
			const log = vi.spyOn(console, "log").mockImplementation(() => {})
			await verify({ registryUrl: REGISTRY, target: troveUrl })
			const printed = log.mock.calls.map((call) => String(call[0])).join("\n")
			expect(printed).toContain("FAIL")
			expect(printed).toContain("files")
			expect(printed).toContain("does NOT conform")
			expect(process.exitCode).toBe(1)
		} finally {
			writeFileSync(path.join(assembledDir, "data.csv"), original)
		}
	})

	it("fails on a trove that serves the right bytes without the noindex header", async () => {
		// Every digest still matches here. A digest-only check — which is what a
		// reader hand-rolls — passes this trove; the standard does not.
		noindex = false
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		await verify({ registryUrl: REGISTRY, target: troveUrl })
		const printed = log.mock.calls.map((call) => String(call[0])).join("\n")
		expect(printed).toContain("noindex")
		expect(printed).toContain("does NOT conform")
		expect(process.exitCode).toBe(1)
	})
})
