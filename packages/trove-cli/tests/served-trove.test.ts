import { mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { freePort, withServedTrove } from "@/src/served-trove"

// The bracket three commands depend on, and the whole reason it is a bracket
// rather than a helper is teardown. It spawns a real `wrangler dev`, so these
// boot one — a local subprocess, which this repo's testing table puts in the
// unit tier.

function sourceFolder(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "trove-served-src-"))
	writeFileSync(path.join(dir, "AGENTS.md"), "# Served\n\nStand me up.\n")
	return dir
}

/** Whether anything is listening — the observable that says the server really stopped. */
async function isFree(port: number): Promise<boolean> {
	const probe = createServer()
	return new Promise((resolve) => {
		probe.once("error", () => resolve(false))
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
	})
}

describe("withServedTrove", () => {
	it("serves the assembled trove and hands over a working URL", async () => {
		const port = await freePort()
		const served = await withServedTrove({ folder: sourceFolder(), port }, async (s) => {
			const response = await fetch(new URL("/AGENTS.md", s.url))
			return { id: s.id, ok: response.ok, url: s.url }
		})
		expect(served.ok).toBe(true)
		expect(served.url).toContain(String(port))
		expect(served.id).toMatch(/^[0-9a-hj-km-np-tv-z]{24}$/)
	}, 120_000)

	it("stops the server even when the caller throws, and waits for it to actually exit", async () => {
		// The bug this pins: `stop()` is `child.kill()`, which returns
		// immediately. Returning without awaiting the exit hands control back
		// while wrangler still holds the port — so the next command to ask for a
		// free port can be handed the one still in use.
		const port = await freePort()
		await expect(
			withServedTrove({ folder: sourceFolder(), port }, async () => {
				throw new Error("the caller failed")
			}),
		).rejects.toThrow(/the caller failed/)

		expect(await isFree(port)).toBe(true)
	}, 120_000)
})
