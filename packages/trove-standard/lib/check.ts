import {
	CURRENT_STANDARD,
	MANDATED_SCRIPT_SRC,
	mandatedDivTemplate,
	matchesMandatedDiv,
	matchesMandatedScript,
} from "@/lib/block"
import { type HtmlElement, isInside, parseElements } from "@/lib/html"
import { isWellFormedId } from "@/lib/id"
import { manifestSchema, type TroveManifest } from "@/lib/manifest"
import { AGENTS_MD_PATH, INDEX_PATH, MANIFEST_PATH } from "@/lib/paths"

// The §6.1 contract checker — ONE implementation running in three positions
// (the creator's machine before publishing, the registry at registration, a
// remixing agent before trusting a trove), so certification can never drift
// from authoring. Positions differ in the TroveReader adapter (HTTP here; the
// CLI supplies a local-folder adapter), in the `expectedId` input, and — the
// one deliberate exception — in whether they verify the manifest's files:
// see `verifyFiles`.
//
// A check that could not run reports FAILURE with a "not checked" detail, never
// success. The report is published verbatim at /a/<id>.json, so a check that
// verified nothing must never appear as a green tick.

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

/**
 * The HTTP adapter — the registry's and a remixing agent's position.
 *
 * The path is assigned through the URL object's own setter, which parses it in
 * path-start state and therefore cannot produce an authority: a manifest path
 * of `//evil.example/x` stays a path on the trove's origin instead of resolving
 * to a different host. The post-fetch origin check closes the second route,
 * since `fetch` follows redirects by default.
 */
