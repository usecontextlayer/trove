import { afterEach, describe, expect, it } from "vitest"
import { waitUntilServing } from "@/src/serving"

// Driven through `waitUntilServing` rather than `fetchWhileSettling` directly:
// the wrapper is what two of the three callers use, and the polling contract is
// the same either way.

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
