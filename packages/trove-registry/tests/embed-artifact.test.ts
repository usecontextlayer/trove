import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

// trove.js is ASCII-only, and this is where that is enforced — the registry
// owns the served copy (its build is `cp ../trove-embed/dist/trove.js
// public/trove.js`), and turbo's `^build` guarantees the artifact exists here.
//
// Asserted on the BUILT bundle rather than the source, because the property has
// to hold for the bytes a browser actually receives. It is checkable at the
// source too, and the source keeps itself ASCII for the same reason — but only
// the bundle proves the toolchain preserved it.

// Resolved from this file rather than the cwd, and without `fileURLToPath`:
// this package is typed for workerd, so `URL` here is the platform's, not
// node's, and the two are not assignable to each other.
const embedDist = path.join(
	new URL(".", import.meta.url).pathname,
	"../../trove-embed/dist/trove.js",
)

describe("the trove.js served to every trove", () => {
	it("is ASCII-only, so no page's encoding can mojibake it", () => {
		// A classic <script> with no charset of its own is decoded using the
		// EMBEDDING page's encoding. A trove may serve its page in any encoding,
		// so one em dash in the bundle renders as mojibake in the bar of every
		// non-UTF-8 trove. ASCII decodes identically under all of them.
		//
		// This does not depend on the bundle being minified. Minification happens
		// to strip the comments where the repo's house em dash lives, so a
		// `minify: false` build for debugging would otherwise quietly reintroduce
		// non-ASCII into a supply-chain script.
		const bundle = readFileSync(embedDist)

		const offending = [...bundle]
			.map((byte, index) => ({ byte, index }))
			.filter((entry) => entry.byte > 0x7f)
			.slice(0, 5)
			.map((entry) => {
				const from = Math.max(0, entry.index - 30)
				const around = bundle.subarray(from, entry.index + 30).toString()
				return `byte 0x${entry.byte.toString(16)} at ${entry.index}: ${around}`
			})

		expect(offending).toEqual([])
	})
})
