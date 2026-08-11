import { z } from "zod"
import { canonicalUrlForId } from "@/lib/canonical"
import { ID_PATTERN } from "@/lib/id"

// The manifest — trove.json (§3 of the standard): identity, lineage, and
// inventory. Per-file fields are the OCI content descriptor's required triple
// (mediaType, digest, size) plus path, which OCI carries in an annotation.

/** OCI digest grammar, restricted as the standard requires: lowercase hex only. */
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/

// RFC 6838 type/subtype (restricted-name grammar), without parameters — the
// manifest records the media type's essence; the checker compares it against
// the served Content-Type with any parameters (`; charset=utf-8`) stripped,
// since the host appends a charset to text types.
const MEDIA_TYPE_PATTERN =
	/^[a-z0-9][a-z0-9!#$&\-^_.+]{0,126}\/[a-z0-9][a-z0-9!#$&\-^_.+]{0,126}$/i

export const manifestFileSchema = z.object({
	digest: z.string().regex(DIGEST_PATTERN),
	mediaType: z.string().regex(MEDIA_TYPE_PATTERN),
	// Absolute path within the trove, leading slash. "/" itself is the index
	// page's entry (§3's membership rule).
	path: z.string().regex(/^\//),
	// Decoded byte length, never Content-Length as sent — the host serves
	// brotli, so wire length varies with Accept-Encoding; decoded length is the
	// quantity the digest is computed over, so the two always agree.
	size: z.number().int().nonnegative(),
})

export const manifestSchema = z
	.object({
		canonical: z.url(),
		files: z.array(manifestFileSchema),
		id: z.string().regex(ID_PATTERN),
		parent: z.url().optional(),
		parentDigest: z.string().regex(DIGEST_PATTERN).optional(),
		// The JSON number 1 — not a string, not dotted. Consumers branch with >=;
		// a wire format either breaks readers or does not.
		standard: z.literal(1),
	})
	.superRefine((manifest, ctx) => {
		if (manifest.canonical !== canonicalUrlForId(manifest.id)) {
			ctx.addIssue({
				code: "custom",
				message: `canonical must be derived from id: expected ${canonicalUrlForId(manifest.id)}`,
				path: ["canonical"],
			})
		}
		// parent is the canonical URL of the trove this was remixed from;
		// parentDigest pins which version. Both absent on an original, both
		// present on a remix — never one without the other.
		if ((manifest.parent === undefined) !== (manifest.parentDigest === undefined)) {
			ctx.addIssue({
				code: "custom",
				message: "parent and parentDigest must be present together or not at all",
				path: ["parent"],
			})
		}
	})

export type ManifestFile = z.infer<typeof manifestFileSchema>
export type TroveManifest = z.infer<typeof manifestSchema>
