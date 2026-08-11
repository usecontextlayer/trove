import { createRequire } from "node:module"
import * as path from "node:path"
import { execa } from "execa"

// The wrangler seam — every measured Cloudflare trap lives here. wrangler is
// pinned EXACTLY in this package's dependencies: the --temporary flag is
// undocumented (absent from --help, surfaced only in error text) and the
// claim-URL output shape is parsed below, so a version drift can break both.

/** Fixed compatibility date, a constant so two publishes of the same artifact behave identically — never "today". */
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
	/** The directory holding wrangler.jsonc, with the artifact in a SUBDIRECTORY — never deploy the working directory itself. */
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
		// Isolate the deploy state per artifact: temporary accounts share one
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

/**
 * Verify-and-retry before handing out a URL (§8 step 4): poll until 200 or
 * timeout. A genuinely broken deployment fails loud at the timeout, with the
 * last observed response attached.
 */
export async function waitUntilServing(
	hostUrl: string,
	options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
	const pollMs = options.pollMs ?? 1000
	const timeoutMs = options.timeoutMs ?? 60_000
	const deadline = Date.now() + timeoutMs
	let last = "no response yet"
	while (Date.now() < deadline) {
		const response = await fetch(new URL("/", hostUrl))
		if (response.ok) {
			return
		}
		const body = await response.text()
		last = `${response.status} (${response.headers.get("content-type") ?? "no content type"}): ${body.slice(0, 80)}`
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
	throw new Error(
		`${hostUrl} did not start serving within ${timeoutMs}ms; last response: ${last}`,
	)
}
