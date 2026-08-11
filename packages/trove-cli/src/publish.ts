import { mkdtempSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mintId } from "@usecontextlayer/trove-standard"
import { assembleArtifact } from "@/src/assemble"
import { registerArtifact } from "@/src/registry"
import { readRemixMarker } from "@/src/remix"
import {
	COMPATIBILITY_DATE,
	deployAssembled,
	detectCredentialState,
	waitUntilServing,
} from "@/src/wrangler"

// Publish (§8): mint the id locally, assemble, deploy, verify, register, print.
// Minting locally is what keeps this to one deploy and one registry call.

export async function publish(options: {
	folder: string
	registryUrl: string
}): Promise<void> {
	const { folder, registryUrl } = options

	const id = mintId()
	const marker = readRemixMarker(folder)

	const deployDir = mkdtempSync(path.join(os.tmpdir(), "trove-publish-"))
	assembleArtifact({
		destDir: path.join(deployDir, "artifact"),
		id,
		...(marker === null
			? {}
			: { parent: marker.parent, parentDigest: marker.parentDigest }),
		sourceDir: folder,
	})
	// The deploy config sits OUTSIDE the assets directory — wrangler publishes
	// its own scratch files, so the artifact is always a subdirectory, never ".".
	// The name derives from the id (DNS-label-safe); the compatibility date is a
	// constant so two publishes of the same artifact behave identically.
	writeFileSync(
		path.join(deployDir, "wrangler.jsonc"),
		`${JSON.stringify(
			{
				assets: { directory: "./artifact" },
				compatibility_date: COMPATIBILITY_DATE,
				name: `trove-${id.slice(0, 8)}`,
			},
			null,
			"\t",
		)}\n`,
	)

	// §6.2's security scans (Betterleaks, anti-trojan-source) are not wired yet.
	// Stated on every publish rather than silently skipped: certification must
	// never claim more than what ran.
	console.error(
		"note: local security scans are not wired yet (betterleaks, anti-trojan-source)",
	)

	// Ask wrangler itself — whoami honors both `wrangler login` OAuth state and
	// CLOUDFLARE_API_TOKEN, so this catches every way a user can be logged in.
	const anonymous = (await detectCredentialState()) === "anonymous"
	const deployed = await deployAssembled({ anonymous, deployDir })
	await waitUntilServing(deployed.hostUrl)

	// The claim URL prints even if registration then fails — losing it lets the
	// artifact silently evaporate within the hour, the worst first experience.
	try {
		const record = await registerArtifact(registryUrl, id, deployed.hostUrl)
		console.log(record.canonical)
	} catch (error) {
		console.error(
			`registration failed — the artifact is live but unregistered: ${String(error)}`,
		)
		process.exitCode = 1
	}
	console.log(deployed.hostUrl)
	if (deployed.claim !== null) {
		console.log(deployed.claim.url)
		console.log(
			`unclaimed, this artifact is deleted in ${deployed.claim.deadlineMinutes} minutes`,
		)
	}
}
