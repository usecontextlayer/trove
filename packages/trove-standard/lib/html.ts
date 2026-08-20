import { type DefaultTreeAdapterMap, parse } from "parse5"

// The HTML parsing seam. Everything in this repo that inspects a trove's markup
// goes through here, so nothing lexes HTML with string operations or regexes.
// That class of defect is not hypothetical: a hand-rolled tag regex let
// `style=display:none` (unquoted), `style="display:&#110;one"` (entity-encoded)
// and `<div title="a>b" style="display:none">` (a `>` inside an earlier
// attribute) each evade a check the standard calls gating and absolute, while
// the same code extracted a decoy block out of an HTML comment.
//
// parse5 is the HTML5-spec parser, so it recovers from malformed markup the way
// browsers — and the browser-derived fetchers the standard cares about — do.
// Two options are load-bearing:
//
//   sourceCodeLocationInfo  gives each element its verbatim source range, which
//                           is what §4 compares over. Re-serializing instead
//                           would compare a serializer's output rather than the
//                           bytes the server actually sent, and would rewrite a
//                           creator's page (quotes, void tags, entities, case).
//   scriptingEnabled:false  parses <noscript> content as markup, which is what
//                           an agent fetcher sees — it runs no JavaScript. With
//                           the default (true) a block inside <noscript> is
//                           invisible to the parser and so to every check.

type Parse5Node = DefaultTreeAdapterMap["node"]
type Parse5Element = DefaultTreeAdapterMap["element"]
type Parse5Text = DefaultTreeAdapterMap["textNode"]

/**
 * A byte-aligned view used only as parse5 input. Each byte becomes the
 * same-numbered code unit — the identity map Node calls `latin1` — so parse5's
 * source offsets are byte offsets. This is not decoded text and must never be
 * written back to disk.
 */
export function htmlParserInput(bytes: Uint8Array): string {
	const chunks: string[] = []
	for (let start = 0; start < bytes.byteLength; start += 0x8000) {
		chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)))
	}
	return chunks.join("")
}

export interface HtmlElement {
	/**
	 * Attribute values, DECODED by the parser: `style="display:&#110;one"`
	 * arrives as `display:none`, and an unquoted `style=display:none` arrives
	 * the same way. A repeated attribute keeps its first value, as HTML requires.
	 */
	attrs: Record<string, string>
	/**
	 * The element's own verbatim source, or null for an element the parser
	 * implied rather than the author writing it (`<html>`/`<body>` around a
	 * fragment). Never null for an element physically present in the source.
	 *
	 * `attrs` carries the range of each attribute's whole `name="value"` text,
	 * so a caller can edit one attribute by splicing the original bytes at those
	 * offsets — leaving every other byte of the author's page exactly as written.
	 */
	source: {
		attrs: Record<string, { end: number; start: number }>
		end: number
		markup: string
		start: number
	} | null
	/** Lowercased by the parser. */
	tagName: string
	/**
	 * Concatenated text of this element's subtree, entity-decoded. Comments are
	 * NOT text — markup hidden in a comment reaches a raw-HTML fetcher but never
	 * appears here, so a rule written over `text` alone does not see it.
	 */
	text: string
}

function isElement(node: Parse5Node): node is Parse5Element {
	return "tagName" in node
}

function isText(node: Parse5Node): node is Parse5Text {
	return node.nodeName === "#text"
}

/**
 * A `<template>`'s children hang off `content`, not `childNodes`. They are
 * included: the text is in the served bytes either way, and omitting them would
 * silently narrow every check that walks the document.
 */
function childrenOf(node: Parse5Node): Parse5Node[] {
	if (isElement(node) && node.tagName === "template" && "content" in node) {
		return node.content.childNodes
	}
	return "childNodes" in node ? node.childNodes : []
}

function textOf(node: Parse5Node): string {
	if (isText(node)) {
		return node.value
	}
	return childrenOf(node)
		.map((child) => textOf(child))
		.join("")
}

