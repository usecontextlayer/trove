import { isUtf8 } from "node:buffer"
import { createHash } from "node:crypto"
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import * as path from "node:path"
import {
	bodyCloseOffset,
	CURRENT_STANDARD,
	cutRanges,
	MANDATED_SCRIPT_SRC,
	manifestSchema,
	parseElements,
	renderMandatedBlock,
	type TroveManifest,
} from "@usecontextlayer/trove-standard"
import mime from "mime"
import { WRITING_TROVES_URL } from "@/src/env"

// Assembly (§8 step 2): the creator's files, the mandated block injected into
// index.html (generated when the creator did not author one), the generated
// trove.json, generated host headers. Pure file-level work — deploying and
// registering live elsewhere.

/** Lineage marker remix writes and publish reads; never trove content. */
export const REMIX_MARKER_FILE = ".trove-parent.json"

// Entries that never become trove content: the lineage marker, VCS state,
// OS noise, and the two files the assembly itself generates fresh.
const EXCLUDED_ROOT_ENTRIES = new Set([
	REMIX_MARKER_FILE,
	".git",
	"_headers",
	"trove.json",
])
const EXCLUDED_EVERYWHERE = new Set([".DS_Store"])

export interface AssembleOptions {
	destDir: string
	id: string
	parent?: string
	parentDigest?: string
	sourceDir: string
}

function walkFiles(dir: string, relative = ""): string[] {
	const files: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (EXCLUDED_EVERYWHERE.has(entry.name)) {
			continue
		}
		if (relative === "" && EXCLUDED_ROOT_ENTRIES.has(entry.name)) {
			continue
		}
		const entryRelative = relative === "" ? entry.name : `${relative}/${entry.name}`
		if (entry.isDirectory()) {
			files.push(...walkFiles(path.join(dir, entry.name), entryRelative))
		} else {
			files.push(entryRelative)
		}
	}
	return files.sort()
}

