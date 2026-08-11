import { MANDATED_SCRIPT_TAG, matchesMandatedDiv } from "@/lib/block"
import { isWellFormedId } from "@/lib/id"
import { manifestSchema, type TroveManifest } from "@/lib/manifest"
import { AGENTS_MD_PATH, INDEX_PATH, MANIFEST_PATH } from "@/lib/paths"

// The §6.1 contract checker — ONE implementation running in three positions
// (the creator's machine before publishing, the registry at registration, a
// remixing agent before trusting a trove), so certification can never
// drift from authoring. Positions differ only in the TroveReader adapter
// (HTTP here; the CLI supplies a local-folder adapter applying the serving
// rules it generates) and in the `expectedId` input — never in the rules.

/** What a position can see for one served path — the normalized trove view. */
export interface TroveResponse {
	bytes: Uint8Array
	contentType: string | null
	/** Whether the response carried X-Robots-Tag: noindex (§5). */
	noindex: boolean
	ok: boolean
	status: number
}

export type TroveReader = (path: string) => Promise<TroveResponse>

export type ContractCheckName =
	| "mandated-block"
	| "manifest"
	| "agents-md"
	| "files"
	| "noindex"
	| "caps"
	| "anti-cloaking"

export interface ContractCheck {
	detail?: string
	name: ContractCheckName
	ok: boolean
}

export interface ContractCheckReport {
	checks: ContractCheck[]
	ok: boolean
}

export interface CheckTroveResult {
	/** The parsed manifest when one was served and schema-valid, else null. */
	manifest: TroveManifest | null
	report: ContractCheckReport
}

// Check 6's caps (§6.1): safely below the reference host's own ceiling, so
// anything passing can always deploy. Easy to raise later; lowering would
// break published troves.
export const MAX_FILES = 1000
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024

/** The HTTP adapter — the registry's and a remixing agent's position. */
export function httpReader(baseUrl: string): TroveReader {
	return async (path) => {
		const response = await fetch(new URL(path, baseUrl))
		const bytes = new Uint8Array(await response.arrayBuffer())
		return {
			bytes,
			contentType: response.headers.get("content-type"),
			noindex: (response.headers.get("x-robots-tag") ?? "").includes("noindex"),
			ok: response.ok,
			status: response.status,
		}
	}
}

/** Media-type essence: the served Content-Type minus parameters — the host appends `; charset=utf-8` to text types (measured). */
function essence(contentType: string | null): string | null {
	const bare = contentType?.split(";")[0]?.trim().toLowerCase()
	return bare === undefined || bare === "" ? null : bare
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		bytes as Uint8Array<ArrayBuffer>,
	)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Extract the mandated div's verbatim markup. First occurrence, to the first
 * closing tag — sound because the template contains no nested div: a compliant
 * block extracts exactly, and a mangled one fails the normalize-compare either
 * way (no false passes possible).
 */
function extractMandatedDiv(html: string): string | null {
	const start = html.indexOf('<div data-trove="')
	if (start === -1) {
		return null
	}
	const end = html.indexOf("</div>", start)
	if (end === -1) {
		return null
	}
	return html.slice(start, end + "</div>".length)
}

/**
 * Check 7's v1 detection scope, verbatim from the standard: `display:none` and
 * `visibility:hidden` as inline styles, and the `hidden` and `aria-hidden`
 * attributes — in the served HTML, outside the mandated block. Hiding via CSS
 * classes, stylesheets, positioning, or color is a violation of the RULE but
 * is not caught at v1; stated there so the check never advertises coverage it
 * does not have. Quoted attribute VALUES are blanked before the attribute-name
 * scan so `class="hidden md:block"` never false-positives.
 */
function findHiddenTextViolations(html: string, mandatedDiv: string | null): string[] {
	const scope = mandatedDiv === null ? html : html.replace(mandatedDiv, "")
	const violations: string[] = []
	for (const tag of scope.match(/<[a-zA-Z][^>]*>/g) ?? []) {
		const style =
			tag.match(/style\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/style\s*=\s*'([^']*)'/i)?.[1]
		if (
			style !== undefined &&
			/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
		) {
			violations.push(tag)
			continue
		}
		const withoutValues = tag.replace(/"[^"]*"|'[^']*'/g, '""')
		if (/[\s"]hidden(?=[\s=/>])/i.test(withoutValues)) {
			violations.push(tag)
			continue
		}
		if (
			/aria-hidden/i.test(withoutValues) &&
			!/aria-hidden\s*=\s*["']?false["']?/i.test(tag)
		) {
			violations.push(tag)
		}
	}
	return violations
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size))
	}
	return chunks
}

