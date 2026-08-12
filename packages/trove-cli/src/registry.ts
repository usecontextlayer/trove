import type { ContractCheckReport } from "@usecontextlayer/trove-standard"
import { describeFailures } from "@/src/report"

// The registry client — one call. registryUrl arrives as a parameter (the CLI
// wires it from env.ts) so the seam stays explicit.

export interface RegistryRecord {
	contractCheck: ContractCheckReport & { checkedAt: string }
	hostUrl: string
	id: string
	parent: string | null
	registeredAt: string
	standard: number
}

/** What the registry answers with when it refuses: a reason, and the report when it got far enough to have one. */
interface RegistryRefusal {
	error?: string
	report?: ContractCheckReport
}

export async function registerTrove(
	registryUrl: string,
	id: string,
	hostUrl: string,
): Promise<RegistryRecord> {
	const response = await fetch(new URL("/register", registryUrl), {
		body: JSON.stringify({ hostUrl, id }),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
	// Read as text and parse deliberately. Calling response.json() first made
	// every non-JSON failure — a gateway error page, a 502, an empty body —
	// reach the caller as a JSON syntax error naming neither the status nor
	// the registry.
	const text = await response.text()
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		throw new Error(
			`the registry answered ${response.status} with a body that is not JSON:\n${text.slice(0, 400)}`,
		)
	}
	if (!response.ok) {
		const refusal = body as RegistryRefusal
		// The report is the actionable half and the registry always sends it
		// when it ran the checks; the top-line string alone names the symptom
		// ("does not serve a valid /trove.json") rather than the cause.
		const failures =
			refusal.report === undefined ? "" : `\n${describeFailures(refusal.report)}`
		throw new Error(
			`the registry refused this trove (${response.status}): ${refusal.error ?? text}${failures}`,
		)
	}
	return body as RegistryRecord
}
