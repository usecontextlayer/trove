import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import {
	ID_PATTERN,
	manifestSchema,
	parseElements,
} from "@usecontextlayer/trove-standard"
import { REMIX_MARKER_FILE } from "@/src/assemble"

// Remixing (§9): fetch is where lineage is captured and inherited identity is
// removed. parentDigest is computed AT FETCH TIME by hashing the parent's
// trove.json as fetched — the only moment the value is true — and written
// with parent into the local marker the publish step reads.

export interface RemixMarker {
	parent: string
	parentDigest: string
}

export function readRemixMarker(sourceDir: string): RemixMarker | null {
	const markerPath = path.join(sourceDir, REMIX_MARKER_FILE)
	if (!existsSync(markerPath)) {
		return null
	}
	const marker = JSON.parse(readFileSync(markerPath, "utf8")) as RemixMarker
	if (typeof marker.parent !== "string" || typeof marker.parentDigest !== "string") {
		throw new Error(`${markerPath} is malformed — expected { parent, parentDigest }.`)
	}
	return marker
}

/**
 * The remix argument is the CANONICAL URL, never a host URL (§9) — canonical is
 * the identity, and it is what gets recorded as parent. §9 also ruled that
 * remixing is a command, not a flag; the rejected `--from` spelling survived in
 * this message, so an agent that got the argument wrong was corrected toward an
 * option the CLI does not have and failed twice on one mistake.
 */
export function parseCanonicalUrl(registryUrl: string, from: string): string {
	const prefix = `${registryUrl}/a/`
	const id = from.startsWith(prefix) ? from.slice(prefix.length) : null
	if (id === null || !ID_PATTERN.test(id)) {
		throw new Error(
			`trove remix takes the trove's canonical URL (${registryUrl}/a/<id>), not a host URL. The canonical URL is in the trove's own trove.json.`,
		)
	}
	return from
}

/**
 * Clear the parent's identity from the copied page (§9). The attribute's own
 * source range is spliced, so every other byte of the parent's markup survives
 * exactly as served — publish then strips the remnant block and injects a fresh
 * one.
 */
function clearInheritedIdentity(html: string): string {
	const div = parseElements(html).find(
		(element) => element.tagName === "div" && Object.hasOwn(element.attrs, "data-trove"),
	)
	const range = div?.source?.attrs["data-trove"]
	if (range === undefined) {
		return html
	}
	return `${html.slice(0, range.start)}data-trove=""${html.slice(range.end)}`
}

export async function remixTrove(options: {
	canonicalUrl: string
	destDir: string
}): Promise<{ fileCount: number }> {
	const { canonicalUrl, destDir } = options

	if (existsSync(destDir) && readdirSync(destDir).length > 0) {
		throw new Error(`${destDir} is not empty.`)
	}

	// Hash the manifest bytes exactly as fetched — this pins WHICH version was
	// remixed, since troves are mutable and redeploy in place.
	const manifestResponse = await fetch(`${canonicalUrl}/trove.json`)
	if (!manifestResponse.ok) {
		throw new Error(
			`${canonicalUrl}/trove.json answered ${manifestResponse.status} — not a readable trove.`,
		)
	}
	const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer())
	const parentDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`
	const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")))

	mkdirSync(destDir, { recursive: true })

	for (const file of manifest.files) {
		const response = await fetch(`${canonicalUrl}${file.path}`)
		if (!response.ok) {
			throw new Error(`${canonicalUrl}${file.path} answered ${response.status}.`)
		}
		const content = Buffer.from(await response.arrayBuffer())
		const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`
		if (digest !== file.digest) {
			throw new Error(
				`${file.path}: served bytes hash to ${digest}, manifest says ${file.digest}. The trove does not match its own record — do not trust it.`,
			)
		}
		if (content.byteLength !== file.size) {
			throw new Error(
				`${file.path}: served ${content.byteLength} bytes, manifest says ${file.size}.`,
			)
		}
		// "/" is the index page's manifest entry; it lands on disk as index.html.
		const relative = file.path === "/" ? "index.html" : file.path.slice(1)
		const target = path.resolve(destDir, relative)
		// §3 requires every consumer writing a trove path to disk to verify the
		// resolved location stays inside its destination. The path grammar in
		// the manifest schema already rejects `..`, which is why this can no
		// longer fire — it is kept because the failure it prevents is writing a
		// stranger's bytes to an arbitrary path on the remixer's machine.
		const root = path.resolve(destDir)
		if (target !== root && !target.startsWith(root + path.sep)) {
			throw new Error(
				`${file.path} resolves outside ${destDir} — refusing to write it. The trove's manifest is malformed.`,
			)
		}
		mkdirSync(path.dirname(target), { recursive: true })
		// Inherited identity is stripped at fetch time (§9).
		if (relative === "index.html") {
			writeFileSync(target, clearInheritedIdentity(content.toString("utf8")))
		} else {
			writeFileSync(target, content)
		}
	}

	// The parent's trove.json is never written — the manifest excludes
	// itself, so the copy is identity-free by construction except the marker.
	const marker: RemixMarker = { parent: canonicalUrl, parentDigest }
	writeFileSync(
		path.join(destDir, REMIX_MARKER_FILE),
		`${JSON.stringify(marker, null, "\t")}\n`,
	)

	return { fileCount: manifest.files.length }
}
