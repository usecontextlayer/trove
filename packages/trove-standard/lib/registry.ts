import { assertWellFormedId } from "@/lib/id"

/**
 * THE one constant naming Trove's own domain (§3 of the standard: "The domain
 * MUST appear in exactly one constant in every implementation, so that moving
 * to a different host or apex is a single edit"). Never inline this hostname at
 * a second site — derive from here.
 *
 * This names the REGISTRY, not troves. A trove's URL is wherever its creator
 * deployed it, and nothing here derives it: a trove is static content served
 * from its creator's own account, and Trove is not on the path that reads it.
 */
export const TROVE_ORIGIN = "https://trove.usecontextlayer.com"

/**
 * Where the registry publishes what it observed about a trove — its stored
 * contract-check verdict, its lineage, and the host it is bound to.
 *
 * The registry is a PARAMETER here, not the constant above. Reading it from
 * TROVE_ORIGIN instead meant a caller pointed at another registry wrote its
 * record to that one and then printed a production URL for it — a URL naming a
 * record that does not exist there, in the same breath as the write that
 * created it elsewhere. Only whoever performed the write knows where it landed.
 *
 * This replaced `canonicalUrlForId`, and the rename is the change. The old
 * function returned a trove's "canonical URL": a second identity we minted and
 * served, which every document told people to share, and which every read
 * therefore routed through us. It justified itself as the name that survives a
 * trove moving host — while §7 simultaneously bound an id to one host forever
 * and offered no move route, so it was a stable name for something already
 * stable. What it actually bought was our Worker on the critical path for
 * reading someone else's static files.
 *
 * A record is not an identity. It is one party's observation about a trove, it
 * is optional to consult, and nothing breaks when it is absent.
 */
export function recordUrlForId(registryUrl: string, id: string): string {
	assertWellFormedId(id)
	// The URL object composes the string. Building one by concatenation is what
	// turned a subpath into a protocol-relative authority once already, and the
	// rule that came out of it binds everywhere a URL is assembled, not just
	// where it was broken.
	return new URL(`/a/${id}.json`, registryUrl).href
}
