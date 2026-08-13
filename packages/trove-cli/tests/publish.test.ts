import { describe, expect, it } from "vitest"
import { claimDeadlineLine } from "@/src/publish"

// The claim expiry is the one value a creator must act on before an unclaimed
// preview evaporates, and every document promises a "deadline". What the tool
// printed was a duration — so a naive agent converted it by hand, with a `date`
// invocation whose adjustment flag did nothing, and published the unchanged echo
// as a measured expiry time. The tool holds the only clock that knows when the
// deploy happened; doing the arithmetic here is what stops it being done there.

describe("claimDeadlineLine", () => {
	it("states a wall clock that is the deploy moment plus the duration", () => {
		const deployedAt = new Date("2026-08-13T12:00:00Z")
		const anHourLater = new Date("2026-08-13T13:00:00Z")
		// One instant reached two ways. The rendered zone and locale belong to
		// whoever runs this, so the assertion is that the two renderings agree —
		// which holds only if the timestamp is now + duration, and fails for an
		// implementation that prints either one alone.
		expect(claimDeadlineLine(60, deployedAt).replace("60 minutes", "0 minutes")).toBe(
			claimDeadlineLine(0, anHourLater),
		)
	})

	it("keeps the duration alongside it, so the line says how much room is left", () => {
		expect(claimDeadlineLine(60, new Date("2026-08-13T12:00:00Z"))).toContain(
			"60 minutes",
		)
	})
})
