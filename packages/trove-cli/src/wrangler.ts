import { writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { execa } from "execa"

// The wrangler seam — every measured Cloudflare trap lives here. wrangler is
// pinned EXACTLY in this package's dependencies: the --temporary flag is
// undocumented (absent from --help, surfaced only in error text) and the
// claim-URL output shape is parsed below, so a version drift can break both.

/** Fixed compatibility date, a constant so two publishes of the same trove behave identically — never "today". */
export const COMPATIBILITY_DATE = "2026-08-01"

const require_ = createRequire(import.meta.url)

/**
 * The pinned wrangler's bin, spawned via process.execPath — never a PATH
 * lookup, which version-drifts, and never through shell shims (mise intercepts
 * `node` and breaks under a redirected XDG_CONFIG_HOME; measured).
 * `wrangler/bin/wrangler.js` is exports-blocked, so resolve the package root.
 */
export function wranglerBinPath(): string {
	const packageJson = require_.resolve("wrangler/package.json")
	return path.join(path.dirname(packageJson), "bin", "wrangler.js")
}

export type CredentialState = "anonymous" | "authenticated"

/**
 * Classify `wrangler whoami` output. The markers are anchored to the pinned
 * wrangler's own dist (4.120.1) plus a real capture: authenticated prints
 * "You are logged in with an <authType>…"; a clean logged-out run prints
 * "You are not authenticated. Please run `wrangler login`."; an EXPIRED OAuth
 * token in a non-interactive shell exits 1 with "Not logged in. Your auth
 * token has expired…" (captured — a third state the docs never name). Both
 * not-logged-in shapes mean the anonymous path. Anything else is a loud error,
 * never a silent fallback.
 */
export function parseWhoamiOutput(output: string, exitCode: number): CredentialState {
	if (output.includes("You are logged in with an")) {
		return "authenticated"
	}
	if (output.includes("You are not authenticated") || output.includes("Not logged in")) {
		return "anonymous"
	}
	throw new Error(
		`could not determine wrangler credential state (whoami exit ${exitCode}):\n${output}`,
	)
}

/**
 * Ask wrangler itself whether the user is authenticated — `whoami` honors both
 * `wrangler login` OAuth state and CLOUDFLARE_API_TOKEN, so it subsumes any
 * env-var sniffing. Runs against the user's REAL config (no isolation): the
 * question is about their actual state.
 */
export async function detectCredentialState(): Promise<CredentialState> {
	const result = await execa(process.execPath, [wranglerBinPath(), "whoami"], {
		all: true,
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		reject: false,
	})
	return parseWhoamiOutput(result.all ?? "", result.exitCode ?? -1)
}

export interface DeployResult {
	claim: { deadlineMinutes: number; url: string } | null
	hostUrl: string
}

/**
 * Parse `wrangler deploy` stdout. The host URL is the *.workers.dev line; on an
 * anonymous deploy a claim URL and deadline precede it ("Claim within: 60
 * minutes"). Anchored by a real captured deploy in this repo's test fixtures.
 */
export function parseDeployOutput(output: string): DeployResult {
	const hostMatch = output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/)
	if (!hostMatch) {
		throw new Error(`wrangler deploy output carried no *.workers.dev URL:\n${output}`)
	}
	const claimUrl = output.match(
		/https:\/\/dash\.cloudflare\.com\/claim-preview\?\S+/,
	)?.[0]
	const deadline = output.match(/Claim within:\s*(\d+)\s*minutes/)?.[1]
	return {
		claim:
			claimUrl === undefined
				? null
				: {
						deadlineMinutes: deadline === undefined ? 60 : Number(deadline),
						url: claimUrl,
					},
		hostUrl: hostMatch[0],
	}
}

export interface DeployOptions {
	/** Anonymous (--temporary) or the creator's own authenticated account. */
	anonymous: boolean
	/** The directory holding wrangler.jsonc, with the trove in a SUBDIRECTORY — never deploy the working directory itself. */
	deployDir: string
}

export async function deployAssembled(options: DeployOptions): Promise<DeployResult> {
	const { anonymous, deployDir } = options
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		WRANGLER_SEND_METRICS: "false",
	}
	const args = [wranglerBinPath(), "deploy"]
	if (anonymous) {
		// Isolate the deploy state per trove: temporary accounts share one
		// state file per config dir — one account, one URL slug, and ONE expiry
		// clock counting from the first deploy (measured). And --temporary errors
		// when credentials are present, so the ambient ones are dropped.
		childEnv.XDG_CONFIG_HOME = path.join(deployDir, ".wrangler-state")
		delete childEnv.CLOUDFLARE_API_TOKEN
		delete childEnv.CLOUDFLARE_ACCOUNT_ID
		delete childEnv.CLOUDFLARE_API_KEY
		delete childEnv.CLOUDFLARE_EMAIL
		args.push("--temporary")
	}
	const result = await execa(process.execPath, args, {
		all: true,
		cwd: deployDir,
		env: childEnv,
		extendEnv: false,
		reject: false,
	})
	if (result.exitCode !== 0) {
		throw new Error(`wrangler deploy failed (exit ${result.exitCode}):\n${result.all}`)
	}
	return parseDeployOutput(result.all ?? "")
}

/**
 * Write the deploy config for an assembled trove. ONE writer, because `dev` and
 * `publish` must stand up byte-identical servers: `dev` checking a
 * differently-served trove than the one that later deploys is the single
 * failure that would make it worthless, and two copies of a config literal is
 * exactly how that happens.
 *
 * The config sits OUTSIDE the assets directory — wrangler publishes its own
 * scratch files, so the trove is always a subdirectory, never ".". The name
 * derives from the id (DNS-label-safe); the compatibility date is a constant so
 * two publishes of the same trove behave identically.
 */