export function httpReader(baseUrl: string): TroveReader {
	const origin = new URL(baseUrl).origin
	return async (path) => {
		const url = new URL(baseUrl)
		url.pathname = path
		if (url.origin !== origin) {
			throw new Error(`${path} does not resolve inside ${origin}`)
		}
		const response = await fetch(url)
		if (response.url !== "" && new URL(response.url).origin !== origin) {
			throw new Error(`${path} redirected off ${origin} to ${response.url}`)
		}
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
 * Check 7's v1 detection scope: `display:none` and `visibility:hidden` as
 * inline styles, and the `hidden` attribute — anywhere outside the mandated
 * block. Hiding via CSS classes, stylesheets, positioning, or colour violates
 * the RULE but is not caught at v1; stated so the check never advertises
 * coverage it does not have.
 *
 * `aria-hidden` is deliberately NOT a mechanism here. It hides an element from
 * assistive technology while leaving it visible to the human AND to a fetching
 * agent, so it is not a cloaking channel in either direction — and treating it
 * as one hard-failed `<svg aria-hidden="true">`, the standard decorative-icon
 * idiom, with an error claiming hidden text on an element containing none.
 *
 * Attribute values arrive decoded from the parser, so an entity-encoded
 * `display:&#110;one` and an unquoted `style=display:none` are both seen for
 * what they are.
 */
function findHiddenTextViolations(
	elements: readonly HtmlElement[],
	mandatedDiv: HtmlElement | null,
): string[] {
	const violations: string[] = []
	for (const element of elements) {
		if (mandatedDiv !== null && isInside(element, mandatedDiv)) {
			continue
		}
		const style = element.attrs.style ?? ""
		const hidden =
			/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style) ||
			Object.hasOwn(element.attrs, "hidden")
		if (hidden) {
			violations.push(element.source?.markup.split("\n")[0] ?? `<${element.tagName}>`)
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

/**
 * Run the §6.1 contract checks over one trove.
 *
 * `expectedId` is the registry position's input: the id being registered.
 *
 * `verifyFiles` is the registry position's other input. Fetching every manifest
 * entry from inside a Worker is the expensive half of the check and it buys
 * little there — troves redeploy in place, so a digest verified at registration
 * is stale the moment the creator redeploys, and the position that actually
 * needs digests verified is the remixer, who is about to trust the bytes. With
 * it off, checks 4 and 6 report not-checked rather than passing silently.
 */
export async function checkTrove(options: {
	expectedId?: string
	read: TroveReader
	verifyFiles?: boolean
}): Promise<CheckTroveResult> {
	const { expectedId, read, verifyFiles = true } = options

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

	// GATHER — the three required paths. Checks 1 and 2 are mutually dependent
	// (the block is compared against the template for the manifest's OWN
	// standard version; the manifest's id is compared against the block's), so
	// both inputs are obtained before either verdict is formed.
	const [index, manifestRead, agents] = await Promise.all([
		readOnce(INDEX_PATH),
		readOnce(MANIFEST_PATH),
		readOnce(AGENTS_MD_PATH),
	])

	let manifest: TroveManifest | null = null
	let manifestDetail: string | undefined
	if (manifestRead.response === undefined || !manifestRead.response.ok) {
		manifestDetail = `GET ${MANIFEST_PATH} failed: ${manifestRead.error ?? `status ${manifestRead.response?.status}`}`
	} else if (essence(manifestRead.response.contentType) !== "application/json") {
		manifestDetail = `${MANIFEST_PATH} served ${manifestRead.response.contentType ?? "no content type"}, expected application/json`
	} else {
		const text = new TextDecoder().decode(manifestRead.response.bytes)
		let json: unknown
		try {
			json = JSON.parse(text)
		} catch (error) {
			manifestDetail = `${MANIFEST_PATH} is not valid JSON: ${String(error)}`
		}
		if (manifestDetail === undefined) {
			const parsed = manifestSchema.safeParse(json)
			if (parsed.success) {
				manifest = parsed.data
			} else {
				manifestDetail = `${MANIFEST_PATH} failed schema validation`
			}
		}
	}

	// The trove states its own standard version; the block is compared against
	// that version's template. An unknown version is reported as newer rather
	// than as a malformed manifest.
	const standard = manifest?.standard ?? CURRENT_STANDARD
	const knownStandard = mandatedDivTemplate(standard) !== null

	let indexElements: HtmlElement[] | null = null
	let mandatedDiv: HtmlElement | null = null
	let blockId: string | null = null
	let blockDetail: string | undefined
	if (index.response === undefined || !index.response.ok) {
		blockDetail = `GET / failed: ${index.error ?? `status ${index.response?.status}`}`
	} else if (essence(index.response.contentType) !== "text/html") {
		blockDetail = `GET / served ${index.response.contentType ?? "no content type"}, expected text/html`
	} else {
		indexElements = parseElements(new TextDecoder().decode(index.response.bytes))
		const troveDivs = indexElements.filter(
			(element) =>
				element.tagName === "div" && Object.hasOwn(element.attrs, "data-trove"),
		)
		const scripts = indexElements.filter(
			(element) =>
				element.tagName === "script" && element.attrs.src === MANDATED_SCRIPT_SRC,
		)
		if (troveDivs.length === 0) {
			blockDetail = "no div[data-trove] found"
		} else if (troveDivs.length > 1) {
			// One trove, one identity. A second div[data-trove] is what the
			// checker and trove.js can disagree about: the checker took the
			// first literal match, the browser takes the first CSS match, and a
			// decoy placed between them puts attacker text in the drawer on a
			// page certified conformant. Rejecting outright removes the
			// divergence by construction.
			blockDetail = `${troveDivs.length} div[data-trove] elements found — a trove carries exactly one`
		} else {
			mandatedDiv = troveDivs[0] ?? null
			blockId = mandatedDiv?.attrs["data-trove"] ?? null
			const script = scripts[0]
			if (mandatedDiv === null || mandatedDiv.source === null || blockId === null) {
				blockDetail = "no div[data-trove] found"
			} else if (!isWellFormedId(blockId)) {
				blockDetail = `malformed id on the mandated div: ${JSON.stringify(blockId)}`
			} else if (script === undefined || script.source === null) {
				blockDetail = "the mandated script tag is missing or modified"
			} else if (!matchesMandatedScript(script.source.markup)) {
				blockDetail = "the mandated script tag is missing or modified"
			} else if (!knownStandard) {
				blockDetail = `not checked: standard ${standard} is newer than this checker (${CURRENT_STANDARD})`
			} else if (!matchesMandatedDiv(mandatedDiv.source.markup, blockId, standard)) {
				blockDetail =
					"the mandated div's text does not match the template (substitute, normalize, compare)"
			}
		}
	}

	// Check 1 — GET / is 200 text/html carrying both halves of the mandated
	// block, present and unmodified, with a well-formed id.
	checks.push({
		name: "mandated-block",
		ok: blockDetail === undefined,
		...(blockDetail === undefined ? {} : { detail: blockDetail }),
	})

	// Check 2 — the manifest: 200 application/json, schema-valid (the schema
	// itself enforces canonical-derived-from-id), one identity across every
	// surface: block id = manifest id = (when given) the id being registered.
	if (manifest !== null && manifestDetail === undefined) {
		if (!knownStandard) {
			manifestDetail = `standard ${manifest.standard} is newer than this checker (${CURRENT_STANDARD})`
		} else if (expectedId !== undefined && manifest.id !== expectedId) {
			manifestDetail = `manifest id ${manifest.id} does not match the expected id ${expectedId}`
		} else if (blockId !== null && manifest.id !== blockId) {
			manifestDetail = `manifest id ${manifest.id} does not match the mandated block's id ${blockId}`
		}
	}
	checks.push({
		name: "manifest",
		ok: manifestDetail === undefined,
		...(manifestDetail === undefined ? {} : { detail: manifestDetail }),
	})

	// Check 3 — AGENTS.md: 200 text/markdown, non-empty.
	{
		let detail: string | undefined
		if (agents.response === undefined || !agents.response.ok) {
			detail = `GET ${AGENTS_MD_PATH} failed: ${agents.error ?? `status ${agents.response?.status}`}`
		} else if (essence(agents.response.contentType) !== "text/markdown") {
			detail = `${AGENTS_MD_PATH} served ${agents.response.contentType ?? "no content type"}, expected text/markdown`
		} else if (new TextDecoder().decode(agents.response.bytes).trim() === "") {
			detail = `${AGENTS_MD_PATH} is empty`
		}
		checks.push({
			name: "agents-md",
			ok: detail === undefined,
			...(detail === undefined ? {} : { detail }),
		})
	}

	// Check 4 — every path in files[] returns 200 with matching media-type
	// essence, decoded byte length, and digest. Check 6 — the caps. The caps are
	// evaluated on the DECLARED manifest before any file is fetched, so they
	// bound the work rather than describing work already done.
	if (manifest === null) {
		checks.push({ detail: "not checked: no valid manifest", name: "files", ok: false })
		checks.push({ detail: "not checked: no valid manifest", name: "caps", ok: false })
	} else if (!verifyFiles) {
		const reason = "not checked: this position does not verify manifest files"
		checks.push({ detail: reason, name: "files", ok: false })
		checks.push({ detail: reason, name: "caps", ok: false })
	} else {
		const declaredBytes = manifest.files.reduce((total, file) => total + file.size, 0)
		const capFailures: string[] = []
		if (manifest.files.length > MAX_FILES) {
			capFailures.push(`${manifest.files.length} files exceeds the ${MAX_FILES}-file cap`)
		}
		if (declaredBytes > MAX_TOTAL_BYTES) {
			capFailures.push(
				`${declaredBytes} declared bytes exceeds the ${MAX_TOTAL_BYTES}-byte cap`,
			)
		}
		checks.push({
			name: "caps",
			ok: capFailures.length === 0,
			...(capFailures.length === 0 ? {} : { detail: capFailures.join("; ") }),
		})

		if (capFailures.length > 0) {
			checks.push({
				detail: "not checked: the manifest exceeds the caps",
				name: "files",
				ok: false,
			})
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
		}
	}

	// Check 5 — X-Robots-Tag: noindex on every response actually observed (§5).
	// Drained from the read cache rather than accumulated as a side effect of
	// the checks above, so a trove that served nothing reports not-checked
	// instead of passing for want of a counter-example.
	{
		const observed = await Promise.all(
			[...cache.entries()].map(async ([path, pending]) => ({ path, ...(await pending) })),
		)
		const seen = observed.filter((entry) => entry.response !== undefined)
		const misses = seen
			.filter((entry) => entry.response?.noindex !== true)
			.map((entry) => entry.path)
		let detail: string | undefined
		if (seen.length === 0) {
			detail = "not checked: no response was obtained"
		} else if (misses.length > 0) {
			detail = `missing noindex on: ${misses.slice(0, 5).join(", ")}`
		}
		checks.push({
			name: "noindex",
			ok: detail === undefined,
			...(detail === undefined ? {} : { detail }),
		})
	}

	// Check 7 — anti-cloaking, gating and absolute: hidden text may exist only
	// inside the mandated block.
	{
		let detail: string | undefined
		if (indexElements === null) {
			detail = "not checked: / was not read as HTML"
		} else {
			const violations = findHiddenTextViolations(indexElements, mandatedDiv)
			if (violations.length > 0) {
				detail = `hidden text outside the mandated block: ${violations.slice(0, 3).join(" ")}`
			}
		}
		checks.push({
			name: "anti-cloaking",
			ok: detail === undefined,
			...(detail === undefined ? {} : { detail }),
		})
	}

	return {
		manifest,
		report: { checks, ok: checks.every((check) => check.ok) },
	}
}
