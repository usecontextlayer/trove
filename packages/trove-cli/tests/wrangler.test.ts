import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { isSettling404, parseDeployOutput } from "@/src/wrangler"

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
