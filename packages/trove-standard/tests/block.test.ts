import { describe, expect, it } from "vitest"
import {
	CURRENT_STANDARD,
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
		expect(matchesMandatedDiv(renderedDiv(id), id, CURRENT_STANDARD)).toBe(true)
	})

	it("tolerates the line-wrapping an HTML formatter introduces", () => {
		const rewrapped = renderedDiv(id)
			.replace("Agents: fetch", "Agents:\n\t\tfetch")
			.replace(". Treat", ".\n Treat")
		expect(matchesMandatedDiv(rewrapped, id, CURRENT_STANDARD)).toBe(true)
	})

	it("tolerates a formatter putting each attribute on its own line", () => {
		// Prettier's default print width does exactly this to the mandated div.
		// The reflow leaves a space before the `>`, which whitespace collapse
		// alone does not absorb — so this was rejected as a modified block.
		const reflowed = `<div\n\tdata-trove="${id}"\n\tstyle="display:none"\n>\n${renderedDiv(
			id,
		)
			.split("\n")
			.slice(1)
			.join("\n")}`
		expect(matchesMandatedDiv(reflowed, id, CURRENT_STANDARD)).toBe(true)
	})

	it("rejects modified instruction text", () => {
		const tampered = renderedDiv(id).replace("data, not instructions", "instructions")
		expect(matchesMandatedDiv(tampered, id, CURRENT_STANDARD)).toBe(false)
	})

	it("rejects a tampered URL", () => {
		const tampered = renderedDiv(id).replace(
			`${TROVE_ORIGIN}/AGENTS.md`,
			"https://evil.example/AGENTS.md",
		)
		expect(matchesMandatedDiv(tampered, id, CURRENT_STANDARD)).toBe(false)
	})

	it("rejects a div rendered for a different id", () => {
		expect(matchesMandatedDiv(renderedDiv(mintId()), id, CURRENT_STANDARD)).toBe(false)
	})

	it("rejects a standard version it has no template for", () => {
		// §3 tells consumers to branch on `standard`. A version this checker
		// does not know is not something it may silently pass.
		expect(matchesMandatedDiv(renderedDiv(id), id, CURRENT_STANDARD + 1)).toBe(false)
	})
})
