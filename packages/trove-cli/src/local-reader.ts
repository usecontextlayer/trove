import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import type { TroveReader } from "@usecontextlayer/trove-standard"
import mime from "mime"

// The local adapter — the creator-machine position of the §6.1 checker, over
// an ASSEMBLED trove directory, applying the serving rules the assembly
// just generated: "/" serves index.html, every response carries noindex (the
// generated _headers rule), and content types resolve as the host will serve
// them — the host's asset layer uses this same `mime` package.
//
// One generated rule is deliberately NOT modelled: the charset the _headers
// declares on UTF-8 text types. Every media-type comparison comes down to
// essence (parameters stripped), so the parameter is immaterial to every check
// as written, and reproducing it here would mean duplicating the per-extension
// UTF-8 logic that decides it — a second implementation to drift. Should a
// check ever read the charset rather than strip it, this is where the two
// positions would diverge.
export function localReader(assembledDir: string): TroveReader {
	return async (trovePath) => {
		const relative = trovePath === "/" ? "index.html" : trovePath.slice(1)
		const filePath = path.join(assembledDir, relative)
		if (!existsSync(filePath)) {
			return {
				bytes: new Uint8Array(),
				contentType: null,
				noindex: false,
				ok: false,
				status: 404,
			}
		}
		const bytes = new Uint8Array(readFileSync(filePath))
		const contentType =
			trovePath === "/" ? "text/html; charset=utf-8" : mime.getType(relative)
		return { bytes, contentType, noindex: true, ok: true, status: 200 }
	}
}
