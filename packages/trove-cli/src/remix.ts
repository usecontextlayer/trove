import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { manifestSchema, parseElements } from "@usecontextlayer/trove-standard"
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
 * The remix argument is the trove's OWN URL — the one address a trove has, and
 * the one that gets recorded as `parent`.
 *
 * The one confusion worth naming is a registry lookup URL (`<registry>/a/<id>`).
 * It is not a trove URL: it 302s to one, and its subtree does not exist, so
 * every path built under it 404s. An agent that reaches for it has almost
 * certainly read the record and taken the wrong field, so the message names the
 * right one.
 */
export function parseTroveUrl(registryUrl: string, from: string): string {
	let url: URL
	try {
		url = new URL(from)
	} catch {
		throw new Error(`"${from}" is not a URL. trove remix takes the trove's URL.`)
	}
	if (url.origin === new URL(registryUrl).origin) {
		throw new Error(
			`${from} is a Trove registry URL, not a trove. Pass the trove's own URL — the registry publishes it as "hostUrl" at ${registryUrl}/a/<id>.json.`,
		)
	}
	// §2.1: troves live at a host root, and this is the boundary that has to say
	// so. A URL carrying a path parses fine and then resolves every manifest
	// entry against the wrong base — a silently wrong remix rather than a
	// refusal. Returning the origin would drop the path just as silently, so it
	// is rejected instead, naming the URL that would have worked.
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		throw new Error(
			`${from} carries a path, query, or fragment. A trove is served at a host root, so its URL is just the origin — try ${url.origin}.`,
		)
	}
	return url.origin
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
	destDir?: string
	troveUrl: string
}): Promise<{ destDir: string; fileCount: number }> {
	const { troveUrl } = options

	// Hash the manifest bytes exactly as fetched — this pins WHICH version was
	// remixed, since troves are mutable and redeploy in place.
	const manifestResponse = await fetch(`${troveUrl}/trove.json`)
	if (!manifestResponse.ok) {
		throw new Error(
			`${troveUrl}/trove.json answered ${manifestResponse.status} — not a readable trove.`,
		)
	}
	const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer())
	const parentDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`
	const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")))

	// The default destination is named from the trove's real id, which is only
	// known once the manifest is read — a trove's URL no longer contains it.
	const destDir = options.destDir ?? `./trove-remix-${manifest.id.slice(0, 8)}`
	if (existsSync(destDir) && readdirSync(destDir).length > 0) {
		throw new Error(`${destDir} is not empty.`)
	}

	mkdirSync(destDir, { recursive: true })

	for (const file of manifest.files) {
		const response = await fetch(`${troveUrl}${file.path}`)
		if (!response.ok) {
			throw new Error(`${troveUrl}${file.path} answered ${response.status}.`)
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
	const marker: RemixMarker = { parent: troveUrl, parentDigest }
	writeFileSync(
		path.join(destDir, REMIX_MARKER_FILE),
		`${JSON.stringify(marker, null, "\t")}\n`,
	)

	return { destDir, fileCount: manifest.files.length }
}
