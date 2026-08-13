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

program
	.command("dev")
	.description(
		"Assemble a folder as a trove and serve it locally with the same asset layer the host runs, then check it against the standard over HTTP and print all seven verdicts. Nothing is deployed, no Cloudflare account is used, and no 60-minute claim clock starts — this is how you look at the page and prove it conforms BEFORE publishing. Serves a snapshot of the folder: re-run to pick up edits.",
	)
	.argument("<folder>", "the folder to serve; must contain an AGENTS.md")
	.option("-p, --port <port>", "port to serve on", "8788")
	.action(async (folder: string, options: { port: string }) => {
		if (!existsSync(folder) || !statSync(folder).isDirectory()) {
			throw new Error(`${folder} is not a directory.`)
		}
		const port = portSchema.safeParse(options.port)
		if (!port.success) {
			throw new Error(
				`--port must be a whole number between 1024 and 65535, not "${options.port}".`,
			)
		}
		await dev({ folder, port: port.data })
	})

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
		const { destDir, fileCount } = await remixTrove({
			...(dest === undefined ? {} : { destDir: dest }),
			troveUrl,
		})
		console.log(`${fileCount} files verified and copied to ${destDir}`)
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
