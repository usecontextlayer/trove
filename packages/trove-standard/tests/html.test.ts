import { describe, expect, it } from "vitest"
import { bodyCloseOffset, cutRanges, parseElements } from "@/index"

// The parsing seam. Every HTML defect this repo has shipped came from lexing
// markup with string operations, so these tests pin the parser's behaviour on
// the shapes that broke the hand-rolled versions.

describe("parseElements", () => {
	it("returns elements in source order with verbatim markup", () => {
		const html = `<!doctype html><html><body><h1>A</h1><p>B</p></body></html>`
		const tags = parseElements(html).map((element) => element.tagName)
		expect(tags).toEqual(["html", "head", "body", "h1", "p"])
		expect(parseElements(html).find((e) => e.tagName === "p")?.source?.markup).toBe(
			"<p>B</p>",
		)
	})

	it("decodes attribute values, so an entity cannot hide their meaning", () => {
		const element = parseElements(`<p style="display:&#110;one">x</p>`)[3]
		expect(element?.attrs.style).toBe("display:none")
	})

	it("reads an unquoted attribute value", () => {
		const element = parseElements(`<p style=display:none>x</p>`)[3]
		expect(element?.attrs.style).toBe("display:none")
	})

	it("does not let a > inside an earlier attribute truncate the tag", () => {
		const element = parseElements(`<div title="a>b" style="display:none">x</div>`)[3]
		expect(element?.attrs.title).toBe("a>b")
		expect(element?.attrs.style).toBe("display:none")
	})

	it("keeps the first of a repeated attribute, as HTML requires", () => {
		const element = parseElements(`<div data-trove="first" data-trove="second"></div>`)[3]
		expect(element?.attrs["data-trove"]).toBe("first")
	})

	it("does not treat markup inside a comment, script, or textarea as elements", () => {
		for (const html of [
			`<body><!-- <div data-trove="x">d</div> --></body>`,
			`<body><script>var s = "<div data-trove=\\"x\\">d</div>"</script></body>`,
			`<body><textarea><div data-trove="x">d</div></textarea></body>`,
		]) {
			const troveDivs = parseElements(html).filter((element) =>
				Object.hasOwn(element.attrs, "data-trove"),
			)
			expect(troveDivs).toEqual([])
		}
	})

	it("sees content inside <noscript> as markup, the way a JavaScript-free fetcher does", () => {
		const html = `<body><noscript><div data-trove="x">d</div></noscript></body>`
		const troveDivs = parseElements(html).filter((element) =>
			Object.hasOwn(element.attrs, "data-trove"),
		)
		expect(troveDivs).toHaveLength(1)
	})

	it("gives parser-implied elements a null source", () => {
		// A bare fragment: html/head/body are invented, so they have no markup of
		// their own and every consumer must guard.
		const implied = parseElements("<p>x</p>").filter((element) => element.source === null)
		expect(implied.map((element) => element.tagName)).toEqual(["html", "head", "body"])
	})

	it("excludes comments from text", () => {
		const element = parseElements(`<p>before<!-- hidden -->after</p>`)[3]
		expect(element?.text).toBe("beforeafter")
	})
})

describe("bodyCloseOffset", () => {
	it("finds the closing tag whatever case it is written in", () => {
		const html = "<html><body><p>x</p></BODY></html>"
		expect(html.slice(bodyCloseOffset(html) ?? 0)).toBe("</BODY></html>")
	})

	it("is unaffected by characters whose lowercase is longer than themselves", () => {
		// The defect this replaces: an index computed on a toLowerCase() copy and
		// applied to the original. "İ" lowercases to two code units, so each one
		// shifted the index and the slice cut the closing tag apart.
		for (const text of ["Istanbul", "İstanbul", "İstanbul, İzmir, İnegöl", "İİİİİİİ"]) {
			const html = `<html lang="tr"><body><p>${text}</p>\n</body>\n</html>\n`
			expect(html.slice(bodyCloseOffset(html) ?? 0)).toBe("</body>\n</html>\n")
		}
	})

	it("returns null when the document has no closing tag to splice at", () => {
		expect(bodyCloseOffset("<p>no body tag at all</p>")).toBeNull()
	})

	it("ignores a closing tag that is only text", () => {
		const html = "<html><body><p>x</p><!-- </body> --></body></html>"
		expect(html.slice(bodyCloseOffset(html) ?? 0)).toBe("</body></html>")
	})
})

describe("cutRanges", () => {
	it.each([
		["no ranges", "<p>a</p>", [], "<p>a</p>"],
		["a range at offset zero", "ABCdef", [{ end: 3, start: 0 }], "def"],
		["a range ending at EOF", "abcDEF", [{ end: 6, start: 3 }], "abc"],
		["a zero-length range", "abcdef", [{ end: 3, start: 3 }], "abcdef"],
		[
			"the same range twice",
			"abcDEFghi",
			[
				{ end: 6, start: 3 },
				{ end: 6, start: 3 },
			],
			"abcghi",
		],
		[
			"disjoint ranges given out of order",
			"AAA.BBB.CCC",
			[
				{ end: 11, start: 8 },
				{ end: 3, start: 0 },
			],
			".BBB.",
		],
		[
			"overlapping ranges",
			"0123456789",
			[
				{ end: 5, start: 1 },
				{ end: 8, start: 4 },
			],
			"089",
		],
		[
			"a nested range, inner listed first",
			"012<X<Y>Z>345",
			[
				{ end: 8, start: 5 },
				{ end: 10, start: 3 },
			],
			"012345",
		],
		[
			"two ranges sharing a start",
			"0123456789",
			[
				{ end: 3, start: 2 },
				{ end: 7, start: 2 },
			],
			"01789",
		],
	])("cuts %s", (_label, html, ranges, expected) => {
		expect(cutRanges(html, ranges)).toBe(expected)
	})

	it("never returns more bytes than it was given", () => {
		const html = "0123456789"
		const out = cutRanges(html, [
			{ end: 6, start: 2 },
			{ end: 4, start: 3 },
			{ end: 9, start: 5 },
		])
		expect(out).toBe("019")
		expect(out.length).toBeLessThanOrEqual(html.length)
	})

	it("throws on an inverted range instead of duplicating bytes", () => {
		// Left unguarded this emitted slice(0, start) and then resumed at
		// end < start, so a 10-byte input produced 15 bytes.
		expect(() => cutRanges("0123456789", [{ end: 2, start: 7 }])).toThrow(
			/inverted source range/,
		)
	})

	it("extends a cut over the whitespace that follows it", () => {
		expect(cutRanges("keep <CUT>\n\nkeep", [{ end: 10, start: 5 }])).toBe("keep keep")
	})
})
