// Waiting for a URL to start serving. Three commands need this and only one of
// them deploys: `register` polls a trove it did not put there and never touches
// wrangler, `publish` waits out its own deployment, and `withServedTrove` waits
// for a local `wrangler dev` to finish booting. The propagation facts below are
// what set the defaults; the polling is what all three actually want.

/** How long to keep trying a path that may not be serving yet, and how often. The defaults are sized to the measured propagation window. */
export interface SettlingOptions {
	pollMs?: number
	timeoutMs?: number
}

/**
 * Fetch a path that may not be serving yet, returning the first response that
 * arrives ok.
 *
 * **Returning the response is the point**, and it is what separates this from
 * polling and then fetching separately. A fresh anonymous deployment does not
 * simply come up — it FLAPS: measured on one preview, `/trove.json` answered
 * `200, 404, 200, 200, 404, 200` at three-second intervals. A caller that waits
 * for a path to answer and then makes its real request loses that race about as
 * often as the flap rate, which is exactly the failure this exists to remove.
 *
 * A transport failure is a not-serving-yet OBSERVATION, not the end of the
 * poll. A fresh anonymous deploy lands on a brand-new workers.dev slug, so DNS
 * may not resolve for the first second or two and `fetch` REJECTS rather than
 * returning a status — which ended the loop 9ms into a 60s budget and reported
 * a healthy deploy as broken. §8: poll until it serves or until the deadline;
 * do not classify. The deadline is the one loud failure point.
 */
export async function fetchWhileSettling(
	url: URL,
	options: SettlingOptions = {},
): Promise<Response> {
	const pollMs = options.pollMs ?? 1000
	const timeoutMs = options.timeoutMs ?? 60_000
	const deadline = Date.now() + timeoutMs
	let last = "no response yet"
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url)
			if (response.ok) {
				return response
			}
			const body = await response.text()
			last = `${response.status} (${response.headers.get("content-type") ?? "no content type"}): ${body.slice(0, 80)}`
		} catch (error) {
			last = `transport error: ${String(error)}`
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
	throw new Error(
		`${url.href} did not start serving within ${timeoutMs}ms; last response: ${last}`,
	)
}

/**
 * Wait for the root to answer, discarding the response — for callers that only
 * need to know the trove is up. `publish` re-reads everything through the
 * checker immediately afterwards (§8 step 4), and `withServedTrove` hands the
 * URL straight to its caller.
 */
export async function waitUntilServing(
	hostUrl: string,
	options: SettlingOptions = {},
): Promise<void> {
	await fetchWhileSettling(new URL("/", hostUrl), options)
}
