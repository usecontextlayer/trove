import type { ContractCheckReport } from "@usecontextlayer/trove-standard"

// Rendering a §6.1 report for a human or an agent reading the terminal. The
// registry returns the full report on every registration — printing only its
// top-line string sent a creator to inspect a manifest that was perfect, while
// the actual cause (a fetch that never reached the trove) sat unread in the
// response body.

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