function digestOf(content: Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

/**
 * Remove any prior mandated-block remnants before injecting a fresh one — a
 * remixed index.html carries the parent's block, and a second div[data-trove]
 * is a conformance failure in its own right.
 *
 * Matched structurally: a div whose attribute name is EXACTLY `data-trove`.
 * The regex this replaces had no attribute-name boundary, so a creator's own
 * `<div data-trove-count="3">…</div>` was silently deleted from their published
 * page — and its non-greedy `</div>` stop left an orphan closing tag behind
 * whenever the div had a nested one.
 */
function stripMandatedBlock(html: string): string {
	const ranges = parseElements(html)
		.filter(
			(element) =>
				(element.tagName === "div" && Object.hasOwn(element.attrs, "data-trove")) ||
				(element.tagName === "script" && element.attrs.src === MANDATED_SCRIPT_SRC),
		)
		.flatMap((element) => (element.source === null ? [] : [element.source]))
	return cutRanges(html, ranges)
}

function injectBlock(html: string, id: string): string {
	const block = renderMandatedBlock(id)
	const stripped = stripMandatedBlock(html)
	const bodyClose = bodyCloseOffset(stripped)
	if (bodyClose === null) {
		return `${stripped}\n${block}\n`
	}
	return `${stripped.slice(0, bodyClose)}${block}\n${stripped.slice(bodyClose)}`
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
}

/**
 * The human page the CLI generates when the creator did not author one (§2.1).
 * Contains no hidden text outside the mandated block — a constraint every
 * generated page must respect (check 7 is gating and absolute).
 *
 * The heading it lifts is the creator's prose, and after a remix it is a
 * STRANGER's prose — this function runs whenever the folder has no index.html,
 * which is what a remix of a trove whose manifest omits "/" produces.
 * Interpolated raw it put arbitrary markup, including a live `<script>`, on the
 * republisher's own origin under their own id, so it is escaped.
 */
function generateIndexHtml(sourceDir: string, id: string): string {
	const agentsMd = readFileSync(path.join(sourceDir, "AGENTS.md"), "utf8")
	const title = escapeHtml(agentsMd.match(/^#\s+(.+)$/m)?.[1] ?? "A trove")
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body { max-width: 42rem; margin: 3rem auto; padding: 0 1rem; font: 16px/1.6 system-ui, sans-serif; }</style>
</head>
<body>
<h1>${title}</h1>
<p>This is a trove — a set of files any AI agent can fetch, verify, and remix from this URL. Its manual is at <a href="/AGENTS.md">AGENTS.md</a> and its inventory at <a href="/trove.json">trove.json</a>.</p>
${renderMandatedBlock(id)}
</body>
</html>
`
}

/** One file as the host will serve it, before the manifest reduces it to a digest. */
interface ServedFile {
	content: Buffer
	mediaType: string
	path: string
}

/**
 * The host headers the assembly generates (§5): unconditional noindex, and
 * `charset=utf-8` on text types whose bytes ARE UTF-8.
 *
 * The charset is the fix for agent-facing mojibake. The host declares no encoding
 * of its own (measured), and markdown has no in-band mechanism the way HTML has
 * `<meta charset>` — so AGENTS.md served bare decodes as CP1252 and an em dash
 * reaches the reader as "â€”".
 *
 * It is declared ONLY where it is true. A trove may serve text in any encoding,
 * and a declared charset outranks both the bytes' own signals and, for HTML,
 * `<meta charset>` — so declaring utf-8 over Latin-1 would corrupt the file while
 * every check stayed green, which is the failure this change exists to remove,
 * not to reintroduce. Text that is not UTF-8 keeps the host's default handling:
 * exactly how it behaves today, neither fixed nor broken.
 *
 * Rules are keyed by EXTENSION, never by path: the host caps `_headers` at 100
 * rules while a conformant trove may carry 1,000 files. So an extension earns its
 * rule only when EVERY file carrying it is UTF-8 — one mixed extension withholds
 * the rule from its siblings rather than mislabelling one of them. `/*.<ext>`
 * matches at any depth (measured), and "/" needs a rule of its own because the
 * index is served there rather than at /index.html.
 */
function renderHostHeaders(served: readonly ServedFile[]): string {
	const rules = ["/*\n  X-Robots-Tag: noindex\n"]

	const index = served.find((file) => file.path === "/")
	if (index !== undefined && isUtf8(index.content)) {
		rules.push(`/\n  Content-Type: ${index.mediaType}; charset=utf-8\n`)
	}

	const byExtension = new Map<string, { mediaType: string; utf8: boolean }>()
	for (const file of served) {
		const extension = path.extname(file.path).slice(1).toLowerCase()
		if (extension === "" || !file.mediaType.startsWith("text/")) {
			continue
		}
		const seen = byExtension.get(extension)
		byExtension.set(extension, {
			mediaType: file.mediaType,
			utf8: (seen === undefined || seen.utf8) && isUtf8(file.content),
		})
	}
	for (const [extension, entry] of [...byExtension].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (entry.utf8) {
			rules.push(`/*.${extension}\n  Content-Type: ${entry.mediaType}; charset=utf-8\n`)
		}
	}

	return rules.join("\n")
}

export function assembleTrove(options: AssembleOptions): TroveManifest {
	const { destDir, id, parent, parentDigest, sourceDir } = options

	if (!existsSync(path.join(sourceDir, "AGENTS.md"))) {
		// The URL is here because this is the moment a creator needs it and there
		// was no route to it: measured, an agent hitting this message spent six
		// tool calls and 84 seconds recovering the address by publishing a
		// throwaway trove, serving it, and reading it out of the injected block.
		// A section number cites a document; it does not tell you where it is.
		throw new Error(
			`${sourceDir} has no AGENTS.md — every trove requires one (§2.2): the creator's manual for the agent that arrives later. What belongs in it: ${WRITING_TROVES_URL}`,
		)
	}
	if (existsSync(path.join(sourceDir, "_headers"))) {
		throw new Error(
			`${sourceDir} contains a _headers file. Publishing generates the host headers (unconditional noindex, plus charset=utf-8 on UTF-8 text types); creator-authored _headers are not supported yet — remove it.`,
		)
	}
	if (existsSync(destDir) && readdirSync(destDir).length > 0) {
		throw new Error(`Assembly target ${destDir} is not empty.`)
	}

	mkdirSync(destDir, { recursive: true })

	// Copy the creator's files, then overwrite index.html with the injected (or
	// generated) page.
	const sourceFiles = walkFiles(sourceDir)
	for (const file of sourceFiles) {
		const target = path.join(destDir, file)
		mkdirSync(path.dirname(target), { recursive: true })
		copyFileSync(path.join(sourceDir, file), target)
	}

	const sourceIndex = path.join(sourceDir, "index.html")
	const destIndex = path.join(destDir, "index.html")
	if (existsSync(sourceIndex)) {
		// index.html is the ONE file that round-trips through a JS string —
		// every other file is copied byte-for-byte. Reading it as "utf8"
		// replaced each non-UTF-8 byte with U+FFFD, and the manifest digest was
		// then computed over the mojibake, so an ISO-8859-1 page shipped
		// corrupted with all seven checks green. latin1 maps one byte to one
		// code unit in both directions, so any encoding survives; the injected
		// block is pure ASCII and parse5's offsets stay byte offsets.
		writeFileSync(
			destIndex,
			injectBlock(readFileSync(sourceIndex, "latin1"), id),
			"latin1",
		)
	} else {
		writeFileSync(destIndex, generateIndexHtml(sourceDir, id))
	}

	// The manifest lists what returns 200 at the path that returns it: the index
	// page as "/", never "/index.html" (the host 307s the latter), and neither
	// trove.json (it cannot carry its own digest) nor _headers (consumed by
	// the host, not served).
	const servedFiles = new Set(walkFiles(destDir))
	servedFiles.delete("index.html")
	// One list of what the host will serve, and both outputs are derived from it:
	// the manifest reduces each entry to a digest, the generated _headers reads
	// the same entries' bytes to decide which types can declare a charset.
	const served: ServedFile[] = [
		{
			content: readFileSync(path.join(destDir, "index.html")),
			mediaType: "text/html",
			path: "/",
		},
		...[...servedFiles].sort().map((file) => {
			const mediaType = mime.getType(file)
			if (mediaType === null) {
				throw new Error(
					`Cannot resolve a media type for "${file}" — give it a file extension. The manifest must record the type the host will serve.`,
				)
			}
			return {
				content: readFileSync(path.join(destDir, file)),
				mediaType,
				path: `/${file}`,
			}
		}),
	]
	const files = served.map((file) => ({
		digest: digestOf(file.content),
		mediaType: file.mediaType,
		path: file.path,
		size: file.content.byteLength,
	}))

	// No self-reference: the trove's URL is assigned by the host at deploy time,
	// which is after this runs. A manifest that named its own URL would force a
	// second deploy and break the guarantee that the bytes checked are the bytes
	// shipped.
	const manifest = manifestSchema.parse({
		files,
		id,
		...(parent === undefined ? {} : { parent, parentDigest }),
		standard: CURRENT_STANDARD,
	})

	writeFileSync(
		path.join(destDir, "trove.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	)
	writeFileSync(path.join(destDir, "_headers"), renderHostHeaders(served))

	return manifest
}
