import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import type { ContractCheckReport } from "@usecontextlayer/trove-standard"
import { mintId, recordUrlForId } from "@usecontextlayer/trove-standard"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { assembleTrove } from "@/src/assemble"
import { parseHostUrl, register } from "@/src/register"
import { summarizeReport } from "@/src/report"

// The far side of `register` is our own registry's HTTP contract, exercised
// against a REAL assembled trove (built by assembleTrove, digests and all)
// served by a real local server — the state the registry sees. The registry
// half is a stand-in for OUR OWN seam, anchored by the registry package's
// suite, which runs the real handler in real workerd.

const troveId = mintId()
let server: http.Server
let hostUrl: string
let registryUrl: string
let assembledDir: string

/** What the fake registry answers next, and what it last received. */
let nextReply: { body: unknown; status: number }
let lastRegisterBody: unknown

const PASSING: ContractCheckReport = {
	checks: [
		{ name: "mandated-block", status: "ok" },
		{ name: "manifest", status: "ok" },
		{ name: "agents-md", status: "ok" },
		{
			detail: "this position does not verify manifest files",
			name: "files",
			status: "not-checked",
		},
		{ name: "noindex", status: "ok" },
		{
			detail: "this position does not verify manifest files",
			name: "caps",
			status: "not-checked",
		},
		{ name: "anti-cloaking", status: "ok" },
	],
	ok: true,
}

function recordFor(report: ContractCheckReport): unknown {
	return {
		contractCheck: { checkedAt: "2026-08-11T00:00:00.000Z", ...report },
		hostUrl,
		id: troveId,
		parent: null,
		registeredAt: "2026-08-11T00:00:00.000Z",
		standard: 1,
	}
}

beforeAll(async () => {
	assembledDir = path.join(
		mkdtempSync(path.join(os.tmpdir(), "trove-register-src-")),
		"a",
	)
	const source = mkdtempSync(path.join(os.tmpdir(), "trove-register-origin-"))
	writeFileSync(path.join(source, "AGENTS.md"), "# Registerable\n\nRegister me.\n")
	assembleTrove({ destDir: assembledDir, id: troveId, sourceDir: source })

	server = http.createServer((request, response) => {
		if (request.method === "POST" && request.url === "/register") {
			const chunks: Buffer[] = []
			request.on("data", (chunk: Buffer) => chunks.push(chunk))
			request.on("end", () => {
				lastRegisterBody = JSON.parse(Buffer.concat(chunks).toString("utf8"))
				response
					.writeHead(nextReply.status, { "content-type": "application/json" })
					.end(JSON.stringify(nextReply.body))
			})
			return
		}
		const file = request.url === "/" ? "index.html" : (request.url ?? "").slice(1)
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
	// One server plays both roles; the registry origin differs from the host
	// origin in production, and parseHostUrl is tested against that separately.
	hostUrl = `http://127.0.0.1:${address.port}`
	registryUrl = "https://trove.usecontextlayer.com"
	nextReply = { body: recordFor(PASSING), status: 201 }
})

afterAll(() => {
	server.close()
})

afterEach(() => {
	vi.restoreAllMocks()
	// register() signals a non-conformant trove through the exit code; left
	// set, it would fail the whole vitest run.
	process.exitCode = 0
})

describe("parseHostUrl", () => {
	it("normalizes a host URL to its origin", () => {
		expect(parseHostUrl(registryUrl, "https://trove-abc.some-account.workers.dev/")).toBe(
			"https://trove-abc.some-account.workers.dev",
		)
	})

	it("rejects a registry URL, naming the trove URL publish printed", () => {
		expect(() =>
			parseHostUrl(registryUrl, `https://trove.usecontextlayer.com/a/${troveId}`),
		).toThrow(/trove's own URL/)
	})

	it("rejects something that is not a URL", () => {
		expect(() => parseHostUrl(registryUrl, "trove-abc.workers.dev")).toThrow(/not a URL/)
	})

	// Same boundary rule as remix's (§2.1), enforced rather than normalized:
	// returning the origin would accept one argument and act on another.
	it("rejects a trove URL carrying a path", () => {
		expect(() =>
			parseHostUrl(registryUrl, "https://trove-abc.some-account.workers.dev/foo"),
		).toThrow(/host root/)
	})
})

describe("register", () => {
	it("reads the id off the served trove, and prints the trove URL and the record", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		nextReply = { body: recordFor(PASSING), status: 201 }

		await register({ hostUrl, registryUrl: hostUrl })

		// The id came from the trove itself — nothing had to be carried in.
		expect(lastRegisterBody).toEqual({ hostUrl, id: troveId })
		const printed = log.mock.calls.map((call) => String(call[0])).join("\n")
		expect(printed).toContain(`trove: ${hostUrl}`)
		expect(printed).toContain(`record: ${recordUrlForId(troveId)}`)
		expect(process.exitCode).toBeFalsy()
	})

	it("registers a failing trove, but says so and exits non-zero", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {})
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const failing: ContractCheckReport = {
			checks: [
				{ detail: "GET / failed: status 403", name: "mandated-block", status: "failed" },
				{ name: "manifest", status: "ok" },
			],
			ok: false,
		}
		nextReply = { body: recordFor(failing), status: 201 }

		await register({ hostUrl, registryUrl: hostUrl })

		const complained = error.mock.calls.map((call) => String(call[0])).join("\n")
		expect(complained).toContain("FAILED")
		expect(complained).toContain("GET / failed: status 403")
		expect(process.exitCode).toBe(1)
	})

	it("surfaces the registry's own check report when it refuses", async () => {
		nextReply = {
			body: {
				error: "hostUrl does not serve a valid /trove.json",
				report: {
					checks: [
						{
							detail: "GET /trove.json failed: status 403",
							name: "manifest",
							status: "failed",
						},
					],
					ok: false,
				},
			},
			status: 422,
		}

		// The cause, not just the symptom: the top-line string alone sent a
		// creator to inspect a manifest that was perfect.
		await expect(register({ hostUrl, registryUrl: hostUrl })).rejects.toThrow(
			/GET \/trove\.json failed: status 403/,
		)
	})

	it("fails loudly when nothing is deployed at the host", async () => {
		const empty = http.createServer((_request, response) => {
			response.writeHead(404).end()
		})
		await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", resolve))
		const address = empty.address()
		if (address === null || typeof address === "string") {
			throw new Error("server did not bind a port")
		}
		await expect(
			register({ hostUrl: `http://127.0.0.1:${address.port}`, registryUrl }),
		).rejects.toThrow(/no trove to register/)
		empty.close()
	})
})

describe("summarizeReport", () => {
	it("counts not-checked separately from passed, so it never claims verification that did not happen", () => {
		expect(summarizeReport(PASSING)).toBe("5 passed, 2 not checked here")
	})
})
