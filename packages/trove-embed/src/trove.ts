// trove.js - the one script every trove loads (section 4 of the standard). It
// is a supply-chain dependency of every trove ever published, so the surface is
// deliberately tiny: find the mandated div, render a permanent bar above the
// page, and resolve the trove's id against the registry to render its status.
//
// THIS FILE IS ASCII-ONLY, comments included, and a test enforces it. A trove
// may serve its page in any encoding, and a classic script with no charset of
// its own is decoded using the EMBEDDING PAGE's encoding - so one em dash in
// here renders as mojibake in the bar of every non-UTF-8 trove. ASCII decodes
// identically under every encoding a trove can plausibly use, which makes the
// script immune rather than merely configured-correctly. (The registry does
// also serve it as `; charset=utf-8`; this is the belt, that is the braces.)
// Hence `-` and `...` below where the rest of the repo writes an em dash and an
// ellipsis, and "section N" where it writes a section sign.
//
// The bar DISPLACES the page rather than covering it - nothing the creator
// wrote is hidden - while the details panel OCCLUDES, because a panel is a
// deliberate act by the reader and lasts only as long as they want it.
//
// Trust is resolved by LOOKUP, never asserted by the page: any page can write
// "trove verified" into a div, so the status comes only from the registry's
// answer, cross-origin via /a/<id>.json (served with ACAO *).
//
// The registry origin is derived from this script's own src - the mandated
// script tag is the single place the domain appears, so the embed inherits a
// host move automatically and bundles zero imports. All UI lives in a shadow
// root so trove CSS and trove.js styles cannot reach each other.
//
// Everything derived from the manifest reaches the DOM through textContent,
// never innerHTML: a trove path is grammatically allowed to contain `<`, and a
// remixer reads manifests written by strangers.

const ID_PATTERN = /^[0-9a-hj-km-np-tv-z]{24}$/
const BAR_HEIGHT = 34

interface RegistryRecord {
	canonical?: string
	contractCheck?: { ok?: boolean }
}

interface ManifestFile {
	path?: string
	size?: number
	digest?: string
}

interface Manifest {
	standard?: number
	parent?: string
	files?: ManifestFile[]
}

type Tone = "ok" | "warn" | "off"

interface TreeNode {
	name: string
	page: boolean
	file: ManifestFile | null
	children: Map<string, TreeNode>
}

function init(): void {
	const script = document.currentScript
	if (!(script instanceof HTMLScriptElement) || script.src === "") {
		return
	}
	const registryOrigin = new URL(script.src).origin

	const start = (): void => {
		const div = document.querySelector("div[data-trove]")
		if (!div) {
			return
		}
		const id = div.getAttribute("data-trove") ?? ""
		const instructions = (div.textContent ?? "").trim()
		// Platform detection is by LOCATION, never by the div's claim - a page
		// can fake data-trove="https://trove.usecontextlayer.com", but it cannot
		// fake being served from the registry origin. On Trove's own pages the
		// bar renders with no registry row to resolve and no status to earn.
		if (window.location.origin === registryOrigin) {
			render(registryOrigin, null, instructions)
			return
		}
		if (!ID_PATTERN.test(id)) {
			return
		}
		render(registryOrigin, id, instructions)
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start)
	} else {
		start()
	}
}

function formatBytes(size: number): string {
	return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} kB`
}

/**
 * Groups the manifest's flat paths into a tree. The index page is listed as
 * "/" rather than "/index.html" (section 3's membership rule - "/" is the path the
 * host serves directly), and is rendered under that name so the tray never
 * teaches a path the manifest does not contain.
 */
function buildTree(files: ManifestFile[]): TreeNode {
	const root: TreeNode = { children: new Map(), file: null, name: "", page: false }
	for (const file of files) {
		const path = file.path ?? ""
		if (path === "/") {
			root.children.set("/", { children: new Map(), file, name: "/", page: true })
			continue
		}
		const segments = path.replace(/^\//, "").split("/")
		let node = root
		segments.forEach((segment, index) => {
			let child = node.children.get(segment)
			if (!child) {
				child = { children: new Map(), file: null, name: segment, page: false }
				node.children.set(segment, child)
			}
			node = child
			if (index === segments.length - 1) {
				node.file = file
			}
		})
	}
	return root
}

function sortedChildren(node: TreeNode): TreeNode[] {
	return [...node.children.values()].sort((a, b) => {
		if (a.page !== b.page) return a.page ? -1 : 1
		const aDir = a.children.size > 0
		const bDir = b.children.size > 0
		if (aDir !== bDir) return aDir ? -1 : 1
		return a.name.localeCompare(b.name)
	})
}

/**
 * Resolves a manifest path to a link, or to null when it would leave this
 * origin. Section 3 requires every consumer resolving a `path` to verify the
 * resolved origin - a leading-slash test is not that test, because `//host/x` is a
 * protocol-relative authority that discards the base. The manifest is authored
 * by whoever published the trove and is never validated here, so an unresolvable
 * or off-origin path renders as plain text rather than as a link.
 */
