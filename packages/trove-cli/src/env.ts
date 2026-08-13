import { TROVE_ORIGIN } from "@usecontextlayer/trove-standard"

// The CLI's env boundary (TROVE_* scheme). TROVE_REGISTRY_URL names the
// registry the `register` call writes to and whose record URL it prints, and it
// is also the origin both `register` and `remix` compare an argument against to
// recognise a registry URL handed over in place of a trove's — dev and tests
// only; it defaults to the real origin and nothing else reads process.env.
export const env = {
	TROVE_REGISTRY_URL: process.env.TROVE_REGISTRY_URL ?? TROVE_ORIGIN,
} as const
