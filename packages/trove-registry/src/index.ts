import {
	canonicalUrlForId,
	checkTrove,
	httpReader,
	ID_PATTERN,
	MANIFEST_PATH,
} from "@usecontextlayer/trove-standard"
import { type Context, Hono } from "hono"
import { cors } from "hono/cors"
import { z } from "zod"
import type { Trove } from "@/database"
import { createRegistryDb } from "@/database"

// The registry — the only server Trove operates. Its claim: "this URL conforms
// to the trove standard." Three routes plus a redirect subtree; everything
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
 * §7: hostUrl must be a Cloudflare Workers host, and troves live at a host
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

/** The public record served at /a/<id>.json — one row per trove. */
function recordFromRow(row: Trove): Record<string, unknown> {
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

async function lookupRow(id: string, env: Env): Promise<Trove | undefined> {
	const db = createRegistryDb(env.DB)
	return db.selectFrom("trove").selectAll().where("id", "=", id).executeTakeFirst()
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
	// the trove carries its own id, so registering someone else's URL fails
	// with no challenge file and no token). A readable, correctly-identified
	// trove registers even with failing checks: the row records the full
	// report, /a/<id>.json exposes it, and trove.js renders the verdict —
	// certification is carried by the stored result, not by row existence.
	//
	// verifyFiles is OFF here, so this is three subrequests rather than one per
	// manifest entry. Fetching every file from inside a Worker bought little:
	// troves redeploy in place, so a digest verified at registration is stale
	// the moment the creator redeploys, and the position that actually needs
	// digests verified is the remixer, who is about to trust the bytes. It cost
	// a great deal: an unauthenticated caller chose up to a thousand outbound
	// fetches, the stored per-check details published each target's status and
	// exact byte length, and a conformant trove larger than the plan's
	// subrequest budget was recorded as FAILING, permanently. Checks 4 and 6
	// now report not-checked, which the record states plainly.
	const { manifest, report } = await checkTrove({
		expectedId: id,
		read: httpReader(hostOrigin),
		verifyFiles: false,
	})
	if (manifest === null) {
		return c.json(
			{ error: `hostUrl does not serve a valid ${MANIFEST_PATH}`, report },
			422,
		)
	}
	if (manifest.id !== id) {
		return c.json({ error: "the trove served at hostUrl carries a different id" }, 409)
	}

	const db = createRegistryDb(c.env.DB)
	const existing = await db
		.selectFrom("trove")
		.select(["host_url", "registered_at"])
		.where("id", "=", id)
		.executeTakeFirst()

	// An id binds to exactly one host, forever (§7). Republishing to the same
	// host re-runs the check; a different host is rejected outright.
	if (existing && existing.host_url !== hostOrigin) {
		return c.json({ error: "this id is permanently bound to a different host" }, 409)
	}

	const now = new Date().toISOString()
	const row: Trove = {
		contract_check: JSON.stringify({ checkedAt: now, ...report }),
		host_url: hostOrigin,
		id,
		parent: manifest.parent ?? null,
		registered_at: existing?.registered_at ?? now,
		standard: manifest.standard,
	}
	await db
		.insertInto("trove")
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

// /a/<id>.json — the trove's public record. Served with CORS because
// trove.js runs on the creator's origin and must read this cross-origin; the
// middleware also answers OPTIONS preflight with a 204.
app.use(RECORD_ROUTE, cors({ allowMethods: ["GET"], maxAge: 86400, origin: "*" }))
app.get(RECORD_ROUTE, async (c) => {
	const id = c.req.param("id").replace(/\.json$/, "")
	const row = await lookupRow(id, c.env)
	if (!row) {
		return c.json({ error: "unknown trove id" }, 404)
	}
	return c.json(recordFromRow(row))
})

// /a/<id> and its whole subtree 302 to the host (§7) — always, for every
// method. Safe because the host enforces ownership: an unclaimed deployment is
// deleted after 60 minutes, so this points either at a dead URL or at
// identified-owner content.
async function redirectToHost(
	id: string,
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	const row = await lookupRow(id, c.env)
	if (!row) {
		return c.json({ error: "unknown trove id" }, 404)
	}
	// The subtree remainder is a PATH, never an authority. It is assigned
	// through the URL object's own setters, which parse it in path-start state
	// — a state that cannot reach authority state, so "//evil.example/x" stays
	// a path on host_url. Resolving it relatively instead (new URL(sub, host))
	// does the opposite: a leading "//" is a network-path reference that
	// discards the base origin, which was a live open redirect on the canonical
	// domain, and "//" alone threw, surfacing as a 500.
	const requestUrl = new URL(c.req.url)
	const hostOrigin = new URL(row.host_url).origin
	// The id segment ends at the next "/" — derived from the encoded pathname
	// rather than the decoded route param, so a percent-encoded id cannot shift
	// the boundary.
	const idEnd = requestUrl.pathname.indexOf("/", "/a/".length)
	const location = new URL(row.host_url)
	location.pathname = idEnd === -1 ? "" : requestUrl.pathname.slice(idEnd)
	location.search = requestUrl.search
	// §3 requires every consumer resolving a path to verify the resolved origin
	// is the trove's. The setters above make this unreachable; it is kept
	// because a silent off-host redirect is the failure this route must never
	// have.
	if (location.origin !== hostOrigin) {
		return c.json({ error: "refusing to redirect off the trove's host" }, 500)
	}
	return new Response(null, { headers: { location: location.href }, status: 302 })
}

app.all("/a/:id", (c) => redirectToHost(c.req.param("id"), c))
app.all("/a/:id/*", (c) => redirectToHost(c.req.param("id"), c))

app.notFound((c) => c.json({ error: "not found" }, 404))

export default app
