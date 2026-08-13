import { checkTrove, httpReader } from "@usecontextlayer/trove-standard"
import { describeChecks } from "@/src/report"
import { withServedTrove } from "@/src/served-trove"

// `trove dev` — serve a folder as a real trove and keep serving it, so a human
// or an agent can open the page and look at it. Nothing is deployed, no account
// is touched, and no 60-minute clock starts.
//
// `trove verify <folder>` runs the same seven checks against the same
// locally-served trove and exits. This command is the one you want when the
// question is "let me look at it"; verify is the one you want when the question
// is "does it conform". The verdicts are printed here as well, because a
// creator standing the page up wants them in the same breath.
//
// Real asset layer, but NOT production's defaults — see `serveAssembled`.
// `wrangler dev` attaches `; charset=utf-8` to text types on its own and the
// deployed host does not, so a header observed here is evidence about this
// server, not about the trove once it is published. No check reads the charset,
// so the verdicts below are unaffected.

export async function dev(options: { folder: string; port: number }): Promise<void> {
	const { folder, port } = options

	await withServedTrove({ folder, port }, async (served) => {
		const { report } = await checkTrove({
			expectedId: served.id,
			read: httpReader(served.url),
		})
		console.log(`\nserving ${folder} at ${served.url}`)
		console.log(describeChecks(report))
		// "Ready to publish" was a readiness claim the checks cannot support: a
		// folder holding raw files and a placeholder manual passes all seven.
		// What the checks establish is that the format is right.
		console.log(
			report.ok
				? "all checks pass — the format is right. That is not the same as the page or the manual being worth publishing; look at both."
				: "this folder does NOT conform; publishing it would fail the same way",
		)
		// Said plainly because the alternative is a creator editing their source
		// and watching nothing change: what is being served is the assembled
		// COPY, so the source folder is no longer connected to it.
		console.log("serving a snapshot — re-run to pick up edits. Ctrl-C to stop.\n")

		// Blocking IS this command. Awaiting inside the bracket is what lets the
		// bracket stop the server unconditionally: by the time this resolves, the
		// process has already exited.
		await served.finished
	})
}
