import {
	canonicalUrlForId,
	ID_PATTERN,
	MANIFEST_PATH,
	manifestSchema,
} from "@usecontextlayer/trove-standard"
import { z } from "zod"
import type { Artifact } from "@/database"
import { createRegistryDb } from "@/database"

// The registry — the only server Trove operates. Its claim: "this URL conforms
// to the artifact standard." Three routes plus a redirect subtree; everything
// else this domain serves (/trove.js, /AGENTS.md, /skills/**) is a static asset
// that never invokes this Worker (see run_worker_first in wrangler.jsonc).
//
// `_headers` covers asset responses only, so every response constructed HERE
// must carry X-Robots-Tag: noindex itself — the standard makes noindex
// unconditional on every response (§5).

const REGISTER_PATTERN = new URLPattern({ pathname: "/register" })
const RECORD_PATTERN = new URLPattern({ pathname: "/a/:id.json" })
const ARTIFACT_PATTERN = new URLPattern({ pathname: "/a/:id" })
const SUBTREE_PATTERN = new URLPattern({ pathname: "/a/:id/*" })

const NOINDEX_HEADERS = { "x-robots-tag": "noindex" }
const CORS_HEADERS = { ...NOINDEX_HEADERS, "access-control-allow-origin": "*" }

const registerBodySchema = z.object({
	hostUrl: z.url(),
	id: z.string().regex(ID_PATTERN),
})

function json(
	status: number,
	body: unknown,
	headers: Record<string, string> = NOINDEX_HEADERS,
): Response {
	return Response.json(body, { headers, status })
}

/**
 * §7: hostUrl must be a Cloudflare Workers host, and artifacts live at a host
 * root (§2.1), so a hostUrl carrying a path, query, or fragment is malformed.
 * The explicit dot matters — a naive endsWith("workers.dev") would also accept
 * evilworkers.dev.
 */
function parseHostOrigin(hostUrl: string): string | null {
	const url = new URL(hostUrl)
	const isWorkersDev =
		url.hostname === "workers.dev" || url.hostname.endsWith(".workers.dev")
	const isRoot = url.pathname === "/" && url.search === "" && url.hash === ""
	if (url.protocol !== "https:" || !isWorkersDev || !isRoot) {
		return null
	}
	return url.origin
}

/** The public record served at /a/<id>.json — one row per artifact. */
function recordFromRow(row: Artifact): Record<string, unknown> {
	return {
		canonical: canonicalUrlForId(row.id),
		contractCheck: JSON.parse(row.contract_check),
		hostUrl: row.host_url,
		id: row.id,
		parent: row.parent,
		registeredAt: row.registered_at,
		standard: row.standard,
	}
}

