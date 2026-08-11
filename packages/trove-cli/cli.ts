#!/usr/bin/env node
import { existsSync, statSync } from "node:fs"
import { Command } from "commander"
import { z } from "zod"
import { dev } from "@/src/dev"
import { env } from "@/src/env"
import { publish } from "@/src/publish"
import { parseHostUrl, register } from "@/src/register"
import { parseCanonicalUrl, remixTrove } from "@/src/remix"

const program = new Command()
	.name("trove")
	.description(
		"Publish and remix troves — folders of static files served at a URL any agent can fetch, verify, and remix. Publishing a trove is two steps that run separately: `publish` puts the bytes online, then `register` certifies them and gives the trove its canonical URL. Neither command runs the other.",
	)

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
		"Put a folder online as a trove: assemble it (mandated block, trove.json, headers), check it against the standard, deploy it to Cloudflare, and verify the bytes that came back. Prints the host URL. Does NOT register the trove and does NOT print a canonical URL — run `trove register <host-url>` next, which is what mints one. ANY wrangler credential deploys into that account permanently — a `wrangler login` session counts, not just CLOUDFLARE_API_TOKEN. With no credential at all this is an anonymous 60-minute preview that is deleted unless you open the claim URL. Publish prints which of the two it did before deploying.",
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
		"Register a trove that is already online, and print its canonical URL. Reads the trove's id from the trove.json it serves — which is also what proves you are registering the trove that is actually there — then records the id↔host binding the canonical URL redirects through. An id binds to one host forever, so re-running this against the same host is how a redeployed trove is re-checked, while a different host is refused. A trove that fails its contract checks is still registered: the failing report is stored and published, and this command prints it and exits non-zero.",
	)
	.argument(
		"<host-url>",
		"the trove's host URL — the `host:` line publish printed, not the canonical URL",
	)
	.action(async (hostUrl: string) => {
		// Parsed at the boundary, like remix's canonical URL — the core takes a
		// normalized origin.
		await register({
			hostUrl: parseHostUrl(env.TROVE_REGISTRY_URL, hostUrl),
			registryUrl: env.TROVE_REGISTRY_URL,
		})
	})

program
	.command("remix")
	.description(
		"Fetch a trove by its canonical URL, verify every file against its manifest digests, strip the inherited identity, and record lineage for the next publish.",
	)
	.argument("<canonical-url>", "the trove's canonical URL (…/a/<id>), never a host URL")
	.argument("[dest]", "destination directory (default: ./trove-remix-<id>)")
	.action(async (from: string, dest: string | undefined) => {
		const canonicalUrl = parseCanonicalUrl(env.TROVE_REGISTRY_URL, from)
		const destDir = dest ?? `./trove-remix-${canonicalUrl.slice(-24, -16)}`
		const { fileCount } = await remixTrove({ canonicalUrl, destDir })
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
