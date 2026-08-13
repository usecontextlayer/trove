import type {
	ContractCheckReport,
	ContractCheckStatus,
} from "@usecontextlayer/trove-standard"

// Rendering a §6.1 report for a human or an agent reading the terminal. The
// registry returns the full report on every registration — printing only its
// top-line string sent a creator to inspect a manifest that was perfect, while
// the actual cause (a fetch that never reached the trove) sat unread in the
// response body.

// Fixed-width so the check names line up; a report read under time pressure is
// scanned down the left edge.
const STATUS_LABEL = {
	failed: "FAIL",
	"not-checked": "----",
	ok: "  ok",
} as const satisfies Record<ContractCheckStatus, string>

/**
 * Every check with its verdict, for `trove dev` — where the passing ones are
 * the point, since the question being asked is "is this ready to publish".
 * `describeFailures` stays separate because publish and register speak only
 * when something is wrong.
 */
export function describeChecks(report: ContractCheckReport): string {
	return report.checks
		.map((check) => {
			const detail = check.detail === undefined ? "" : ` — ${check.detail}`
			return `  ${STATUS_LABEL[check.status]}  ${check.name}${detail}`
		})
		.join("\n")
}

const RULE = "═".repeat(74)

/**
 * The banner a remixer sees when the parent does not conform.
 *
 * Remixing a non-conformant trove is ALLOWED — forking something slightly
 * broken in order to fix it is a real and legitimate thing to want, and there
 * is no override flag to pass because there is nothing to override. What must
 * not happen is that it goes by quietly: the failure is now the remixer's, it
 * is already in their copy, and the next `publish` fails the same way.
 *
 * The digest half is called out explicitly because the two are constantly
 * confused. Every file matching its digest and the trove conforming are
 * unrelated claims: bytes can be exactly what the manifest promised while the
 * page hides text from the human reading it.
 */
export function describeNonConformance(
	troveUrl: string,
	report: ContractCheckReport,
): string {
	const cloaked = report.checks.some(
		(check) => check.name === "anti-cloaking" && check.status === "failed",
	)
	return [
		"",
		RULE,
		"  !!  THIS TROVE DOES NOT CONFORM TO THE TROVE STANDARD  !!",
		RULE,
		"",
		describeFailures(report),
		"",
		"  Remixed anyway, because that is a thing you may legitimately want.",
		"  What you have taken on:",
		"",
		"  - Every file DID match its digest. That is a separate claim from the",
		"    one above, and it is not the one that failed.",
		"  - Whatever failed is in your copy now. Publishing it fails the same",
		"    checks, in the same way.",
		...(cloaked
			? [
					"  - anti-cloaking failed. That means text addressed to agents that a",
					"    human reading the page CANNOT SEE. Read it before you republish",
					"    it — you would be passing it on under your own name.",
				]
			: []),
		"",
		`  Full report:  npx @usecontextlayer/trove verify ${troveUrl}`,
		RULE,
		"",
	].join("\n")
}

/** The failed checks, one per line, with the reason each gave. */
export function describeFailures(report: ContractCheckReport): string {
	return report.checks
		.filter((check) => check.status === "failed")
		.map((check) => `  ${check.name}: ${check.detail ?? "failed"}`)
		.join("\n")
}

/**
 * One line naming what actually ran. `not-checked` is counted separately from
 * `ok` because it means "this position does not run this check" — reporting it
 * as passed would claim verification that never happened, and the registry
 * deliberately does not verify manifest files (§6).
 */
export function summarizeReport(report: ContractCheckReport): string {
	const counts = { failed: 0, "not-checked": 0, ok: 0 }
	for (const check of report.checks) {
		counts[check.status] += 1
	}
	const parts = [`${counts.ok} passed`]
	if (counts.failed > 0) {
		parts.push(`${counts.failed} failed`)
	}
	if (counts["not-checked"] > 0) {
		parts.push(`${counts["not-checked"]} not checked here`)
	}
	return parts.join(", ")
}