async function register(request: Request, env: Env): Promise<Response> {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return json(400, { error: "request body must be JSON" })
	}
	const parsed = registerBodySchema.safeParse(body)
	if (!parsed.success) {
		return json(400, { error: `invalid body: ${z.prettifyError(parsed.error)}` })
	}
	const { hostUrl, id } = parsed.data

	const hostOrigin = parseHostOrigin(hostUrl)
	if (hostOrigin === null) {
		return json(400, {
			error: "hostUrl must be a root https://*.workers.dev origin with no path",
		})
	}

	// Proof of control (§7): the artifact served at hostUrl carries its own id in
	// its manifest, so registering someone else's URL fails on the id mismatch —
	// no challenge file, no token.
	//
	// PLACEHOLDER for the full §6.1 contract checker (one implementation, three
	// positions — creator's machine, here, remixing agent). What runs today is
	// the control-proof core: manifest fetched over HTTP, schema-valid, id match.
	let manifestResponse: Response
	try {
		manifestResponse = await fetch(new URL(MANIFEST_PATH, hostOrigin))
	} catch (error) {
		return json(422, {
			error: `could not fetch ${MANIFEST_PATH} from hostUrl: ${String(error)}`,
		})
	}
	if (!manifestResponse.ok) {
		return json(422, {
			error: `hostUrl does not serve ${MANIFEST_PATH} (status ${manifestResponse.status})`,
		})
	}
	let manifestJson: unknown
	try {
		manifestJson = await manifestResponse.json()
	} catch {
		return json(422, { error: `${MANIFEST_PATH} is not valid JSON` })
	}
	const manifest = manifestSchema.safeParse(manifestJson)
	if (!manifest.success) {
		return json(422, {
			error: `invalid ${MANIFEST_PATH}: ${z.prettifyError(manifest.error)}`,
		})
	}
	if (manifest.data.id !== id) {
		return json(409, {
			error: "the artifact served at hostUrl carries a different id",
		})
	}

	const db = createRegistryDb(env.DB)
	const existing = await db
		.selectFrom("artifact")
		.select(["host_url", "registered_at"])
		.where("id", "=", id)
		.executeTakeFirst()

	// An id binds to exactly one host, forever (§7). Republishing to the same
	// host re-runs the check; a different host is rejected outright.
	if (existing && existing.host_url !== hostOrigin) {
		return json(409, { error: "this id is permanently bound to a different host" })
	}

	const now = new Date().toISOString()
	const contractCheck = {
		checkedAt: now,
		checks: [{ name: "manifest", ok: true }],
		ok: true,
	}
	const row: Artifact = {
		contract_check: JSON.stringify(contractCheck),
		host_url: hostOrigin,
		id,
		parent: manifest.data.parent ?? null,
		registered_at: existing?.registered_at ?? now,
		standard: manifest.data.standard,
	}
	await db
		.insertInto("artifact")
		.values(row)
		.onConflict((oc) =>
			oc.column("id").doUpdateSet({
				contract_check: row.contract_check,
				parent: row.parent,
				standard: row.standard,
			}),
		)
		.execute()

	return json(existing ? 200 : 201, recordFromRow(row))
}

async function lookupRow(id: string, env: Env): Promise<Artifact | undefined> {
	const db = createRegistryDb(env.DB)
	return db.selectFrom("artifact").selectAll().where("id", "=", id).executeTakeFirst()
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url)

		if (REGISTER_PATTERN.test(url)) {
			if (request.method !== "POST") {
				return json(
					405,
					{ error: "method not allowed" },
					{ ...NOINDEX_HEADERS, allow: "POST" },
				)
			}
			return register(request, env)
		}

		// /a/<id>.json — the artifact's public record. Served with CORS because
		// trove.js runs on the creator's origin and must read this cross-origin.
		const recordMatch = RECORD_PATTERN.exec(url)
		if (recordMatch) {
			if (request.method === "OPTIONS") {
				return new Response(null, {
					headers: {
						...CORS_HEADERS,
						"access-control-allow-headers":
							request.headers.get("access-control-request-headers") ?? "",
						"access-control-allow-methods": "GET, OPTIONS",
						"access-control-max-age": "86400",
					},
					status: 204,
				})
			}
			const id = recordMatch.pathname.groups.id
			const row = id === undefined ? undefined : await lookupRow(id, env)
			if (!row) {
				return json(404, { error: "unknown artifact id" }, CORS_HEADERS)
			}
			return json(200, recordFromRow(row), CORS_HEADERS)
		}

		// /a/<id> and its whole subtree 302 to the host (§7) — always, for every
		// method. Safe because the host enforces ownership: an unclaimed deployment
		// is deleted after 60 minutes, so this points either at a dead URL or at
		// identified-owner content.
		const subtreeMatch = ARTIFACT_PATTERN.exec(url) ?? SUBTREE_PATTERN.exec(url)
		if (subtreeMatch) {
			const id = subtreeMatch.pathname.groups.id
			const row = id === undefined ? undefined : await lookupRow(id, env)
			if (!row) {
				return json(404, { error: "unknown artifact id" })
			}
			const subpath = subtreeMatch.pathname.groups["0"] ?? ""
			const location = new URL(`/${subpath}${url.search}`, row.host_url)
			return new Response(null, {
				headers: { ...NOINDEX_HEADERS, location: location.href },
				status: 302,
			})
		}

		return json(404, { error: "not found" })
	},
} satisfies ExportedHandler<Env>
