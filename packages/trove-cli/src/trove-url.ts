// A trove's own URL, normalized at the boundary — one concept, one home.
//
// Three commands take this argument (`verify`, `register`, `remix`) and each had
// grown its own copy of the same three refusals, differing only in prose. That
// is one concept wearing several names, and it was already leaking: `verify`
// reached into `remix.ts` for a URL parser, which is not where a URL parser
// lives. The command's own sentence is a parameter; the rules are not.

/**
 * Normalize a trove's URL to its origin, refusing the two things it must not be.
 *
 * **A registry URL** is the predictable confusion, because the registry
 * publishes a trove's URL inside a record and an agent that read the record can
 * take the wrong field. It 302s to a trove and has no subtree, so every path
 * built under it 404s — worth naming in one message rather than discovering one
 * fetch at a time.
 *
 * **A path, query or fragment** is refused rather than stripped. §2.1: a trove
 * is served at a host root, so a URL carrying a path parses fine and then
 * resolves every manifest entry against the wrong base — a silently wrong
 * answer rather than a refusal. Returning the origin would discard the path
 * just as silently, so it is rejected instead, naming the URL that would work.
 *
 * Which HOSTS are acceptable — https, `*.workers.dev` — is deliberately NOT
 * checked here: the registry owns that rule, and re-encoding it in a second
 * place is how the two drift apart.
 */
export function parseTroveUrl(options: {
	/** How the caller was invoked, so the message tells the reader what THEY typed. */
	command: string
	from: string
	registryUrl: string
}): string {
	const { command, from, registryUrl } = options

	const url = URL.parse(from)
	if (url === null) {
		throw new Error(`"${from}" is not a URL. ${command} takes the trove's own URL.`)
	}
	if (url.origin === URL.parse(registryUrl)?.origin) {
		throw new Error(
			`${from} is a Trove registry URL, not a trove. ${command} takes the trove's own URL — publish prints it as the "trove:" line, and the registry publishes it as "hostUrl" at ${registryUrl}/a/<id>.json.`,
		)
	}
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		throw new Error(
			`${from} carries a path, query, or fragment. A trove is served at a host root, so its URL is just the origin — try ${url.origin}.`,
		)
	}
	return url.origin
}
