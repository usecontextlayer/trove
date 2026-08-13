import { mkdtempSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { type Browser, chromium, type LaunchOptions } from "playwright-core"
import { freePort, withServedTrove } from "@/src/served-trove"

// `trove dev screenshot` — stand the folder up as a real trove, photograph the
// page, and print where the images are.
//
// It exists because the product asks for something it gave nobody a way to do:
// `writing-troves` asks a creator for design tokens, both themes, typography,
// and "wide content gets its own overflow-x container so the body never scrolls
// sideways" — and none of that is checkable without seeing the page.
//
// The measurement matters as much as the image. Headless Chrome at a narrow
// WINDOW is not a mobile LAYOUT VIEWPORT, so an image alone can show an
// overflow the page does not have, and can hide a real one by having been
// clipped to the window. Both numbers are printed with every capture, so the
// verdict never rests on reading a picture.
//
// Conformance deliberately says nothing about any of this. A trove that scrolls
// sideways on a phone passes all seven checks, correctly — the standard is an
// HTTP contract, not design review, and this command is where that gap is
// closed without putting layout opinions inside the thing that certifies
// strangers' troves.

/**
 * Where a browser comes from, in the order worth trying.
 *
 * `playwright-core` deliberately ships no browser binaries, so the question is
 * never "is Playwright installed" — it is "is there a Chromium on this machine
 * we may drive". Almost always there is: the ladder ends at the browser the
 * person already uses.
 *
 * Bundled Chromium goes first because it is the one whose version we know. The
 * system channels come next because they cost no download, which is the whole
 * reason this command needs no setup step. Only when a machine has none of them
 * is there anything for the user to do, and then the error says exactly what.
 */
const BROWSER_LADDER = [
	{ launch: {}, what: "the Chromium that `playwright install` downloads" },
	{ launch: { channel: "chrome" }, what: "Google Chrome" },
	{ launch: { channel: "msedge" }, what: "Microsoft Edge" },
	{ launch: { channel: "chromium" }, what: "system Chromium" },
] as const satisfies readonly { launch: LaunchOptions; what: string }[]

/**
 * Open a browser, trying each rung and reporting every failure if none works.
 *
 * Errors are collected rather than swallowed: "no browser" and "Chrome is
 * installed but refused to start" are different problems, and a caller that
 * only ever hears the first will go install something it already has.
 */
async function launchBrowser(): Promise<{ browser: Browser; what: string }> {
	const refusals: string[] = []
	for (const rung of BROWSER_LADDER) {
		try {
			const browser = await chromium.launch({ ...rung.launch, headless: true })
			return { browser, what: rung.what }
		} catch (error) {
			refusals.push(
				`  ${rung.what}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
			)
		}
	}
	throw new Error(
		`no Chromium-based browser could be started, so there is nothing to photograph the page with. Install one — \`npx playwright install chromium\` is the smallest fix, and Google Chrome or Microsoft Edge work too. Every other trove command runs without a browser.\n\nTried:\n${refusals.join("\n")}`,
	)
}

/**
 * The two numbers that decide whether the body scrolls sideways, evaluated in
 * the page.
 *
 * A string rather than a closure on purpose. This package is a Node program and
 * its tsconfig has no `dom` lib — adding one so that four words could type-check
 * would put `document`, `window` and every other browser global into the type
 * space of a CLI that has no browser, where the compiler would stop objecting to
 * code that cannot possibly run. Playwright takes an expression string, so the
 * browser-side code stays visibly browser-side.
 */
const MEASURE_WIDTHS =
	"({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })"

export interface ScreenshotOptions {
	folder: string
	fullPage: boolean
	/** Where the images land. A fresh temp directory when the caller did not choose one. */
	outDir?: string
	theme: "both" | "dark" | "light"
	viewport: { height: number; width: number }
}

export interface Shot {
	/** The page's own width at this viewport. Wider than `clientWidth` means the body scrolls sideways. */
	clientWidth: number
	path: string
	scrollWidth: number
	theme: "dark" | "light"
}

export async function screenshot(options: ScreenshotOptions): Promise<void> {
	const { folder, fullPage, theme, viewport } = options
	const outDir =
		options.outDir ?? mkdtempSync(path.join(os.tmpdir(), "trove-screenshot-"))
	const themes: ("dark" | "light")[] = theme === "both" ? ["light", "dark"] : [theme]

	const shots = await withServedTrove(
		{ folder, port: await freePort() },
		async (served) => {
			const { browser, what } = await launchBrowser()
			console.error(`photographing with ${what}`)
			try {
				const captured: Shot[] = []
				for (const colorScheme of themes) {
					const context = await browser.newContext({ colorScheme, viewport })
					try {
						const page = await context.newPage()
						await page.goto(served.url, { waitUntil: "networkidle" })
						const file = path.join(outDir, `page-${colorScheme}.png`)
						await page.screenshot({ fullPage, path: file })
						// Measured at the SAME viewport the image was taken at, in the
						// same page — an image and a number that disagree would be
						// worse than either alone.
						const width = await page.evaluate<{
							clientWidth: number
							scrollWidth: number
						}>(MEASURE_WIDTHS)
						captured.push({ ...width, path: file, theme: colorScheme })
					} finally {
						await context.close()
					}
				}
				return captured
			} finally {
				await browser.close()
			}
		},
	)

	console.log(`viewport ${viewport.width}x${viewport.height}`)
	for (const shot of shots) {
		console.log(`  ${shot.theme.padEnd(5)} ${shot.path}`)
	}

	const verdict = describeOverflow(shots)
	if (verdict.overflowing) {
		console.error(verdict.summary)
		process.exitCode = 1
		return
	}
	console.log(verdict.summary)
}

/**
 * Turn the measured widths into the verdict, separately from measuring them.
 *
 * Kept apart from the capture because it is the half that can be wrong in a way
 * nobody notices: an image looks the same whether or not the tool understood
 * what it was looking at. The arithmetic is worth pinning; the browser is not
 * worth mocking.
 */
export function describeOverflow(shots: readonly Shot[]): {
	overflowing: boolean
	summary: string
} {
	const overflowing = shots.filter((shot) => shot.scrollWidth > shot.clientWidth)
	if (overflowing.length === 0) {
		const widths = [...new Set(shots.map((shot) => shot.clientWidth))].join(", ")
		return {
			overflowing: false,
			summary: `  no horizontal overflow — scrollWidth equals clientWidth (${widths})`,
		}
	}
	return {
		overflowing: true,
		summary: overflowing
			.map(
				(shot) =>
					`  ${shot.theme}: THE BODY SCROLLS SIDEWAYS — scrollWidth ${shot.scrollWidth} > clientWidth ${shot.clientWidth}. Wide content needs its own overflow-x container, and a grid or flex child needs min-width: 0 before it is allowed to shrink.`,
			)
			.join("\n"),
	}
}