function toHtmlElement(html: string, element: Parse5Element): HtmlElement {
	const attrs: Record<string, string> = Object.create(null)
	for (const attr of element.attrs) {
		if (!Object.hasOwn(attrs, attr.name)) {
			attrs[attr.name] = attr.value
		}
	}
	const location = element.sourceCodeLocation
	if (location === undefined || location === null) {
		return { attrs, source: null, tagName: element.tagName, text: textOf(element) }
	}
	const attrSource: Record<string, { end: number; start: number }> = Object.create(null)
	for (const [name, range] of Object.entries(location.attrs ?? {})) {
		attrSource[name] = { end: range.endOffset, start: range.startOffset }
	}
	return {
		attrs,
		source: {
			attrs: attrSource,
			end: location.endOffset,
			markup: html.slice(location.startOffset, location.endOffset),
			start: location.startOffset,
		},
		tagName: element.tagName,
		text: textOf(element),
	}
}

/**
 * Where `</body>` begins, or null when the document has no literal closing tag.
 *
 * Locating it by `html.toLowerCase().lastIndexOf("</body>")` and then slicing
 * the ORIGINAL string is a real defect, not a style preference:
 * `String.toLowerCase` is not length-preserving — `"İ"` lowercases to two code
 * units — so every such character before the tag shifted the index and the
 * slice cut the closing tag apart. A Turkish-language trove shipped a corrupted
 * page that passed all seven checks.
 */
export function bodyCloseOffset(html: string): number | null {
	const document = parse(html, { scriptingEnabled: false, sourceCodeLocationInfo: true })
	let offset: number | null = null
	function visit(node: Parse5Node): void {
		if (isElement(node) && node.tagName === "body") {
			offset = node.sourceCodeLocation?.endTag?.startOffset ?? null
		}
		for (const child of childrenOf(node)) {
			visit(child)
		}
	}
	visit(document)
	return offset
}

/** Every element in the document, in source order. */
export function parseElements(html: string): HtmlElement[] {
	const elements: HtmlElement[] = []
	function visit(node: Parse5Node): void {
		if (isElement(node)) {
			elements.push(toHtmlElement(html, node))
		}
		for (const child of childrenOf(node)) {
			visit(child)
		}
	}
	visit(parse(html, { scriptingEnabled: false, sourceCodeLocationInfo: true }))
	return elements
}

/** Validate, extend over following ASCII whitespace, and sort source ranges before cutting. */
function extendedCutRanges(
	html: string,
	ranges: readonly { end: number; start: number }[],
): { end: number; start: number }[] {
	return ranges
		.map(({ end, start }) => {
			// An inverted range would emit html.slice(0, start) and then resume at
			// end < start, DUPLICATING the bytes between them — silent corruption
			// in a function whose whole job is byte-exact editing. Parser offsets
			// are never inverted, so this cannot fire from the real callers; it
			// fails loudly rather than quietly if that ever stops being true.
			if (end < start) {
				throw new Error(`inverted source range: start ${start} is after end ${end}`)
			}
			let stop = end
			while (stop < html.length && /[ \t\r\n\f]/.test(html.charAt(stop))) {
				stop += 1
			}
			return { end: stop, start }
		})
		.sort((a, b) => a.start - b.start)
}

/** Cut parse5 source ranges from the original bytes without decoding or re-encoding them. */
export function cutByteRanges(
	bytes: Uint8Array,
	ranges: readonly { end: number; start: number }[],
): Uint8Array {
	const kept: Uint8Array[] = []
	let cursor = 0
	for (const range of extendedCutRanges(htmlParserInput(bytes), ranges)) {
		if (range.start > cursor) {
			kept.push(bytes.subarray(cursor, range.start))
		}
		cursor = Math.max(cursor, range.end)
	}
	kept.push(bytes.subarray(cursor))

	const out = new Uint8Array(kept.reduce((size, chunk) => size + chunk.byteLength, 0))
	let offset = 0
	for (const chunk of kept) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return out
}

/** Whether `element` lies inside `container`'s source range — used to scope a scan around the mandated block without re-parsing. */
export function isInside(element: HtmlElement, container: HtmlElement): boolean {
	if (element.source === null || container.source === null) {
		return false
	}
	return (
		element.source.start >= container.source.start &&
		element.source.end <= container.source.end
	)
}