function sameOriginHref(path: string | undefined): string | null {
	if (typeof path !== "string" || !path.startsWith("/")) {
		return null
	}
	try {
		const url = new URL(path, window.location.origin)
		return url.origin === window.location.origin ? url.href : null
	} catch {
		return null
	}
}

function renderTree(node: TreeNode, into: HTMLElement): void {
	for (const child of sortedChildren(node)) {
		const isDir = child.children.size > 0
		const href = isDir ? null : sameOriginHref(child.file?.path)
		const row = document.createElement(href === null ? "div" : "a")
		if (row instanceof HTMLAnchorElement && href !== null) {
			row.href = href
			// A new tab, because the reader is inspecting this trove rather than
			// leaving it - and noopener because the file is the creator's, not ours.
			row.target = "_blank"
			row.rel = "noopener noreferrer"
		}
		row.className = `row${isDir ? " dir" : ""}${child.page ? " page" : ""}${
			href === null ? "" : " link"
		}`

		const name = document.createElement("span")
		name.className = "name"
		name.textContent = `${child.name}${isDir ? "/" : ""}`

		const size = document.createElement("span")
		size.className = "size"
		size.textContent =
			typeof child.file?.size === "number" ? formatBytes(child.file.size) : ""

		const digest = document.createElement("span")
		digest.className = "digest"
		digest.textContent = (child.file?.digest ?? "").slice(7, 15)

		row.append(name, size, digest)
		into.append(row)

		if (isDir) {
			const kids = document.createElement("div")
			kids.className = "kids"
			into.append(kids)
			renderTree(child, kids)
		}
	}
}

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
:host {
	--bg: #f7f7f6;
	--bg-lift: #fdfdfc;
	--ink: #16181a;
	--muted: #727974;
	--line: #e3e4e2;
	--line-soft: #eeefed;
	--brass: #8a6a21;
	--ok: #2f6b4f;
	--warn: #a2591c;
	--off: #9aa09b;
	--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
	--ui: system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
	:host {
		--bg: #101211;
		--bg-lift: #171a18;
		--ink: #e9ebe9;
		--muted: #8d938e;
		--line: #262a27;
		--line-soft: #1e2120;
		--brass: #d4a94e;
		--ok: #6bbb8e;
		--warn: #e0925a;
		--off: #6f7671;
	}
}
.bar {
	position: fixed; inset: 0 0 auto 0; height: ${BAR_HEIGHT}px;
	z-index: 2147483646;
	display: flex; align-items: center; gap: 10px;
	padding: 0 10px 0 12px;
	background: var(--bg); border-bottom: 1px solid var(--line);
	font: 11.5px/1 var(--mono); letter-spacing: 0.02em; color: var(--ink);
	font-variant-numeric: tabular-nums; user-select: none;
}
.mark { display: flex; align-items: center; gap: 7px; }
.dot { width: 7px; height: 7px; background: var(--off); }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.wordmark { font-weight: 600; letter-spacing: 0.16em; }
.rule { width: 1px; height: 13px; background: var(--line); }
.state { color: var(--muted); white-space: nowrap; }
.state.ok { color: var(--ok); }
.state.warn { color: var(--warn); }
.spacer { flex: 1; }
.id { color: var(--muted); white-space: nowrap; }
.id b { font-weight: 400; color: var(--ink); }
.toggle {
	display: flex; align-items: center; gap: 6px;
	height: 22px; padding: 0 8px;
	border: 1px solid transparent; border-radius: 3px;
	background: none; color: var(--muted);
	font: inherit; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer;
}
.toggle:hover { background: var(--bg-lift); border-color: var(--line); color: var(--ink); }
.toggle:focus-visible { outline: 2px solid var(--brass); outline-offset: 1px; }
.chev { transition: transform 140ms ease; }
.bar.open .chev { transform: rotate(180deg); }
.sheet {
	position: fixed; inset: ${BAR_HEIGHT}px 0 auto 0;
	z-index: 2147483647; display: none;
	max-height: calc(100vh - ${BAR_HEIGHT}px); overflow-y: auto;
	background: var(--bg); border-bottom: 1px solid var(--line);
	box-shadow: 0 18px 40px -24px rgb(0 0 0 / 0.45); color: var(--ink);
}
.sheet.open { display: block; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); }
.pane { padding: 22px 24px 26px; min-width: 0; }
.pane + .pane { border-left: 1px solid var(--line-soft); }
.label {
	font: 500 10px/1 var(--ui); letter-spacing: 0.09em; text-transform: uppercase;
	color: var(--muted); margin-bottom: 12px;
}
.pane > * + .label { margin-top: 26px; }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 16px; }
dt { font: 11.5px/1.4 var(--mono); color: var(--muted); }
dd { font: 11.5px/1.4 var(--mono); word-break: break-all; }
dd a { color: var(--brass); text-underline-offset: 2px; }
.pending { color: var(--muted); }
.pending small { display: block; font-size: 11.5px; color: var(--off); }
.instructions {
	padding: 12px 13px; background: var(--bg-lift);
	border: 1px solid var(--line-soft); border-radius: 3px;
	font: 11.5px/1.6 var(--mono); color: var(--muted);
	white-space: pre-wrap; word-break: break-word;
}
.note { margin-top: 10px; font: 12px/1.5 var(--ui); color: var(--muted); }
.tree { font: 11.5px/1 var(--mono); }
.kids { margin-left: 4px; padding-left: 9px; border-left: 1px solid var(--line-soft); }
.row {
	display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
	align-items: center; gap: 14px; height: 23px; padding: 0 8px; border-radius: 3px;
}
.row:hover { background: var(--bg-lift); }
.row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.dir .name { color: var(--muted); }
a.row { text-decoration: none; color: inherit; cursor: pointer; }
a.row:hover .name { color: var(--brass); text-decoration: underline; text-underline-offset: 2px; }
a.row:focus-visible { outline: 2px solid var(--brass); outline-offset: -1px; }
.row.page .name::after {
	content: "page"; margin-left: 9px;
	font: 500 9.5px/1 var(--ui); letter-spacing: 0.07em; text-transform: uppercase;
	color: var(--off);
}
.size { color: var(--muted); font-variant-numeric: tabular-nums; }
.digest { color: var(--off); }
.total {
	display: flex; justify-content: space-between;
	margin-top: 12px; padding: 9px 8px 0; border-top: 1px solid var(--line-soft);
	font: 11.5px/1 var(--mono); color: var(--muted);
}
@media (max-width: 720px) {
	.id { display: none; }
	.grid { grid-template-columns: minmax(0, 1fr); }
	.pane + .pane { border-left: none; border-top: 1px solid var(--line-soft); }
	.digest { display: none; }
}
@media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
`

const MARKUP = `
<div class="bar">
	<div class="mark"><i class="dot"></i><span class="wordmark">TROVE</span></div>
	<i class="rule"></i>
	<span class="state">Checking...</span>
	<span class="spacer"></span>
	<span class="id"></span>
	<button class="toggle" aria-expanded="false">Details<svg class="chev" width="9" height="9"
		viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 3.5 5 7l3.5-3.5"
		stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/></svg></button>
