import { mkdtempSync } from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { freePort, withServedTrove } from "@/src/served-trove"

// `trove dev screenshot` — stand the folder up as a real trove, photograph the
// page, and print where the images are.
//
// It exists because the product asks for something it gave nobody a way to do.
// `writing-troves` spends its longest section on the page — tokens, both
// themes, typography, and "wide content gets its own overflow-x container so the
// body never scrolls sideways" — and until now a creator's only route to seeing
// the result was to publish it and open a browser.
//
// The measurement matters as much as the image, and this is the one place the
// distinction has already cost real work. One agent INVENTED a mobile-layout bug
// from a narrow headless window and shipped a defensive CSS rule for it;
// another hit the real thing and caught it only by comparing scrollWidth to
// clientWidth at a true 390px viewport. Headless Chrome at a narrow WINDOW is
// not a mobile LAYOUT VIEWPORT, so a screenshot alone reproduces the first
// agent's trap. Both numbers are printed with every capture.
//
// Conformance deliberately says nothing about any of this. A trove that scrolls
// sideways on a phone passes all seven checks, correctly — the standard is an
// HTTP contract, not design review, and this command is where that gap is
// closed without putting layout opinions inside the thing that certifies
// strangers' troves.

/**
 * The slice of Playwright this uses, declared structurally.
 *
 * Playwright is NOT a build-time dependency — this module must compile and ship
 * whether or not it is installed anywhere — so the shape is written out rather
 * than imported. It is also the seam a fake would type against.
 */
interface PageLike {
	/** Playwright accepts an expression STRING as well as a function — see MEASURE_WIDTHS. */
	evaluate<T>(expression: string): Promise<T>
	goto(url: string, options?: { waitUntil?: "load" | "networkidle" }): Promise<unknown>
	screenshot(options: { fullPage?: boolean; path: string }): Promise<unknown>
}
interface ContextLike {
	close(): Promise<void>
	newPage(): Promise<PageLike>
}
interface BrowserLike {
	close(): Promise<void>
	newContext(options: {
		colorScheme?: "dark" | "light"
		viewport?: { height: number; width: number }
	}): Promise<ContextLike>
}
interface PlaywrightLike {
	chromium: { launch(options?: { headless?: boolean }): Promise<BrowserLike> }
}

const INSTALL_HINT =
	"npm install --save-dev playwright && npx playwright install chromium"

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

/**
 * Resolve Playwright from the CALLER'S working directory, not from this module.
 *
 * The distinction is the whole reason this function exists. Node resolves an
 * import relative to the importing file, which under `npx @usecontextlayer/trove`
 * is a temporary directory that will never contain Playwright — so a perfectly
 * good project-local install would be invisible. Resolving from cwd is what
 * makes "install it in your project" true advice.
 *
 * Keeping it out of `dependencies` is deliberate: the CLI has exactly one
 * runtime dependency, ships as a 540 KB tarball, and is held to "never require
 * an account, setup, or config". A browser download is a real setup step, and
 * only this one command needs it.
 */
async function loadPlaywright(): Promise<PlaywrightLike> {
	const requireFromCwd = createRequire(pathToFileURL(path.join(process.cwd(), "-")))
	const attempts: string[] = []
	for (const name of ["playwright", "playwright-core"]) {
		try {
			const resolved = requireFromCwd.resolve(name)
			return (await import(pathToFileURL(resolved).href)) as PlaywrightLike
		} catch (error) {
			attempts.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	throw new Error(
		`this command needs Playwright, and neither "playwright" nor "playwright-core" resolves from ${process.cwd()}.\n  ${INSTALL_HINT}\nEvery other trove command works without it.\n\n${attempts.join("\n")}`,
	)
}

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
	const playwright = await loadPlaywright()
	const outDir =
		options.outDir ?? mkdtempSync(path.join(os.tmpdir(), "trove-screenshot-"))
	const themes: ("dark" | "light")[] = theme === "both" ? ["light", "dark"] : [theme]

	const shots = await withServedTrove(
		{ folder, port: await freePort() },
		async (served) => {
			const browser = await playwright.chromium.launch({ headless: true })
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
 * what it was looking at, and the whole reason this command reports a number is
 * that one agent read a screenshot and diagnosed a bug the page did not have.
 * The arithmetic is worth pinning; the browser is not worth mocking.
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
