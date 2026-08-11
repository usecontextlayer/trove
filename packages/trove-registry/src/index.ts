import {
	canonicalUrlForId,
	checkArtifact,
	httpReader,
	ID_PATTERN,
	MANIFEST_PATH,
} from "@usecontextlayer/trove-standard"
import { type Context, Hono } from "hono"
import { cors } from "hono/cors"
import { z } from "zod"
import type { Artifact } from "@/database"
import { createRegistryDb } from "@/database"

// The registry — the only server Trove operates. Its claim: "this URL conforms
// to the artifact standard." Three routes plus a redirect subtree; everything
// else this domain serves (/trove.js, /AGENTS.md, /skills/**) is a static asset
// that never invokes this Worker (see run_worker_first in wrangler.jsonc).

const registerBodySchema = z.object({
	hostUrl: z.url(),
	id: z.string().regex(ID_PATTERN),
})

// Hono's `:id` is greedy to the next `/`, so a naive "/a/:id.json" NEVER
// matches and "/a/:id" would swallow it with id="abc.json" (measured). The
// regex-constrained param is the working form; the matched param carries the
// ".json" suffix, stripped in the handler.
const RECORD_ROUTE = "/a/:id{[^/]+\\.json}"

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

async function lookupRow(id: string, env: Env): Promise<Artifact | undefined> {
	const db = createRegistryDb(env.DB)
	return db.selectFrom("artifact").selectAll().where("id", "=", id).executeTakeFirst()
}

const app = new Hono<{ Bindings: Env }>()

// The standard makes noindex unconditional on every response (§5). `_headers`
// covers asset responses only, so every Worker response gets it here — set
// after next() so it lands on whatever Response the handler produced,
// including the CORS middleware's preflight short-circuit.
app.use("*", async (c, next) => {
	await next()
	c.res.headers.set("x-robots-tag", "noindex")
})

app.post("/register", async (c) => {
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: "request body must be JSON" }, 400)
	}
	const parsed = registerBodySchema.safeParse(body)
	if (!parsed.success) {
		return c.json({ error: `invalid body: ${z.prettifyError(parsed.error)}` }, 400)
	}
	const { hostUrl, id } = parsed.data

	const hostOrigin = parseHostOrigin(hostUrl)
	if (hostOrigin === null) {
		return c.json(
			{ error: "hostUrl must be a root https://*.workers.dev origin with no path" },
			400,
		)
	}

	// The §6.1 contract checks over HTTP — the same checker that runs on the
	// creator's machine and in a remixing agent, in the registry position
	// (expectedId = the id being registered). Identity is the GATE: an
	// unreadable manifest is 422, a different id is 409 (proof of control, §7 —
	// the artifact carries its own id, so registering someone else's URL fails
	// with no challenge file and no token). A readable, correctly-identified
	// artifact registers even with failing checks: the row records the full
	// report, /a/<id>.json exposes it, and trove.js renders the verdict —
	// certification is carried by the stored result, not by row existence.
	const { manifest, report } = await checkArtifact({
		expectedId: id,
		read: httpReader(hostOrigin),
	})
	if (manifest === null) {
		return c.json(
			{ error: `hostUrl does not serve a valid ${MANIFEST_PATH}`, report },
			422,
		)
	}
	if (manifest.id !== id) {
		return c.json({ error: "the artifact served at hostUrl carries a different id" }, 409)
	}

	const db = createRegistryDb(c.env.DB)
	const existing = await db
		.selectFrom("artifact")
		.select(["host_url", "registered_at"])
		.where("id", "=", id)
		.executeTakeFirst()

	// An id binds to exactly one host, forever (§7). Republishing to the same
	// host re-runs the check; a different host is rejected outright.
	if (existing && existing.host_url !== hostOrigin) {
		return c.json({ error: "this id is permanently bound to a different host" }, 409)
	}

	const now = new Date().toISOString()
	const row: Artifact = {
		contract_check: JSON.stringify({ checkedAt: now, ...report }),
		host_url: hostOrigin,
		id,
		parent: manifest.parent ?? null,
		registered_at: existing?.registered_at ?? now,
		standard: manifest.standard,
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

	return c.json(recordFromRow(row), existing ? 200 : 201)
})

app.all("/register", (c) =>
	c.json({ error: "method not allowed" }, 405, { allow: "POST" }),
)

// /a/<id>.json — the artifact's public record. Served with CORS because
// trove.js runs on the creator's origin and must read this cross-origin; the
// middleware also answers OPTIONS preflight with a 204.
app.use(RECORD_ROUTE, cors({ allowMethods: ["GET"], maxAge: 86400, origin: "*" }))
app.get(RECORD_ROUTE, async (c) => {
	const id = c.req.param("id").replace(/\.json$/, "")
	const row = await lookupRow(id, c.env)
	if (!row) {
		return c.json({ error: "unknown artifact id" }, 404)
	}
	return c.json(recordFromRow(row))
})

// /a/<id> and its whole subtree 302 to the host (§7) — always, for every
// method. Safe because the host enforces ownership: an unclaimed deployment is
// deleted after 60 minutes, so this points either at a dead URL or at
// identified-owner content.
async function redirectToHost(
	id: string,
	subpath: string,
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	const row = await lookupRow(id, c.env)
	if (!row) {
		return c.json({ error: "unknown artifact id" }, 404)
	}
	const search = new URL(c.req.url).search
	const location = new URL(`/${subpath}${search}`, row.host_url)
	return new Response(null, { headers: { location: location.href }, status: 302 })
}

app.all("/a/:id", (c) => redirectToHost(c.req.param("id"), "", c))
app.all("/a/:id/*", (c) => {
	const id = c.req.param("id")
	const prefix = `/a/${id}/`
	const subpath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : ""
	return redirectToHost(id, subpath, c)
})

app.notFound((c) => c.json({ error: "not found" }, 404))

export default app
