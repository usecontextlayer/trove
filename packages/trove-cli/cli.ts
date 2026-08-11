#!/usr/bin/env node
import { existsSync, statSync } from "node:fs"
import { Command } from "commander"
import { env } from "@/src/env"
import { publish } from "@/src/publish"
import { parseCanonicalUrl, remixTrove } from "@/src/remix"

const program = new Command()
	.name("trove")
	.description(
		"Publish and remix troves — folders of static files served at a URL any agent can fetch, verify, and remix.",
	)

program
	.command("publish")
	.description(
		"Publish a folder as a trove: assemble (mandated block, trove.json, headers), deploy to Cloudflare, verify it serves, register, and print the canonical URL. Anonymous deploys are 60-minute previews until claimed; set CLOUDFLARE_API_TOKEN to publish into your own account.",
	)
	.argument("<folder>", "the folder to publish; must contain an AGENTS.md")
	.action(async (folder: string) => {
		if (!existsSync(folder) || !statSync(folder).isDirectory()) {
			throw new Error(`${folder} is not a directory.`)
		}
		await publish({ folder, registryUrl: env.TROVE_REGISTRY_URL })
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
		console.log(`edit, then: trove publish ${destDir}`)
	})

await program.parseAsync()
