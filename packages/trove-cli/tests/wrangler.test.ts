import { readFileSync } from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseDeployOutput, parseWhoamiOutput, waitUntilServing } from "@/src/wrangler"

// The fixture is a REAL `wrangler deploy --temporary` capture (2026-08-10,
// wrangler 4.120.1) — refreshing it means running a real anonymous deploy
// again, which is what keeps this parser anchored to wrangler's actual output
// rather than a remembered shape.
const realDeployOutput = readFileSync(
	path.join(import.meta.dirname, "fixtures", "deploy-output-temporary.txt"),
	"utf8",
)

describe("parseDeployOutput", () => {
	it("extracts host, claim URL, and deadline from a real anonymous deploy", () => {
		const result = parseDeployOutput(realDeployOutput)
		expect(result.hostUrl).toBe("https://trove-7g7hjdeb.even-boron.workers.dev")
		expect(result.claim).not.toBeNull()
		expect(result.claim?.url).toMatch(
			/^https:\/\/dash\.cloudflare\.com\/claim-preview\?claimToken=/,
		)
		expect(result.claim?.deadlineMinutes).toBe(60)
	})

	it("returns null claim for an authenticated deploy", () => {
		const authenticated = realDeployOutput
			.split("\n")
			.filter((line) => !line.includes("claim") && !line.includes("Claim"))
			.join("\n")
		const result = parseDeployOutput(authenticated)
		expect(result.hostUrl).toBe("https://trove-7g7hjdeb.even-boron.workers.dev")
		expect(result.claim).toBeNull()
	})

	it("throws loudly when no host URL is present", () => {
		expect(() => parseDeployOutput("nothing useful here")).toThrow(
			/no \*\.workers\.dev URL/,
		)
	})
})

describe("parseWhoamiOutput", () => {
	// Real capture: an EXPIRED OAuth token in a non-interactive shell — a third
	// credential state (neither cleanly logged out nor logged in), exit 1.
	const expiredTokenOutput = readFileSync(
		path.join(import.meta.dirname, "fixtures", "whoami-expired-token.txt"),
		"utf8",
	)

	it("classifies an expired token as anonymous (real capture)", () => {
		expect(parseWhoamiOutput(expiredTokenOutput, 1)).toBe("anonymous")
	})

	it("classifies a clean logged-out run as anonymous (marker from the pinned wrangler dist)", () => {
		expect(
			parseWhoamiOutput("You are not authenticated. Please run `wrangler login`.", 0),
		).toBe("anonymous")
	})

	it("classifies a login as authenticated (template from the pinned wrangler dist)", () => {
		expect(
			parseWhoamiOutput(
				"Getting User settings...\nYou are logged in with an OAuth Token, associated with the email dev@example.com.",
				0,
			),
		).toBe("authenticated")
	})

	it("classifies an env-token login as authenticated", () => {
		expect(
			parseWhoamiOutput(
				"You are logged in with an API Token. Unset the CLOUDFLARE_API_TOKEN in the environment to log in via OAuth.",
				0,
			),
		).toBe("authenticated")
	})

	it("throws loudly on unrecognizable output instead of guessing", () => {
		expect(() => parseWhoamiOutput("something entirely new", 7)).toThrow(
			/could not determine wrangler credential state/,
		)
	})
})

describe("waitUntilServing", () => {
	const realFetch = globalThis.fetch
	afterEach(() => {
		globalThis.fetch = realFetch
	})

	it("keeps polling through a transport failure", async () => {
		// A fresh anonymous deploy lands on a brand-new workers.dev slug, so DNS
		// may not resolve for the first second or two and `fetch` REJECTS rather
		// than returning a status. Treating that as fatal ended the poll ~9ms
		// into a 60s budget and reported a healthy deploy as broken. §8: poll
		// until it serves or until the deadline; do not classify.
		let attempts = 0
		globalThis.fetch = (async () => {
			attempts += 1
			if (attempts < 3) {
				throw new TypeError("fetch failed")
			}
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		await waitUntilServing("https://trove-abc.example.workers.dev", {
			pollMs: 1,
			timeoutMs: 5_000,
		})
		expect(attempts).toBe(3)
	})

	it("still fails loudly at the deadline, naming what it last saw", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("fetch failed")
		}) as typeof fetch

		await expect(
			waitUntilServing("https://trove-abc.example.workers.dev", {
				pollMs: 1,
				timeoutMs: 30,
			}),
		).rejects.toThrow(/did not start serving.*transport error/s)
	})
})
