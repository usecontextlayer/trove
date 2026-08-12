import { describe, expect, it } from "vitest"
import {
	assertWellFormedId,
	ID_LENGTH,
	ID_PATTERN,
	isWellFormedId,
	mintId,
	recordUrlForId,
	TROVE_ORIGIN,
} from "@/index"

describe("mintId", () => {
	it("mints a well-formed id", () => {
		const id = mintId()
		expect(id).toHaveLength(ID_LENGTH)
		expect(id).toMatch(ID_PATTERN)
	})

	it("mints distinct ids", () => {
		expect(mintId()).not.toBe(mintId())
	})
})

describe("id grammar", () => {
	it("accepts the standard's example id", () => {
		expect(isWellFormedId("8k2mfq7xr3nv9wbz4tcy6hjd")).toBe(true)
	})

	it.each([
		["too short", "8k2mfq7xr3nv9wbz4tcy6hj"],
		["too long", "8k2mfq7xr3nv9wbz4tcy6hjdd"],
		["contains i", "ik2mfq7xr3nv9wbz4tcy6hjd"],
		["contains l", "lk2mfq7xr3nv9wbz4tcy6hjd"],
		["contains o", "ok2mfq7xr3nv9wbz4tcy6hjd"],
		["contains u", "uk2mfq7xr3nv9wbz4tcy6hjd"],
		["uppercase", "8K2MFQ7XR3NV9WBZ4TCY6HJD"],
		["empty", ""],
	])("rejects %s", (_label, id) => {
		expect(isWellFormedId(id)).toBe(false)
		expect(() => assertWellFormedId(id)).toThrow(/Malformed trove id/)
	})
})

describe("recordUrlForId", () => {
	it("derives the registry's record URL purely from the id", () => {
		const id = mintId()
		expect(recordUrlForId(id)).toBe(`${TROVE_ORIGIN}/a/${id}.json`)
	})

	it("throws on a malformed id", () => {
		expect(() => recordUrlForId("not-an-id")).toThrow(/Malformed trove id/)
	})
})
