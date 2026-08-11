import { z } from "zod"
import { canonicalUrlForId } from "@/lib/canonical"
import { ID_PATTERN, isWellFormedId } from "@/lib/id"

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

/**
 * §3's trove-path grammar: a path resolves inside the trove and nowhere else.
 * Exactly one leading `/`, no `.` or `..` segment, no query, fragment,
 * backslash, or scheme.
 *
 * The containment half of that meaning used to be unencoded — `path` was
 * validated as "begins with a slash" — and three layers each re-interpreted the
 * bare string with a different resolver. `//host/x` is a protocol-relative
 * AUTHORITY, so `new URL(path, troveUrl)` silently resolved to a different
 * origin (a trove could be certified while a listed file was served by a third
 * party, and the registry became an unauthenticated fetcher of arbitrary URLs);
 * `/../../x` escaped the destination directory when a remixer wrote it to disk.
 * Encoding it here means all three positions inherit containment from the data
 * model instead of each needing its own guard.
 *
 * `%2e` is decoded before the segment test because the URL parser treats it as
 * a dot for dot-segment purposes, so `/a/%2e%2e/b` traverses just as `/a/../b`
 * does.
 */
function isTrovePath(path: string): boolean {
	if (!path.startsWith("/") || path.startsWith("//")) {
		return false
	}
	if (/[?#\\]/.test(path)) {
		return false
	}
	return !path.split("/").some((segment) => {
		const decoded = segment.replaceAll(/%2e/gi, ".")
		return decoded === "." || decoded === ".."
	})
}

export const manifestFileSchema = z.object({
	digest: z.string().regex(DIGEST_PATTERN),
	mediaType: z.string().regex(MEDIA_TYPE_PATTERN),
	// A trove path (see above). "/" itself is the index page's entry (§3's
	// membership rule).
	path: z.string().refine(isTrovePath, {
		message:
			"must be a path inside the trove: one leading slash, no . or .. segment, no query, fragment, or backslash",
	}),
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
		// A JSON number — not a string, not dotted. Consumers branch with >=; a
		// wire format either breaks readers or does not. Deliberately NOT
		// `literal(1)`: a newer trove must parse so the checker can report it as
		// newer rather than as malformed, which is what makes the wire text
		// changeable without invalidating troves already published.
		standard: z.number().int().min(1),
	})
	.superRefine((manifest, ctx) => {
		// Guarded: canonicalUrlForId ASSERTS a well-formed id and throws, which
		// escaped safeParse — whose whole contract is that it does not throw —
		// and surfaced three layers up as "not valid JSON", the wrong cause.
		if (!isWellFormedId(manifest.id)) {
			return
		}
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
