import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import type { ArtifactReader } from "@usecontextlayer/trove-standard"
import mime from "mime"

// The local adapter — the creator-machine position of the §6.1 checker, over
// an ASSEMBLED artifact directory, applying the serving rules the assembly
// just generated: "/" serves index.html, every response carries noindex (the
// generated _headers rule), and content types resolve as the host will serve
// them — the host's asset layer uses this same `mime` package.
export function localReader(assembledDir: string): ArtifactReader {
	return async (artifactPath) => {
		const relative = artifactPath === "/" ? "index.html" : artifactPath.slice(1)
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
			artifactPath === "/" ? "text/html; charset=utf-8" : mime.getType(relative)
		return { bytes, contentType, noindex: true, ok: true, status: 200 }
	}
}
