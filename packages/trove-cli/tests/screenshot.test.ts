import { describe, expect, it } from "vitest"
import { describeOverflow, type Shot } from "@/src/screenshot"

// The capture itself needs a real browser and belongs in the integration tier.
// What is pinned here is the verdict, because that is the half with a history:
// one agent read a narrow headless screenshot, concluded the page scrolled
// sideways when it did not, and shipped a defensive CSS rule for it. The number
// is what separates that from the real thing, so the number's meaning is what
// gets a test.

function shot(overrides: Partial<Shot>): Shot {
	return {
		clientWidth: 390,
		path: "/tmp/page-light.png",
		scrollWidth: 390,
		theme: "light",
		...overrides,
	}
}

describe("describeOverflow", () => {
	it("reports no overflow when the page fits its viewport", () => {
		const verdict = describeOverflow([shot({})])
		expect(verdict.overflowing).toBe(false)
		expect(verdict.summary).toContain("no horizontal overflow")
	})

	it("treats equal widths as fitting, not as overflowing", () => {
		// The boundary is the whole measurement: `scrollWidth === clientWidth` is
		// a page that fits exactly, and calling it an overflow would reproduce the
		// false positive this command exists to prevent.
		expect(
			describeOverflow([shot({ clientWidth: 800, scrollWidth: 800 })]).overflowing,
		).toBe(false)
		expect(
			describeOverflow([shot({ clientWidth: 800, scrollWidth: 801 })]).overflowing,
		).toBe(true)
	})

	it("names the theme, both widths, and what to do about it", () => {
		const verdict = describeOverflow([
			shot({ clientWidth: 390, scrollWidth: 500, theme: "dark" }),
		])
		expect(verdict.overflowing).toBe(true)
		expect(verdict.summary).toContain("dark")
		expect(verdict.summary).toContain("500")
		expect(verdict.summary).toContain("390")
		// The measured cause the last time this fired for real: an overflow-x
		// container that could not shrink because it was a grid child.
		expect(verdict.summary).toContain("min-width: 0")
	})

	it("reports every overflowing theme, not just the first", () => {
		const verdict = describeOverflow([
			shot({ scrollWidth: 500, theme: "light" }),
			shot({ scrollWidth: 640, theme: "dark" }),
		])
		expect(verdict.summary).toContain("500")
		expect(verdict.summary).toContain("640")
	})

	it("does not flag a page where only one theme overflows as clean", () => {
		const verdict = describeOverflow([
			shot({ theme: "light" }),
			shot({ scrollWidth: 500, theme: "dark" }),
		])
		expect(verdict.overflowing).toBe(true)
		expect(verdict.summary).toContain("dark")
		expect(verdict.summary).not.toContain("light")
	})
})