export function writeWranglerConfig(options: { deployDir: string; id: string }): void {
	const { deployDir, id } = options
	writeFileSync(
		path.join(deployDir, "wrangler.jsonc"),
		`${JSON.stringify(
			{
				assets: { directory: "./trove" },
				compatibility_date: COMPATIBILITY_DATE,
				name: `trove-${id.slice(0, 8)}`,
			},
			null,
			"\t",
		)}\n`,
	)
}

export interface DevServer {
	/** Resolves when the server exits — Ctrl-C, or a crash. */
	finished: Promise<unknown>
	stop: () => void
	url: string
}

/**
 * Serve an assembled trove locally with `wrangler dev`.
 *
 * The asset layer wrangler runs here is the SAME one the host runs, which is
 * the entire reason this is worth doing: measured against a real `_headers`
 * file, it applies `X-Robots-Tag` to a CSV as well as to HTML, refuses to serve
 * `_headers` itself, and 307s `/index.html` to `/`. Those are behaviours the
 * checker's local reader fabricates — so running §6.1 over HTTP against this
 * server is a real observation where the pre-publish check is mostly true by
 * construction.
 *
 * SAME asset layer is not SAME defaults, and one difference has already cost us
 * a shipped bug. `wrangler dev` attaches `; charset=utf-8` to text types on its
 * own; the deployed host does NOT (both measured 2026-08-11). Reading the local
 * charset as the host's behaviour is what put "the host appends `; charset=utf-8`
 * to text types (measured)" into the standard, where it was false — and every
 * fixture copied it, so the suite stayed green while trove.usecontextlayer.com
 * served /AGENTS.md bare and every em dash reached its reader as "â€”". A charset
 * observed HERE proves nothing about production; the only thing that makes it
 * true there is an explicit rule in the generated `_headers`.
 *
 * stdio is inherited: wrangler's own startup output is the only diagnosis a
 * caller gets when the server fails to come up, and swallowing it would reduce
 * every such failure to a bare timeout.
 */
export function serveAssembled(options: { deployDir: string; port: number }): DevServer {
	const { deployDir, port } = options
	const child = execa(
		process.execPath,
		[wranglerBinPath(), "dev", "--port", String(port)],
		{
			cwd: deployDir,
			env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
			reject: false,
			stdio: "inherit",
		},
	)
	return {
		finished: child,
		stop: () => {
			child.kill()
		},
		url: `http://localhost:${port}`,
	}
}

/**
 * The characteristic settling 404 while a deploy propagates: text/plain
 * content type and the 17-byte body "error code: 1042" (measured). Diagnostic
 * only — propagation also emits 404s WITHOUT this signature (measured: a
 * healthy fresh deploy served signature-less 404s before settling to 200), so
 * no 404 shape is proof of a broken deployment while the clock is running.
 */
export function isSettling404(
	status: number,
	contentType: string | null,
	body: string,
): boolean {
	return (
		status === 404 &&
		(contentType ?? "").startsWith("text/plain") &&
		body === "error code: 1042"
	)
}

/** How long to keep trying a freshly deployed path, and how often. The defaults are sized to the measured propagation window. */
export interface SettlingOptions {
	pollMs?: number
	timeoutMs?: number
}

/**
 * Fetch a path on a trove that may still be propagating, returning the first
 * response that arrives ok.
 *
 * **Returning the response is the point**, and it is what separates this from
 * polling and then fetching separately. A fresh anonymous deployment does not
 * simply come up — it FLAPS: measured on one preview, `/trove.json` answered
 * `200, 404, 200, 200, 404, 200` at three-second intervals. A caller that waits
 * for a path to answer and then makes its real request loses that race about as
 * often as the flap rate, which is exactly the failure this exists to remove.
 *
 * A transport failure is a not-serving-yet OBSERVATION, not the end of the
 * poll. A fresh anonymous deploy lands on a brand-new workers.dev slug, so DNS
 * may not resolve for the first second or two and `fetch` REJECTS rather than
 * returning a status — which ended the loop 9ms into a 60s budget and reported
 * a healthy deploy as broken. §8: poll until it serves or until the deadline;
 * do not classify. The deadline is the one loud failure point.
 */
export async function fetchWhileSettling(
	url: URL,
	options: SettlingOptions = {},
): Promise<Response> {
	const pollMs = options.pollMs ?? 1000
	const timeoutMs = options.timeoutMs ?? 60_000
	const deadline = Date.now() + timeoutMs
	let last = "no response yet"
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url)
			if (response.ok) {
				return response
			}
			const body = await response.text()
			last = `${response.status} (${response.headers.get("content-type") ?? "no content type"}): ${body.slice(0, 80)}`
		} catch (error) {
			last = `transport error: ${String(error)}`
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
	throw new Error(
		`${url.href} did not start serving within ${timeoutMs}ms; last response: ${last}`,
	)
}

/**
 * Verify-and-retry before handing out a URL (§8 step 4): wait for the trove's
 * root to answer. The response is discarded — publish re-reads everything
 * through the checker immediately afterwards.
 */
export async function waitUntilServing(
	hostUrl: string,
	options: SettlingOptions = {},
): Promise<void> {
	await fetchWhileSettling(new URL("/", hostUrl), options)
}
