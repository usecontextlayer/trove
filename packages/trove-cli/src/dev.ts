import { checkTrove, httpReader } from "@usecontextlayer/trove-standard"
import { describeChecks } from "@/src/report"
import { withServedTrove } from "@/src/served-trove"

// `trove dev` — serve a folder as a real trove and keep serving it, so a human
// or an agent can open the page and look at it. Nothing is deployed, no account
// is touched, and no 60-minute clock starts.
//
// The CHECKING half of what this used to do now also lives in
// `trove verify <folder>`, which runs the same seven checks against the same
// locally-served trove and exits. This command is the one you want when the
// question is "let me look at it"; verify is the one you want when the question
// is "does it conform". Both are printed here because a creator standing the
// page up wants the verdicts in the same breath.
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
		console.log(
			report.ok
				? "all checks pass — this folder is ready to publish"
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
