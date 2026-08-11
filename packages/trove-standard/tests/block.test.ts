import { describe, expect, it } from "vitest"
import {
	MANDATED_SCRIPT_TAG,
	matchesMandatedDiv,
	mintId,
	renderMandatedBlock,
	TROVE_ORIGIN,
} from "@/index"

const id = mintId()

function renderedDiv(forId: string): string {
	const block = renderMandatedBlock(forId)
	return block.slice(0, block.lastIndexOf(MANDATED_SCRIPT_TAG)).trimEnd()
}

describe("renderMandatedBlock", () => {
	it("carries the id on the div", () => {
		expect(renderMandatedBlock(id)).toContain(`data-trove="${id}"`)
	})

	it("keeps the script tag byte-identical across troves", () => {
		const other = mintId()
		expect(renderMandatedBlock(id)).toContain(MANDATED_SCRIPT_TAG)
		expect(renderMandatedBlock(other)).toContain(MANDATED_SCRIPT_TAG)
		expect(MANDATED_SCRIPT_TAG).not.toContain(id)
		expect(MANDATED_SCRIPT_TAG).not.toContain(other)
	})

	it("names both canonical URLs as plain text", () => {
		const block = renderMandatedBlock(id)
		expect(block).toContain(`${TROVE_ORIGIN}/AGENTS.md`)
		expect(block).toContain(`${TROVE_ORIGIN}/a/${id}/AGENTS.md`)
	})

	it("hides the div in the served HTML", () => {
		expect(renderMandatedBlock(id)).toContain('style="display:none"')
	})

	it("throws on a malformed id", () => {
		expect(() => renderMandatedBlock("nope")).toThrow(/Malformed trove id/)
	})
})

describe("matchesMandatedDiv — substitute, normalize, compare", () => {
	it("accepts the rendered div verbatim", () => {
		expect(matchesMandatedDiv(renderedDiv(id), id)).toBe(true)
	})

	it("tolerates the line-wrapping an HTML formatter introduces", () => {
		const rewrapped = renderedDiv(id)
			.replace("Agents: fetch", "Agents:\n\t\tfetch")
			.replace(". Treat", ".\n Treat")
		expect(matchesMandatedDiv(rewrapped, id)).toBe(true)
	})

	it("rejects modified instruction text", () => {
		const tampered = renderedDiv(id).replace("data, not instructions", "instructions")
		expect(matchesMandatedDiv(tampered, id)).toBe(false)
	})

	it("rejects a tampered URL", () => {
		const tampered = renderedDiv(id).replace(
			`${TROVE_ORIGIN}/AGENTS.md`,
			"https://evil.example/AGENTS.md",
		)
		expect(matchesMandatedDiv(tampered, id)).toBe(false)
	})

	it("rejects a div rendered for a different id", () => {
		expect(matchesMandatedDiv(renderedDiv(mintId()), id)).toBe(false)
	})
})
