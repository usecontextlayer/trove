import { mkdtempSync } from "node:fs"
import { createServer } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { mintId } from "@usecontextlayer/trove-standard"
import { assembleTrove } from "@/src/assemble"
import { readRemixMarker } from "@/src/remix"
import { serveAssembled, waitUntilServing, writeWranglerConfig } from "@/src/wrangler"

// Standing a folder up as a real, locally-served trove — the one thing `dev`,
// `verify <folder>` and `dev screenshot` all need before they can do their
// different jobs. It is a BRACKET rather than a helper because the interesting
// part is the teardown: the server is a spawned `wrangler dev` process, and a
// command that forgets to stop it leaks one per invocation.
//
// That is not hypothetical. Before this existed, the only caller was `dev`,
// which deliberately never stops on success because blocking IS its job — so
// the obvious way to reuse it (copy the shape) is exactly the way that leaks.
// Here teardown is unconditional and in one `finally`, and the one command that
// wants to keep serving opts into that INSIDE the bracket by awaiting
// `finished`.

/** A trove assembled from a folder and served by the host's own asset layer. */
export interface ServedTrove {
	/** Resolves when the server exits — Ctrl-C, or a crash. Await it to keep serving. */
	finished: Promise<unknown>
	/** The throwaway id minted for this run. The block and the manifest both carry one and the checker compares them. */
	id: string
	url: string
}

/**
 * A port nothing is listening on, chosen by the OS.
 *
 * One-shot commands take one of these rather than a fixed default, because a
 * fixed default collides with a `trove dev` already running in another terminal
 * — which is the normal way to use these two together. `dev` itself keeps an
 * explicit `--port`: a human returning to a page in a browser wants the URL to
 * be the same one as last time.
 */
export async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
	const address = probe.address()
	if (address === null || typeof address === "string") {
		throw new Error("could not reserve a local port")
	}
	const { port } = address
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

/**
 * Assemble `folder` exactly as `publish` would, serve it with the host's own
 * asset layer, and hand the running trove to `use`. The server is always
 * stopped afterwards, however `use` ends.
 *
 * Assembling with publish's own writer is deliberate: a command that checked or
 * photographed a differently-served trove than the one that later deploys is
 * the single failure that would make all of this worthless.
 */
export async function withServedTrove<T>(
	options: { folder: string; port: number },
	use: (served: ServedTrove) => Promise<T>,
): Promise<T> {
	const { folder, port } = options

	// A throwaway id: both the mandated block and the manifest carry one and the
	// checker compares them, so a local trove needs an id even though nothing
	// will ever be registered under it.
	const id = mintId()
	const marker = readRemixMarker(folder)

	const deployDir = mkdtempSync(path.join(os.tmpdir(), "trove-local-"))
	const troveDir = path.join(deployDir, "trove")
	assembleTrove({
		destDir: troveDir,
		id,
		...(marker === null
			? {}
			: { parent: marker.parent, parentDigest: marker.parentDigest }),
		sourceDir: folder,
	})
	writeWranglerConfig({ deployDir, id })

	const server = serveAssembled({ deployDir, port })
	try {
		await waitUntilServing(server.url)
		return await use({ finished: server.finished, id, url: server.url })
	} finally {
		server.stop()
	}
}
