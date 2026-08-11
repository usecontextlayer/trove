import { SELF } from "cloudflare:test"
import { canonicalUrlForId, mintId } from "@usecontextlayer/trove-standard"
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
			canonical: canonicalUrlForId(fixtureId),
			hostUrl: fixtureHost,
			id: fixtureId,
			parent: null,
			standard: 1,
		})
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

describe("GET /a/<id> subtree", () => {
	it("302s the bare id to the host root", async () => {
		await registerFixture()
		const response = await SELF.fetch(`${REGISTRY}/a/${fixtureId}`, {
			redirect: "manual",
		})
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe(`${fixtureHost}/`)
		expect(response.headers.get("x-robots-tag")).toBe("noindex")
	})

	it("302s a subtree path to the same path on the host", async () => {
		await registerFixture()
		const response = await SELF.fetch(`${REGISTRY}/a/${fixtureId}/data.csv`, {
			redirect: "manual",
		})
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe(`${fixtureHost}/data.csv`)
	})

	it("makes the canonical URL usable as a trove base URL", async () => {
		// §7: an agent handed only a canonical URL can perform every read the
		// standard defines — the redirect must land on the real served bytes.
		await registerFixture()
		const redirect = await SELF.fetch(`${REGISTRY}/a/${fixtureId}/trove.json`, {
			redirect: "manual",
		})
		expect(redirect.status).toBe(302)
		// Follow with global fetch — SELF always dispatches to the registry
		// Worker; the host bytes live on the (outbound-routed) fixture host.
		const followed = await fetch(redirect.headers.get("location") ?? "")
		expect(followed.status).toBe(200)
		const manifest = (await followed.json()) as Record<string, unknown>
		expect(manifest.id).toBe(fixtureId)
	})

	it("404s an unknown id", async () => {
		const response = await SELF.fetch(`${REGISTRY}/a/${mintId()}`, {
			redirect: "manual",
		})
		expect(response.status).toBe(404)
	})
})

describe("fallthrough", () => {
	it("404s unmatched worker paths with noindex", async () => {
		const response = await SELF.fetch(`${REGISTRY}/nope`)
		expect(response.status).toBe(404)
		expect(response.headers.get("x-robots-tag")).toBe("noindex")
	})
})
