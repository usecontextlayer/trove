import { SELF } from "cloudflare:test"
import { CURRENT_STANDARD, mintId } from "@usecontextlayer/trove-standard"
import { describe, expect, inject, it } from "vitest"

const REGISTRY = "https://trove.usecontextlayer.com"

const fixtureId = inject("fixtureTroveId")
const fixtureHost = inject("fixtureHostUrl")
const fixtureMirrorHost = inject("fixtureMirrorHostUrl")

async function registerFixture(): Promise<Response> {
	return SELF.fetch(`${REGISTRY}/register`, {
		body: JSON.stringify({ hostUrl: fixtureHost, id: fixtureId }),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
}

describe("POST /register", () => {
	it("registers a conformant trove and returns its record", async () => {
		const response = await registerFixture()
		expect(response.status).toBe(201)
		expect(response.headers.get("x-robots-tag")).toBe("noindex")
		const record = (await response.json()) as Record<string, unknown>
		expect(record).toMatchObject({
			hostUrl: fixtureHost,
			id: fixtureId,
			parent: null,
			standard: CURRENT_STANDARD,
		})
		// The record names no canonical URL, because a trove has none: its
		// hostUrl IS its address, and this record is an observation about it.
		expect(record).not.toHaveProperty("canonical")
		expect(record.registeredAt).toBeTruthy()
	})

	it("re-registers the same host as an upsert, keeping registeredAt", async () => {
		const first = await registerFixture()
		const firstRecord = (await first.json()) as Record<string, unknown>
		const second = await registerFixture()
		expect(second.status).toBe(200)
		const secondRecord = (await second.json()) as Record<string, unknown>
		expect(secondRecord.registeredAt).toBe(firstRecord.registeredAt)
	})

	it("rejects re-pointing an id at a mirror serving the same bytes", async () => {
		// §7's copy-and-re-point attack: the mirror serves a byte-identical
		// trove (so control-proof passes), but the id is permanently bound to
		// its first host.
		await registerFixture()
		const response = await SELF.fetch(`${REGISTRY}/register`, {
			body: JSON.stringify({ hostUrl: fixtureMirrorHost, id: fixtureId }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(response.status).toBe(409)
	})

	it("rejects an id the hosted trove does not carry", async () => {
		const response = await SELF.fetch(`${REGISTRY}/register`, {
			body: JSON.stringify({ hostUrl: fixtureHost, id: mintId() }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(response.status).toBe(409)
	})

	it.each([
		["a non-workers.dev host", "https://example.com"],
		["a lookalike host", "https://evilworkers.dev"],
		["an http host", "http://real.workers.dev"],
		["a host with a path", "https://real.workers.dev/sub"],
	])("rejects %s", async (_label, hostUrl) => {
		const response = await SELF.fetch(`${REGISTRY}/register`, {
			body: JSON.stringify({ hostUrl, id: fixtureId }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(response.status).toBe(400)
	})

	it("rejects a malformed body", async () => {
		const response = await SELF.fetch(`${REGISTRY}/register`, {
			body: JSON.stringify({ id: "nope" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(response.status).toBe(400)
	})

	it("rejects non-POST methods", async () => {
		const response = await SELF.fetch(`${REGISTRY}/register`)
		expect(response.status).toBe(405)
		expect(response.headers.get("allow")).toBe("POST")
	})
})

describe("GET /a/<id>.json", () => {
	it("serves the public record with CORS", async () => {
		await registerFixture()
		const response = await SELF.fetch(`${REGISTRY}/a/${fixtureId}.json`)
		expect(response.status).toBe(200)
		expect(response.headers.get("access-control-allow-origin")).toBe("*")
		expect(response.headers.get("x-robots-tag")).toBe("noindex")
		const record = (await response.json()) as Record<string, unknown>
		expect(record).toMatchObject({ hostUrl: fixtureHost, id: fixtureId })
	})

	it("answers OPTIONS preflight", async () => {
		const response = await SELF.fetch(`${REGISTRY}/a/${fixtureId}.json`, {
			method: "OPTIONS",
		})
		expect(response.status).toBe(204)
		expect(response.headers.get("access-control-allow-origin")).toBe("*")
		expect(response.headers.get("access-control-allow-methods")).toContain("GET")
	})

	it("404s an unknown id", async () => {
		const response = await SELF.fetch(`${REGISTRY}/a/${mintId()}.json`)
		expect(response.status).toBe(404)
	})
})

describe("GET /a/<id> — the id lookup", () => {
	it("302s the bare id to the trove", async () => {
		await registerFixture()
		const response = await SELF.fetch(`${REGISTRY}/a/${fixtureId}`, {
			redirect: "manual",
		})
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe(fixtureHost)
		expect(response.headers.get("x-robots-tag")).toBe("noindex")
	})

	it("404s an unknown id", async () => {
		const response = await SELF.fetch(`${REGISTRY}/a/${mintId()}`, {
			redirect: "manual",
		})
		expect(response.status).toBe(404)
	})

	// The subtree route is GONE, and these pin its absence rather than its
	// containment. While it existed, a trove's page was reachable at two
	// origins, so the root-relative links in the page the CLI generates
	// resolved against OURS — where /AGENTS.md and /trove.json are the
	// platform's own files and answer 200 with the wrong document, silently, on
	// exactly the two paths the read protocol depends on.
	//
	// Deleting the route also deleted an open-redirect class outright. Every
	// case below was previously a containment test: forwarding an
	// attacker-supplied subpath made "/a/<id>//elsewhere.example/x" a live open
	// redirect on this domain, reachable with nothing but a published trove id.
	// A route that forwards no path cannot leak one, so the assertion is now
	// simply that nothing is there.
	it.each([
		["a plain subpath", "/data.csv"],
		["the manifest path", "/trove.json"],
		["the manual path", "/AGENTS.md"],
		["a doubled slash", "//elsewhere.example/x"],
		["a backslash authority", "/\\elsewhere.example/x"],
		["a doubled slash carrying a query", "//elsewhere.example/x?a=1"],
		["a bare doubled slash", "//"],
	])("404s %s under a registered id, redirecting nowhere", async (_label, subpath) => {
		await registerFixture()
		const response = await SELF.fetch(`${REGISTRY}/a/${fixtureId}${subpath}`, {
			redirect: "manual",
		})
		expect(response.status).toBe(404)
		expect(response.headers.get("location")).toBeNull()
	})
})

describe("fallthrough", () => {
	it("404s unmatched worker paths with noindex", async () => {
		const response = await SELF.fetch(`${REGISTRY}/nope`)
		expect(response.status).toBe(404)
		expect(response.headers.get("x-robots-tag")).toBe("noindex")
	})
})
