import { TROVE_ORIGIN } from "@usecontextlayer/trove-standard"

// The CLI's env boundary (TROVE_* scheme). TROVE_REGISTRY_URL points the
// register call and remix's canonical-URL parsing at a non-production registry
// — dev and tests only; it defaults to the real origin and nothing else reads
// process.env.
export const env = {
	TROVE_REGISTRY_URL: process.env.TROVE_REGISTRY_URL ?? TROVE_ORIGIN,
} as const
