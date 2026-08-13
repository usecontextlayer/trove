import { existsSync, statSync } from "node:fs"
import {
	type ContractCheckReport,
	checkTrove,
	httpReader,
} from "@usecontextlayer/trove-standard"
import { describeChecks } from "@/src/report"
import { freePort, withServedTrove } from "@/src/served-trove"
import { waitUntilServing } from "@/src/serving"
import { parseTroveUrl } from "@/src/trove-url"

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
		return {
			kind: "url",
			troveUrl: parseTroveUrl({ command: "trove verify", from: target, registryUrl }),
		}
	}
	if (existsSync(target) && statSync(target).isDirectory()) {
		return { folder: target, kind: "folder" }
	}
	throw new Error(
		`"${target}" is neither a folder that exists nor an http(s) URL. Pass a trove's URL to check one that is live, or a folder to check one before you publish it. (A URL needs its scheme: https://${target})`,
	)
}

/** The verdict, and what it is about. */
export interface VerifyResult {
	report: ContractCheckReport
	/** What was checked, as the caller named it — a URL, or a folder path. */
	subject: string
}

/** A live trove, checked over HTTP exactly as a reader would. */
async function verifyLive(troveUrl: string): Promise<VerifyResult> {
	// Wait out propagation first, on the same terms as `publish` and `register`
	// — same mechanism, same budget. A fresh deployment does not simply come up,
	// it FLAPS, so a checker that reads it once reports a healthy trove as
	// broken: measured twice, and the second time the creator only avoided
	// republishing (which would have burned the id) by disbelieving the tool and
	// probing by hand. One rule across the command family beats three commands
	// giving three answers about the same condition.
	try {
		await waitUntilServing(troveUrl)
	} catch (error) {
		// A URL with nothing behind it is not a non-conformant trove — it is not
		// a trove. Reporting seven failing checks would answer a question nobody
		// asked and imply a trove exists that fails them.
		throw new Error(
			`nothing is serving a trove at ${troveUrl}, so there is nothing to check. If it was published moments ago, propagation may still be settling — wait a minute and run this again. If it was published over an hour ago and never claimed, an anonymous preview is deleted after 60 minutes and this URL is gone for good.\n${String(error)}`,
		)
	}
	const { report } = await checkTrove({ read: httpReader(troveUrl) })
	return { report, subject: troveUrl }
}

/**
 * A folder, assembled and served exactly as publish would, then checked over
 * real HTTP — so the answer is about what WOULD ship, not about the loose files
 * on disk, which carry no mandated block and no manifest until assembly
 * generates them.
 */
async function verifyFolder(folder: string): Promise<VerifyResult> {
	return withServedTrove({ folder, port: await freePort() }, async (served) => {
		const { report } = await checkTrove({
			expectedId: served.id,
			read: httpReader(served.url),
		})
		return { report, subject: `${folder} (served locally)` }
	})
}

/**
 * Check a trove and RETURN the verdict; printing and the exit code belong to the
 * caller.
 *
 * Returning rather than printing is what makes this testable through its
 * contract: while it only printed, the only way to assert anything about it was
 * to scrape stdout, which pins the wording instead of the verdict and cannot
 * tell WHICH check failed. `remixTrove` already returns its report; this is the
 * same shape.
 */
export async function verify(options: {
	registryUrl: string
	target: string
}): Promise<VerifyResult> {
	const parsed = parseVerifyTarget(options.registryUrl, options.target)
	return parsed.kind === "url" ? verifyLive(parsed.troveUrl) : verifyFolder(parsed.folder)
}

/**
 * The verdict as a reader sees it. Separate from the checking so the checking
 * can be asserted on.
 *
 * The passing line states its own scope, because it is read at the moment
 * someone is deciding whether to stop looking. Measured: a trove holding two
 * raw files and a 14-byte placeholder manual passes all seven checks and was
 * told it "conforms" — correctly, since check 3 asks only that AGENTS.md be
 * non-empty. The checks were right and the sentence over-claimed, which is the
 * same rule the repo already holds for the word "certified": no output may
 * imply more than what ran.
 */
export function describeVerdict(result: VerifyResult): string {
	return [
		result.subject,
		describeChecks(result.report),
		result.report.ok
			? "conforms to the trove standard — all seven contract checks pass. That is a format verdict, not a quality one: a trove whose AGENTS.md says nothing useful passes it too."
			: "does NOT conform — the failing checks are above",
	].join("\n")
}
