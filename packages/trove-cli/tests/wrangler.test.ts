import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { isSettling404, parseDeployOutput, parseWhoamiOutput } from "@/src/wrangler"

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

describe("isSettling404", () => {
	it("recognizes the measured settling signature", () => {
		expect(isSettling404(404, "text/plain; charset=UTF-8", "error code: 1042")).toBe(true)
	})

	it("rejects a genuine miss (no content type, empty body)", () => {
		expect(isSettling404(404, null, "")).toBe(false)
	})

	it("rejects a 404 with a different body", () => {
		expect(isSettling404(404, "text/plain", "not found")).toBe(false)
	})

	it("rejects non-404 statuses", () => {
		expect(isSettling404(500, "text/plain", "error code: 1042")).toBe(false)
	})
})
