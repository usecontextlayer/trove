#!/usr/bin/env node
import { existsSync, statSync } from "node:fs"
import { Command } from "commander"
import { z } from "zod"
import { version } from "@/package.json"
import { dev } from "@/src/dev"
import { env } from "@/src/env"
import { publish } from "@/src/publish"
import { parseHostUrl, register } from "@/src/register"
import { parseTroveUrl, remixTrove } from "@/src/remix"
import { describeNonConformance } from "@/src/report"
import { screenshot } from "@/src/screenshot"
import { verify } from "@/src/verify"

const program = new Command()
	.name("trove")
	.description(
		"Publish and remix troves — folders of static files served at a URL any agent can fetch, verify, and remix. A trove is served from your own Cloudflare account and has exactly one URL: its own. Publishing is two steps that run separately: `publish` puts the bytes online and they are readable immediately, then `register` claims the trove's id and publishes an independent verdict about it. Neither command runs the other, and reading a trove never involves Trove at all.",
	)
	// Imported from the manifest, never retyped — one place a version number
	// exists. Lowercase -v as well as --version, since commander defaults to -V
	// and the lowercase one is what gets guessed.
	.version(version, "-v, --version", "print the version of this CLI")

// Ports are semantic input, so they are coerced by a schema rather than by
// hand — and reported in one sentence, because a raw validation dump is the
// kind of CLI output an agent gives up on.
const portSchema = z.coerce.number().int().min(1024).max(65535)

/** `390x844` — the one shape worth accepting, so a typo is caught here rather than by a browser. */
const viewportSchema = z
	.string()
	.regex(/^\d{2,5}x\d{2,5}$/)
	.transform((value) => {
		const [width, height] = value.split("x").map(Number)
		return { height: height ?? 0, width: width ?? 0 }
	})
	.refine((size) => size.width >= 10 && size.height >= 10)

const themeSchema = z.enum(["light", "dark", "both"])

/** Every folder-taking command asks the same question, so it gives the same answer. */
function requireDirectory(folder: string): void {
	if (!existsSync(folder) || !statSync(folder).isDirectory()) {
		throw new Error(`${folder} is not a directory.`)
	}
}

// Registered FIRST so it is the first command in `--help`. Three separate
// reading agents, handed a trove URL, hand-rolled verification rather than
// finding a tool for it — and the population that needs this command is exactly
// the one that arrives knowing nothing and scans the top of the help output.
program
	.command("verify")
	.description(
		"Check a trove against the standard and print all seven verdicts. Takes either a live trove's URL or a local folder — one question, asked of the same thing at two moments in its life. Read-only either way: it never deploys, registers, or writes into your folder, and the folder form starts no 60-minute clock. Run it on a trove someone sent you BEFORE you trust or build on it: it hashes every file against the manifest AND runs the six checks you cannot hand-roll, including anti-cloaking, which finds text addressed to your agent that a human reading the page cannot see. Prefer it over fetching and hashing by hand — verification written by hand is easy to write in a way that passes without having verified anything. A folder is assembled and served exactly as `publish` would, so the answer is about what WOULD ship. Exits non-zero if the trove does not conform, so it works as a gate in a script.",
	)
	.argument(
		"<folder-or-url>",
		"a live trove's URL, or a folder you have not published yet",
	)
	.action(async (target: string) => {
		await verify({ registryUrl: env.TROVE_REGISTRY_URL, target })
	})

// `dev` is where the LOCAL, not-yet-published folder is worked on, and it has
// two genuinely different actions — keep serving it, or photograph it — so it
// takes subcommands. `verify` has one action over two input types, so it takes
// an argument instead. Subcommands for different actions; an argument for
// different inputs to the same action.
const devCommand = program
	.command("dev")
	.description(
		"Work on a folder that is not published yet. `trove dev <folder>` serves it; `trove dev screenshot <folder>` photographs it. Nothing here deploys, touches a Cloudflare account, or starts a 60-minute claim clock.",
	)

devCommand
	.command("serve <folder>", { isDefault: true })
	.description(
		"Assemble a folder as a trove and serve it locally with the same asset layer the host runs, then check it against the standard over HTTP and print all seven verdicts. Keeps serving until Ctrl-C, so you can open the page. Serves a snapshot of the folder: re-run to pick up edits. To check a folder and exit instead, use `trove verify <folder>`.",
	)
	.option("-p, --port <port>", "port to serve on", "8788")
	.action(async (folder: string, options: { port: string }) => {
		requireDirectory(folder)
		const port = portSchema.safeParse(options.port)
		if (!port.success) {
			throw new Error(
				`--port must be a whole number between 1024 and 65535, not "${options.port}".`,
			)
		}
		await dev({ folder, port: port.data })
	})

