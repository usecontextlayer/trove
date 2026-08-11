import { mkdtempSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { checkTrove, httpReader, mintId } from "@usecontextlayer/trove-standard"
import { assembleTrove } from "@/src/assemble"
import { readRemixMarker } from "@/src/remix"
import { describeChecks } from "@/src/report"
import { serveAssembled, waitUntilServing, writeWranglerConfig } from "@/src/wrangler"

// `trove dev` — assemble the folder exactly as publish would, serve it with the
// host's own asset layer, and run the §6.1 checks over real HTTP against it.
// Nothing is deployed, no account is touched, and no 60-minute clock starts.
//
// It exists because the two things a creator needs BEFORE starting that clock
// were both unavailable: seeing the page, and knowing whether it conforms.
// Anti-cloaking is the sharp case — the standard calls it gating and absolute,
// it is the check most likely to fail a designed page, and until now the only
// way to run it was to publish.
//
// It also makes the creator position of the checker mean something. At publish
// time the checker reads through a local adapter that hardcodes noindex and
// derives media types from the same lookup that produced the manifest, so most
// of its checks are true by construction. Here the real asset layer answers.
//
// Real asset layer, but NOT production's defaults — see `serveAssembled`.
// `wrangler dev` attaches `; charset=utf-8` to text types on its own and the
// deployed host does not, so a header observed here is evidence about this
// server, not about the trove once it is published. Reading the two as the same
// thing is what shipped a mojibaked /AGENTS.md. No check reads the charset, so
// the verdicts below are unaffected.

export async function dev(options: { folder: string; port: number }): Promise<void> {
	const { folder, port } = options

	// A throwaway id. Both the mandated block and the manifest carry one and the
	// checker compares them, so dev needs an id even though nothing will ever be
	// registered under it.
	const id = mintId()
	const marker = readRemixMarker(folder)

	const deployDir = mkdtempSync(path.join(os.tmpdir(), "trove-dev-"))
	const troveDir = path.join(deployDir, "trove")
	assembleTrove({
		destDir: troveDir,
		id,
		...(marker === null
			? {}
			: { parent: marker.parent, parentDigest: marker.parentDigest }),
		sourceDir: folder,
	})

	// Publish's own writer, deliberately: dev checking a differently-served trove
	// than the one that deploys is the one failure this command must never have.
	writeWranglerConfig({ deployDir, id })

	const server = serveAssembled({ deployDir, port })
	try {
		await waitUntilServing(server.url)
		const { report } = await checkTrove({
			expectedId: id,
			read: httpReader(server.url),
		})
		console.log(`\nserving ${folder} at ${server.url}`)
		console.log(describeChecks(report))
		console.log(
			report.ok
				? "all checks pass — this folder is ready to publish"
				: "this folder does NOT conform; publishing it would fail the same way",
		)
		// Said plainly because the alternative is a creator editing their source
		// and watching nothing change: what is being served is the assembled
		// COPY, so the source folder is no longer connected to it.
		console.log("serving a snapshot — re-run to pick up edits. Ctrl-C to stop.\n")
	} catch (error) {
		server.stop()
		throw error
	}
	await server.finished
}
