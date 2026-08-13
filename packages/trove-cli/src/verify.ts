import { checkTrove, httpReader } from "@usecontextlayer/trove-standard"
import { describeChecks } from "@/src/report"

// `trove verify <trove-url>` — the §6.1 checker in the READER's position, over
// HTTP, against a trove that is already live. Same checker, same renderer and
// the same seven verdicts as `trove dev`; the only difference is that dev points
// at a folder it served itself and this points at somebody else's URL.
//
// It exists because the standard tells a reader to verify a trove before
// trusting it and, until now, gave them nothing to do it with. What three
// separate reading agents did instead was hand-roll it — fetch each file, hash
// it, and compare by eye — which is the failure the standard names in the same
// breath as the instruction: hand-written verification is easy to write in a way
// that PASSES WITHOUT HAVING VERIFIED ANYTHING. One measured agent's check ran a
// hashing binary that was not installed, compared two empty strings, and printed
// OK six times.
//
// So the digest half is the part people think of and the smaller part of what
// this buys. checkTrove runs it as check 4, and adds the six a reader cannot
// hand-roll at all — above all anti-cloaking, which is the reader's own threat
// model: text addressed to their agent that they cannot see on the page.

export async function verify(options: { troveUrl: string }): Promise<void> {
	const { troveUrl } = options

	const { report } = await checkTrove({ read: httpReader(troveUrl) })

	console.log(troveUrl)
	console.log(describeChecks(report))
	console.log(
		report.ok
			? "conforms to the trove standard — every check passed"
			: "does NOT conform — the failing checks are above",
	)

	// Non-zero so this is usable as a gate in a script, matching `register`,
	// which also reports a real verdict through the exit code rather than only
	// in prose.
	if (!report.ok) {
		process.exitCode = 1
	}
}
