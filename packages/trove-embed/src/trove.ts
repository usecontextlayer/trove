// trove.js — the one script every trove loads (§4 of the standard). It is a
// supply-chain dependency of every trove ever published, so the surface is
// deliberately tiny: find the mandated div, render an edge tab and a drawer
// showing the human exactly the instructions the agent sees, and resolve the
// trove's id against the registry to render registered/unregistered.
//
// Trust is resolved by LOOKUP, never asserted by the page: any page can write
// "trove verified" into a div, so the status comes only from the registry's
// answer, cross-origin via /a/<id>.json (served with ACAO *).
//
// The registry origin is derived from this script's own src — the mandated
// script tag is the single place the domain appears, so the embed inherits a
// host move automatically and bundles zero imports. All UI lives in a shadow
// root so trove CSS and trove.js styles cannot reach each other.

const ID_PATTERN = /^[0-9a-hj-km-np-tv-z]{24}$/

interface RegistryRecord {
	canonical?: string
	contractCheck?: { ok?: boolean }
}

function init(): void {
	const script = document.currentScript
	if (!(script instanceof HTMLScriptElement) || script.src === "") {
		return
	}
	const registryOrigin = new URL(script.src).origin

	const start = (): void => {
		const div = document.querySelector("div[data-trove]")
		const id = div?.getAttribute("data-trove") ?? ""
		if (!div) {
			return
		}
		const instructions = (div.textContent ?? "").trim()
		// Platform detection is by LOCATION, never by the div's claim — a page
		// can fake data-trove="https://trove.usecontextlayer.com", but it cannot
		// fake being served from the registry origin. On Trove's own pages the
		// drawer renders with no registry row to resolve and no badge to earn.
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

/** `id` is null on the platform's own page (the special id — its URL). */
function render(registryOrigin: string, id: string | null, instructions: string): void {
	const canonical = id === null ? registryOrigin : `${registryOrigin}/a/${id}`

	const host = document.createElement("div")
	const root = host.attachShadow({ mode: "closed" })
	root.innerHTML = `
<style>
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.tab {
	position: fixed; right: 0; top: 50%; transform: translateY(-50%);
	z-index: 2147483646;
	writing-mode: vertical-rl;
	padding: 12px 6px; border: 1px solid #d0d0d0; border-right: none;
	border-radius: 8px 0 0 8px; background: #fff; color: #333;
	font: 600 12px/1 system-ui, sans-serif; letter-spacing: 0.08em;
	cursor: pointer;
}
.tab:hover { background: #f5f5f5; }
.drawer {
	position: fixed; right: 0; top: 0; bottom: 0; width: min(360px, 90vw);
	z-index: 2147483647;
	display: none; flex-direction: column; gap: 12px;
	padding: 20px; border-left: 1px solid #d0d0d0; background: #fff; color: #222;
	font: 14px/1.5 system-ui, sans-serif;
	overflow-y: auto;
}
.drawer.open { display: flex; }
.drawer h2 { font-size: 15px; }
.drawer .status { font-weight: 600; }
.drawer .instructions {
	padding: 10px; border-radius: 6px; background: #f6f6f6;
	font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word;
}
.drawer a { color: #0550ae; word-break: break-all; }
.drawer .close {
	position: absolute; right: 12px; top: 12px;
	border: none; background: none; font-size: 18px; cursor: pointer; color: #666;
}
@media (prefers-color-scheme: dark) {
	.tab { background: #1c1c1c; border-color: #3a3a3a; color: #ddd; }
	.tab:hover { background: #2a2a2a; }
	.drawer { background: #1c1c1c; border-color: #3a3a3a; color: #ddd; }
	.drawer .instructions { background: #2a2a2a; }
	.drawer a { color: #6cb2ff; }
	.drawer .close { color: #999; }
}
</style>
<button class="tab" aria-expanded="false">TROVE</button>
<section class="drawer" role="dialog" aria-label="trove">
	<button class="close" aria-label="Close">×</button>
	<h2>trove</h2>
	<p class="status">Checking registration…</p>
	<p>This page is a trove — a set of files any AI agent can fetch, verify, and remix from its URL.</p>
	<p><a class="canonical" href="${canonical}" rel="noopener">${canonical}</a></p>
	<h2>What agents are told</h2>
	<pre class="instructions"></pre>
</section>`

	const tab = root.querySelector(".tab") as HTMLButtonElement
	const drawer = root.querySelector(".drawer") as HTMLElement
	const status = root.querySelector(".status") as HTMLElement
	const instructionsEl = root.querySelector(".instructions") as HTMLElement
	instructionsEl.textContent = instructions

	const setOpen = (open: boolean): void => {
		drawer.classList.toggle("open", open)
		tab.setAttribute("aria-expanded", String(open))
	}
	tab.addEventListener("click", () => setOpen(!drawer.classList.contains("open")))
	;(root.querySelector(".close") as HTMLButtonElement).addEventListener("click", () =>
		setOpen(false),
	)

	document.body.appendChild(host)

	if (id === null) {
		status.textContent = "This is Trove itself"
		return
	}

	void fetch(`${registryOrigin}/a/${id}.json`)
		.then(async (response) => {
			if (response.status === 404) {
				status.textContent = "Not registered with Trove"
				return
			}
			if (!response.ok) {
				throw new Error(`registry answered ${response.status}`)
			}
			const record = (await response.json()) as RegistryRecord
			status.textContent =
				record.contractCheck?.ok === true
					? "✓ Registered with Trove"
					: "Registered, but failed its last conformance check"
		})
		.catch(() => {
			status.textContent = "Could not reach the Trove registry"
		})
}

init()
