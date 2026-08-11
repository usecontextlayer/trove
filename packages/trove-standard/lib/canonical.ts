import { assertWellFormedId } from "@/lib/id"

/**
 * THE one constant naming the canonical domain (§3 of the standard: "The domain
 * MUST appear in exactly one constant in every implementation, so that moving
 * to a different host or apex is a single edit"). Never inline this hostname at
 * a second site — derive from here.
 */
export const TROVE_ORIGIN = "https://trove.usecontextlayer.com"

/** The trove's canonical URL — its stable identity, derived purely from the id. */
export function canonicalUrlForId(id: string): string {
	assertWellFormedId(id)
	return `${TROVE_ORIGIN}/a/${id}`
}