</div>
<section class="sheet" role="region" aria-label="Trove details">
	<div class="grid">
		<div class="pane">
			<p class="label">Identity</p>
			<dl>
				<dt>canonical</dt><dd class="canonical"></dd>
				<dt>id</dt><dd class="full-id"></dd>
				<dt>standard</dt><dd class="standard"></dd>
				<dt>lineage</dt><dd class="lineage"></dd>
			</dl>
			<p class="label">What agents are told</p>
			<pre class="instructions"></pre>
			<p class="note">This text is in the page but hidden from you. Any agent that
			fetches this URL reads it verbatim.</p>
		</div>
		<div class="pane">
			<p class="label contents-label">Contents</p>
			<div class="tree"></div>
		</div>
	</div>
</section>`

/** `id` is null on the platform's own page (the special id - its URL). */
function render(registryOrigin: string, id: string | null, instructions: string): void {
	const host = document.createElement("div")
	const root = host.attachShadow({ mode: "closed" })
	const style = document.createElement("style")
	style.textContent = STYLES
	root.append(style)
	const frame = document.createElement("div")
	frame.innerHTML = MARKUP
	root.append(frame)

	const query = <T extends HTMLElement>(selector: string): T =>
		root.querySelector(selector) as T

	const bar = query(".bar")
	const sheet = query(".sheet")
	const toggle = query<HTMLButtonElement>(".toggle")

	query(".instructions").textContent = instructions
	query(".full-id").textContent = id ?? registryOrigin

	if (id !== null) {
		const idEl = query(".id")
		const head = document.createElement("b")
		// The leading 8 characters are the deploy hostname's slug; showing which
		// part travels is what stops a reader inventing the rest of an id.
		head.textContent = id.slice(0, 8)
		idEl.append(head, document.createTextNode(id.slice(8)))
	}

	const setOpen = (open: boolean): void => {
		sheet.classList.toggle("open", open)
		bar.classList.toggle("open", open)
		toggle.setAttribute("aria-expanded", String(open))
	}
	toggle.addEventListener("click", () => setOpen(!sheet.classList.contains("open")))
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") setOpen(false)
	})

	document.body.append(host)

	// DISPLACE, never cover: the page moves down by the bar's height. Creators
	// are told (in the writing-troves skill) to keep nothing pinned to the top,
	// because a `position: sticky` element resolves against the viewport and
	// would slide underneath the bar - which no CSS from out here can prevent.
	document.documentElement.style.marginTop = `${BAR_HEIGHT}px`
	document.documentElement.style.scrollPaddingTop = `${BAR_HEIGHT}px`

	applyManifest(root)
	resolveRegistration(
		query(".dot"),
		query(".state"),
		query(".canonical"),
		id,
		registryOrigin,
	)
}

/**
 * One registry read answers two questions - the bar's status and whether the
 * canonical URL resolves yet - so it is fetched once and both are painted from
 * the same answer. Rendering the canonical as a link before registration is
 * how a reader ends up citing a URL that 404s.
 */
function resolveRegistration(
	dot: HTMLElement,
	state: HTMLElement,
	canonicalEl: HTMLElement,
	id: string | null,
	registryOrigin: string,
): void {
	const paint = (tone: Tone, label: string): void => {
		dot.className = `dot ${tone}`
		state.className = `state ${tone}`
		state.textContent = label
	}
	const asLink = (href: string): void => {
		const link = document.createElement("a")
		link.href = href
		link.rel = "noopener"
		link.textContent = href
		canonicalEl.replaceChildren(link)
	}

	if (id === null) {
		paint("off", "This is Trove itself")
		asLink(registryOrigin)
		return
	}

	const canonical = `${registryOrigin}/a/${id}`

	void fetch(`${registryOrigin}/a/${id}.json`)
		.then(async (response) => {
			if (response.status === 404) {
				paint("off", "Not registered")
				const pending = document.createElement("span")
				pending.className = "pending"
				pending.textContent = canonical
				const hint = document.createElement("small")
				hint.textContent = "resolves once this trove is registered"
				pending.append(hint)
				canonicalEl.replaceChildren(pending)
				return
			}
			if (!response.ok) {
				throw new Error(`registry answered ${response.status}`)
			}
			const record = (await response.json()) as RegistryRecord
			paint(
				record.contractCheck?.ok === true ? "ok" : "warn",
				record.contractCheck?.ok === true ? "Registered" : "Failed its last check",
			)
			asLink(canonical)
		})
		.catch(() => {
			paint("off", "Registry unreachable")
			// Unknown registration state - plain text, since we cannot claim it
			// resolves and cannot claim it does not.
			canonicalEl.textContent = canonical
		})
}

/** The manifest is same-origin with the page, so this needs no CORS. */
function applyManifest(root: ShadowRoot): void {
	void fetch("/trove.json")
		.then(async (response) => {
			if (!response.ok) {
				throw new Error(`manifest answered ${response.status}`)
			}
			const manifest = (await response.json()) as Manifest
			const files = Array.isArray(manifest.files) ? manifest.files : []
			const total = files.reduce((sum, file) => sum + (file.size ?? 0), 0)

			const standard = root.querySelector(".standard") as HTMLElement
			standard.textContent = String(manifest.standard ?? "-")
			const lineage = root.querySelector(".lineage") as HTMLElement
			lineage.textContent = manifest.parent
				? `remixed from ${manifest.parent}`
				: "original"

			const label = root.querySelector(".contents-label") as HTMLElement
			label.textContent = `Contents: ${files.length} files, every byte hashed`

			const tree = root.querySelector(".tree") as HTMLElement
			renderTree(buildTree(files), tree)

			const totals = document.createElement("div")
			totals.className = "total"
			const count = document.createElement("span")
			count.textContent = `${files.length} files`
			const bytes = document.createElement("span")
			bytes.textContent = formatBytes(total)
			totals.append(count, bytes)
			tree.append(totals)
		})
		.catch(() => {
			const tree = root.querySelector(".tree") as HTMLElement
			tree.textContent = "could not read this trove's manifest"
		})
}

init()