devCommand
	.command("screenshot <folder>")
	.description(
		"Serve the folder as a trove, photograph the page, and print where the images are. Also measures whether the body scrolls sideways at the viewport it shot — a screenshot alone cannot tell you that, and a narrow headless WINDOW is not a mobile LAYOUT VIEWPORT, which is how one page acquired a defensive CSS rule for a bug it never had. Exits non-zero when the page overflows. Needs Playwright installed in the directory you run this from; every other command does not.",
	)
	.option("--viewport <WxH>", "viewport to render at", "1280x800")
	.option("--theme <theme>", "light, dark, or both", "light")
	.option("--no-full-page", "capture only the viewport instead of the whole page")
	.option("--out <dir>", "where to write the images (default: a fresh temp directory)")
	.action(
		async (
			folder: string,
			options: { fullPage: boolean; out?: string; theme: string; viewport: string },
		) => {
			requireDirectory(folder)
			const viewport = viewportSchema.safeParse(options.viewport)
			if (!viewport.success) {
				throw new Error(
					`--viewport must be WIDTHxHEIGHT, like 390x844, not "${options.viewport}".`,
				)
			}
			const theme = themeSchema.safeParse(options.theme)
			if (!theme.success) {
				throw new Error(`--theme must be light, dark, or both, not "${options.theme}".`)
			}
			await screenshot({
				folder,
				fullPage: options.fullPage,
				...(options.out === undefined ? {} : { outDir: options.out }),
				theme: theme.data,
				viewport: viewport.data,
			})
		},
	)

program
	.command("publish")
	.description(
		"Put a folder online as a trove: assemble it (mandated block, trove.json, headers), check it against the standard, deploy it to Cloudflare, and verify the bytes that came back. Prints the trove's URL, which is readable by anyone from that moment — share that URL. Does NOT register it: run `trove register <trove-url>` next, which claims the id and publishes a verdict readers can check. ANY wrangler credential deploys into that account permanently — a `wrangler login` session counts, not just CLOUDFLARE_API_TOKEN. With no credential at all this is an anonymous 60-minute preview that is deleted unless you open the claim URL. Publish prints which of the two it did before deploying.",
	)
	.argument("<folder>", "the folder to publish; must contain an AGENTS.md")
	.action(async (folder: string) => {
		if (!existsSync(folder) || !statSync(folder).isDirectory()) {
			throw new Error(`${folder} is not a directory.`)
		}
		await publish({ folder })
	})

program
	.command("register")
	.description(
		"Register a trove that is already online. Reads the trove's id from the trove.json it serves — which is also what proves you control the trove you are registering — then binds that id to that URL and publishes the contract-check verdict at /a/<id>.json. This does not affect whether the trove can be read; it closes three things a trove cannot establish about itself: that nobody else can claim its id, that its conformance was observed by someone other than its author, and that a remix naming it as parent can be corroborated. An id binds to one URL forever, so re-running this against the same one is how a redeployed trove is re-checked, while a different one is refused. A trove that fails its checks is still registered: the failing report is stored and published, and this command prints it and exits non-zero.",
	)
	.argument("<trove-url>", "the trove's URL — the `trove:` line publish printed")
	.action(async (hostUrl: string) => {
		// Parsed at the boundary, like remix's — the core takes a normalized
		// origin and never a raw argument.
		await register({
			hostUrl: parseHostUrl(env.TROVE_REGISTRY_URL, hostUrl),
			registryUrl: env.TROVE_REGISTRY_URL,
		})
	})

program
	.command("remix")
	.description(
		"Fetch a trove by its URL, verify every file against its manifest digests, strip the inherited identity, and record lineage for the next publish. It hashes every file and refuses the whole trove on any mismatch, so reach for it rather than hand-rolling that check. It does NOT run the full conformance checks — `trove dev` does that, locally, before you publish.",
	)
	.argument("<trove-url>", "the trove's URL")
	.argument("[dest]", "destination directory (default: ./trove-remix-<id>)")
	.action(async (from: string, dest: string | undefined) => {
		const troveUrl = parseTroveUrl(env.TROVE_REGISTRY_URL, from)
		const { destDir, fileCount, report } = await remixTrove({
			...(dest === undefined ? {} : { destDir: dest }),
			troveUrl,
		})
		console.log(`${fileCount} files verified and copied to ${destDir}`)
		// A non-conformant parent does not stop the remix — forking something
		// broken to fix it is legitimate — but it must not go by quietly, because
		// the failure is the remixer's now and their next publish inherits it.
		// stderr, so it survives a caller that is capturing stdout for the paths.
		if (!report.ok) {
			console.error(describeNonConformance(troveUrl, report))
		}
		// The scoped npx form, never a bare `trove` — an agent that got here via
		// `npx @usecontextlayer/trove remix …` has no `trove` on PATH, and the
		// obvious improvisation after "command not found" is the unscoped `trove`
		// package on npm, which belongs to someone else and would be executed.
		console.log(`edit, then: npx @usecontextlayer/trove publish ${destDir}`)
	})

try {
	await program.parseAsync()
} catch (error) {
	// A CLI's error message IS its output. Letting the rejection reach node
	// wraps every failure in a frame of bundled source and a stack trace
	// through the bundle's line numbers, burying the part a reader can act on
	// — for `register` that buried part is the registry's own per-check
	// report, which is the whole reason the command has anything to say.
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
}
