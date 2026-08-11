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
	type ArtifactManifest,
	canonicalUrlForId,
	MANDATED_SCRIPT_TAG,
	manifestSchema,
	renderMandatedBlock,
} from "@usecontextlayer/trove-standard"
import mime from "mime"

// Assembly (§8 step 2): the creator's files, the mandated block injected into
// index.html (generated when the creator did not author one), the generated
// artifact.json, generated host headers. Pure file-level work — deploying and
// registering live elsewhere.

/** Lineage marker remix writes and publish reads; never artifact content. */
export const REMIX_MARKER_FILE = ".trove-parent.json"

// Entries that never become artifact content: the lineage marker, VCS state,
// OS noise, and the two files the assembly itself generates fresh.
const EXCLUDED_ROOT_ENTRIES = new Set([
	REMIX_MARKER_FILE,
	".git",
	"_headers",
	"artifact.json",
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
 * remixed index.html carries the parent's block with its data-trove attribute
 * cleared, and two blocks would make the served page ambiguous. The div regex
 * targets our own generated markup shape (no nested divs exist in it; a
 * hand-mangled block fails conformance either way).
 */
function stripMandatedBlock(html: string): string {
	return html
		.replace(/<div data-trove[^>]*>[\s\S]*?<\/div>\s*/g, "")
		.replaceAll(`${MANDATED_SCRIPT_TAG}\n`, "")
		.replaceAll(MANDATED_SCRIPT_TAG, "")
}

function injectBlock(html: string, id: string): string {
	const block = renderMandatedBlock(id)
	const stripped = stripMandatedBlock(html)
	const bodyClose = stripped.toLowerCase().lastIndexOf("</body>")
	if (bodyClose === -1) {
		return `${stripped}\n${block}\n`
	}
	return `${stripped.slice(0, bodyClose)}${block}\n${stripped.slice(bodyClose)}`
}

/**
 * The human page the CLI generates when the creator did not author one (§2.1).
 * Contains no hidden text outside the mandated block — a constraint every
 * generated page must respect (check 7 is gating and absolute).
 */
function generateIndexHtml(sourceDir: string, id: string): string {
	const agentsMd = readFileSync(path.join(sourceDir, "AGENTS.md"), "utf8")
	const title = agentsMd.match(/^#\s+(.+)$/m)?.[1] ?? "A Trove artifact"
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
<p>This is a Trove artifact — a set of files any AI agent can fetch, verify, and remix from this URL. Its manual is at <a href="/AGENTS.md">AGENTS.md</a> and its inventory at <a href="/artifact.json">artifact.json</a>.</p>
${renderMandatedBlock(id)}
</body>
</html>
`
}

export function assembleArtifact(options: AssembleOptions): ArtifactManifest {
	const { destDir, id, parent, parentDigest, sourceDir } = options

	if (!existsSync(path.join(sourceDir, "AGENTS.md"))) {
		throw new Error(
			`${sourceDir} has no AGENTS.md — every artifact requires one (§2.2): the creator's manual for the agent that arrives later.`,
		)
	}
	if (existsSync(path.join(sourceDir, "_headers"))) {
		throw new Error(
			`${sourceDir} contains a _headers file. Publishing generates the host headers (unconditional noindex); creator-authored _headers are not supported yet — remove it.`,
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
	const indexHtml = existsSync(sourceIndex)
		? injectBlock(readFileSync(sourceIndex, "utf8"), id)
		: generateIndexHtml(sourceDir, id)
	writeFileSync(path.join(destDir, "index.html"), indexHtml)

	// The manifest lists what returns 200 at the path that returns it: the index
	// page as "/", never "/index.html" (the host 307s the latter), and neither
	// artifact.json (it cannot carry its own digest) nor _headers (consumed by
	// the host, not served).
	const servedFiles = new Set(walkFiles(destDir))
	servedFiles.delete("index.html")
	const files = [...servedFiles].sort().map((file) => {
		const content = readFileSync(path.join(destDir, file))
		const mediaType = mime.getType(file)
		if (mediaType === null) {
			throw new Error(
				`Cannot resolve a media type for "${file}" — give it a file extension. The manifest must record the type the host will serve.`,
			)
		}
		return {
			digest: digestOf(content),
			mediaType,
			path: `/${file}`,
			size: content.byteLength,
		}
	})
	const indexContent = readFileSync(path.join(destDir, "index.html"))
	files.unshift({
		digest: digestOf(indexContent),
		mediaType: "text/html",
		path: "/",
		size: indexContent.byteLength,
	})

	const manifest = manifestSchema.parse({
		canonical: canonicalUrlForId(id),
		files,
		id,
		...(parent === undefined ? {} : { parent, parentDigest }),
		standard: 1,
	})

	writeFileSync(
		path.join(destDir, "artifact.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	)
	writeFileSync(path.join(destDir, "_headers"), "/*\n  X-Robots-Tag: noindex\n")

	return manifest
}
