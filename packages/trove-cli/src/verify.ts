import { existsSync, statSync } from "node:fs"
import { checkTrove, httpReader } from "@usecontextlayer/trove-standard"
import { parseTroveUrl } from "@/src/remix"
import { describeChecks } from "@/src/report"
import { freePort, withServedTrove } from "@/src/served-trove"

// `trove verify` — the §6.1 checker, asking one question: does this conform?
//
// It takes a live trove's URL or a local folder, because that is one question
// about one thing at two moments in its life, not two questions. The checker
// itself already works this way: §6 defines ONE implementation running in
// several positions, differing only in the reader adapter underneath it. The
// positions are an implementation fact; "is this conformant" is the concept, and
// the concept gets the name.
//
// Splitting it into `verify url` and `verify folder` was considered and
// rejected. The measured failure in this product is DISCOVERY — three separate
// reading agents, handed a trove URL, never found that any verification tool
// existed and hand-rolled the check instead. Under subcommands the obvious
// `trove verify <thing>` answers "unknown command"; here it works.
//
// It only ever reads. Nothing is deployed, no account is touched, no id is
// registered, and the folder form starts no 60-minute clock.

/**
 * Which of the two things the argument is.
 *
 * A discriminated union rather than two optional fields, so the caller cannot
 * hold "both" or "neither" — the states that do not exist should not be
 * representable.
 */
type VerifyTarget = { folder: string; kind: "folder" } | { kind: "url"; troveUrl: string }

/**
 * Read the argument as a URL if it is one, and as a folder otherwise.
 *
 * The test is the scheme, which is what makes this unambiguous rather than a
 * guess: a trove URL is always `http(s)://…`, and a path never parses as a URL
 * with an http scheme. A folder literally named `https://…` is not a case worth
 * designing for.
 *
 * The failure message names BOTH readings on purpose. The likeliest way to
 * arrive here is a URL missing its scheme (`trove-abc.workers.dev`), which is
 * not a URL and is not a directory either — and an error that mentions only one
 * of those sends the reader looking in the wrong place.
 */
export function parseVerifyTarget(registryUrl: string, target: string): VerifyTarget {
	let url: URL | null = null
	try {
		url = new URL(target)
	} catch {
		url = null
	}
	if (url !== null && (url.protocol === "http:" || url.protocol === "https:")) {
		return { kind: "url", troveUrl: parseTroveUrl(registryUrl, target) }
	}
	if (existsSync(target) && statSync(target).isDirectory()) {
		return { folder: target, kind: "folder" }
	}
	throw new Error(
		`"${target}" is neither a folder that exists nor an http(s) URL. Pass a trove's URL to check one that is live, or a folder to check one before you publish it. (A URL needs its scheme: https://${target})`,
	)
}

export async function verify(options: {
	registryUrl: string
	target: string
}): Promise<void> {
	const { registryUrl, target } = options
	const parsed = parseVerifyTarget(registryUrl, target)

	// The folder form assembles and serves the trove exactly as publish would
	// and checks it over real HTTP — so the answer is about what WOULD ship, not
	// about the loose files on disk, which carry no mandated block and no
	// manifest until assembly generates them.
	const { report, url } =
		parsed.kind === "url"
			? {
					report: (await checkTrove({ read: httpReader(parsed.troveUrl) })).report,
					url: parsed.troveUrl,
				}
			: await withServedTrove(
					{ folder: parsed.folder, port: await freePort() },
					async (served) => ({
						report: (
							await checkTrove({
								expectedId: served.id,
								read: httpReader(served.url),
							})
						).report,
						url: `${parsed.folder} (served locally)`,
					}),
				)

	console.log(url)
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