/** Run the §6.1 contract checks over one trove. `expectedId` is the registry position's input: the id being registered. */
export async function checkTrove(options: {
	expectedId?: string
	read: TroveReader
}): Promise<CheckTroveResult> {
	const { expectedId, read } = options

	// One read per path, shared across checks — check 1 and check 4 both need
	// "/", and every read feeds check 5.
	const cache = new Map<string, Promise<{ error?: string; response?: TroveResponse }>>()
	function readOnce(path: string): Promise<{ error?: string; response?: TroveResponse }> {
		let pending = cache.get(path)
		if (pending === undefined) {
			pending = read(path).then(
				(response) => ({ response }),
				(error: unknown) => ({ error: String(error) }),
			)
			cache.set(path, pending)
		}
		return pending
	}

	const checks: ContractCheck[] = []
	const noindexMisses: string[] = []
	function trackNoindex(path: string, response: TroveResponse): void {
		if (!response.noindex) {
			noindexMisses.push(path)
		}
	}

	// Check 1 — GET / is 200 text/html carrying both halves of the mandated
	// block, present and unmodified, with a well-formed id.
	const index = await readOnce(INDEX_PATH)
	let indexHtml = ""
	let mandatedDiv: string | null = null
	let blockId: string | null = null
	{
		let detail: string | undefined
		if (index.response === undefined || !index.response.ok) {
			detail = `GET / failed: ${index.error ?? `status ${index.response?.status}`}`
		} else if (essence(index.response.contentType) !== "text/html") {
			detail = `GET / served ${index.response.contentType ?? "no content type"}, expected text/html`
		} else {
			trackNoindex(INDEX_PATH, index.response)
			indexHtml = new TextDecoder().decode(index.response.bytes)
			mandatedDiv = extractMandatedDiv(indexHtml)
			blockId = mandatedDiv?.match(/data-trove="([^"]*)"/)?.[1] ?? null
			if (!indexHtml.includes(MANDATED_SCRIPT_TAG)) {
				detail = "the mandated script tag is missing or modified"
			} else if (mandatedDiv === null || blockId === null) {
				detail = "no div[data-trove] found"
			} else if (!isWellFormedId(blockId)) {
				detail = `malformed id on the mandated div: ${JSON.stringify(blockId)}`
			} else if (!matchesMandatedDiv(mandatedDiv, blockId)) {
				detail =
					"the mandated div's text does not match the template (substitute, normalize, compare)"
			}
		}
		checks.push({
			name: "mandated-block",
			ok: detail === undefined,
			...(detail === undefined ? {} : { detail }),
		})
	}

	// Check 2 — the manifest: 200 application/json, schema-valid (the schema
	// itself enforces canonical-derived-from-id), one identity across every
	// surface: block id = manifest id = (when given) the id being registered.
	const manifestRead = await readOnce(MANIFEST_PATH)
	let manifest: TroveManifest | null = null
	{
		let detail: string | undefined
		if (manifestRead.response === undefined || !manifestRead.response.ok) {
			detail = `GET ${MANIFEST_PATH} failed: ${manifestRead.error ?? `status ${manifestRead.response?.status}`}`
		} else if (essence(manifestRead.response.contentType) !== "application/json") {
			detail = `${MANIFEST_PATH} served ${manifestRead.response.contentType ?? "no content type"}, expected application/json`
		} else {
			trackNoindex(MANIFEST_PATH, manifestRead.response)
			try {
				const parsed = manifestSchema.safeParse(
					JSON.parse(new TextDecoder().decode(manifestRead.response.bytes)),
				)
				if (!parsed.success) {
					detail = `${MANIFEST_PATH} failed schema validation`
				} else {
					manifest = parsed.data
					if (expectedId !== undefined && manifest.id !== expectedId) {
						detail = `manifest id ${manifest.id} does not match the expected id ${expectedId}`
					} else if (blockId !== null && manifest.id !== blockId) {
						detail = `manifest id ${manifest.id} does not match the mandated block's id ${blockId}`
					}
				}
			} catch {
				detail = `${MANIFEST_PATH} is not valid JSON`
			}
		}
		checks.push({
			name: "manifest",
			ok: detail === undefined,
			...(detail === undefined ? {} : { detail }),
		})
	}

	// Check 3 — AGENTS.md: 200 text/markdown, non-empty.
	const agents = await readOnce(AGENTS_MD_PATH)
	{
		let detail: string | undefined
		if (agents.response === undefined || !agents.response.ok) {
			detail = `GET ${AGENTS_MD_PATH} failed: ${agents.error ?? `status ${agents.response?.status}`}`
		} else if (essence(agents.response.contentType) !== "text/markdown") {
			detail = `${AGENTS_MD_PATH} served ${agents.response.contentType ?? "no content type"}, expected text/markdown`
		} else if (new TextDecoder().decode(agents.response.bytes).trim() === "") {
			detail = `${AGENTS_MD_PATH} is empty`
		} else {
			trackNoindex(AGENTS_MD_PATH, agents.response)
		}
		checks.push({
			name: "agents-md",
			ok: detail === undefined,
			...(detail === undefined ? {} : { detail }),
		})
	}

	// Check 4 — every path in files[] returns 200 with matching media-type
	// essence, decoded byte length, and digest. Check 6 — the caps, computed
	// over the actually-fetched bytes. Reads run in small batches: workerd
	// allows only 6 simultaneous connections.
	let totalBytes = 0
	if (manifest === null) {
		checks.push({ detail: "not checked: no valid manifest", name: "files", ok: false })
		checks.push({ detail: "not checked: no valid manifest", name: "caps", ok: false })
	} else {
		const failures: string[] = []
		for (const batch of chunk(manifest.files, 5)) {
			await Promise.all(
				batch.map(async (file) => {
					const { error, response } = await readOnce(file.path)
					if (response === undefined || !response.ok) {
						failures.push(`${file.path}: ${error ?? `status ${response?.status}`}`)
						return
					}
					trackNoindex(file.path, response)
					totalBytes += response.bytes.byteLength
					if (essence(response.contentType) !== file.mediaType.toLowerCase()) {
						failures.push(
							`${file.path}: served ${response.contentType ?? "no content type"}, manifest says ${file.mediaType}`,
						)
					}
					if (response.bytes.byteLength !== file.size) {
						failures.push(
							`${file.path}: ${response.bytes.byteLength} bytes served, manifest says ${file.size}`,
						)
					}
					const digest = `sha256:${await sha256Hex(response.bytes)}`
					if (digest !== file.digest) {
						failures.push(`${file.path}: digest mismatch`)
					}
				}),
			)
		}
		checks.push({
			name: "files",
			ok: failures.length === 0,
			...(failures.length === 0 ? {} : { detail: failures.slice(0, 5).join("; ") }),
		})

		const capFailures: string[] = []
		if (manifest.files.length > MAX_FILES) {
			capFailures.push(`${manifest.files.length} files exceeds the ${MAX_FILES}-file cap`)
		}
		if (totalBytes > MAX_TOTAL_BYTES) {
			capFailures.push(`${totalBytes} bytes exceeds the ${MAX_TOTAL_BYTES}-byte cap`)
		}
		checks.push({
			name: "caps",
			ok: capFailures.length === 0,
			...(capFailures.length === 0 ? {} : { detail: capFailures.join("; ") }),
		})
	}

	// Check 5 — X-Robots-Tag: noindex on every response seen (§5).
	checks.push({
		name: "noindex",
		ok: noindexMisses.length === 0,
		...(noindexMisses.length === 0
			? {}
			: { detail: `missing noindex on: ${noindexMisses.slice(0, 5).join(", ")}` }),
	})

	// Check 7 — anti-cloaking, gating and absolute: hidden text may exist only
	// inside the mandated block.
	{
		const violations =
			indexHtml === "" ? [] : findHiddenTextViolations(indexHtml, mandatedDiv)
		checks.push({
			name: "anti-cloaking",
			ok: violations.length === 0,
			...(violations.length === 0
				? {}
				: {
						detail: `hidden text outside the mandated block: ${violations.slice(0, 3).join(" ")}`,
					}),
		})
	}

	return {
		manifest,
		report: { checks, ok: checks.every((check) => check.ok) },
	}
}
