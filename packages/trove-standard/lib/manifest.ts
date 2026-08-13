import { z } from "zod"
import { ID_PATTERN } from "@/lib/id"

// The manifest — trove.json (§3 of the standard): identity, lineage, and
// inventory. Per-file fields are the OCI content descriptor's required triple
// (mediaType, digest, size) plus path, which OCI carries in an annotation.

/** OCI digest grammar, restricted as the standard requires: lowercase hex only. */
export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/

// RFC 6838 type/subtype (restricted-name grammar), without parameters — the
// manifest records the media type's essence; the checker compares it against
// the served Content-Type with any parameters (`; charset=utf-8`) stripped,
// since a text response usually carries a charset. The host itself appends
// none: the charset comes from the publishing tool's generated `_headers`,
// and only over bytes that are UTF-8.
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

// A manifest does NOT state its own URL, and cannot: the trove's URL is
// assigned by the host at deploy time, while the manifest is written before it
// — so a self-reference would force a second deploy, and the bytes verified
// would stop being the bytes shipped. It is also unnecessary for the same
// reason trove.json excludes itself: whoever is reading it already holds the
// URL they fetched it from. `id` remains, as the identity registration keys on
// and the mandated block carries.
export const manifestSchema = z
	.object({
		files: z.array(manifestFileSchema),
		id: z.string().regex(ID_PATTERN),
		// The trove this was remixed from, at its own URL — where it is actually
		// served, since that is the only address a trove has. `parentDigest` pins
		// which version was remixed.
		parent: z.url().optional(),
		parentDigest: z.string().regex(DIGEST_PATTERN).optional(),
		// A JSON number — not a string, not dotted. A wire format either breaks
		// readers or it does not, so minor and patch versions would carry no
		// meaning here.
		//
		// Deliberately NOT pinned to the current version. Only the current version
		// conforms — there is no backward compatibility and nothing is kept alive
		// for a retired one — but "written to a version I do not implement" and
		// "corrupt" are different answers, and a reader needs to be told which. So
		// any version parses, and the checker is where the version verdict is
		// formed and named.
		standard: z.number().int().min(1),
	})
	.superRefine((manifest, ctx) => {
		// Both absent on an original, both present on a remix — never one without
		// the other.
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
