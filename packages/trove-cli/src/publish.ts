import { mkdtempSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { checkTrove, httpReader, mintId } from "@usecontextlayer/trove-standard"
import { assembleTrove } from "@/src/assemble"
import { localReader } from "@/src/local-reader"
import { registerTrove } from "@/src/registry"
import { readRemixMarker } from "@/src/remix"
import {
	COMPATIBILITY_DATE,
	deployAssembled,
	detectCredentialState,
	waitUntilServing,
} from "@/src/wrangler"

// Publish (§8): mint the id locally, assemble, check locally, deploy, verify
// the DEPLOYED bytes, register, print. Minting locally is what keeps this to
// one deploy and one registry call.

function describeFailures(report: {
	checks: { detail?: string; name: string; ok: boolean }[]
}): string {
	return report.checks
		.filter((check) => !check.ok)
		.map((check) => `  ${check.name}: ${check.detail ?? "failed"}`)
		.join("\n")
}

// After a redeploy the same URL can serve the PREVIOUS version's bytes for
// minutes with nothing in the response revealing it (measured: 5 of 45
// one-second samples, every one cache-HIT). Registering off stale bytes would
// certify digests visitors don't receive — so the deployed bytes must verify
// against the §6.1 checker before /register is called, with backoff sized to
// the measured minutes-long window.
const STALE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000]

async function verifyDeployed(hostUrl: string, id: string): Promise<void> {
	let lastFailures = ""
	for (const delayMs of [0, ...STALE_RETRY_DELAYS_MS]) {
		if (delayMs > 0) {
			console.error(
				`deployed bytes do not verify yet (propagation can serve stale bytes for minutes) — retrying in ${delayMs / 1000}s`,
			)
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
		const { report } = await checkTrove({ expectedId: id, read: httpReader(hostUrl) })
		if (report.ok) {
			return
		}
		lastFailures = describeFailures(report)
	}
	throw new Error(
		`the deployed trove does not match what was published — refusing to register:\n${lastFailures}`,
	)
}

export async function publish(options: {
	folder: string
	registryUrl: string
}): Promise<void> {
	const { folder, registryUrl } = options

	const id = mintId()
	const marker = readRemixMarker(folder)

	const deployDir = mkdtempSync(path.join(os.tmpdir(), "trove-publish-"))
	const troveDir = path.join(deployDir, "trove")
	assembleTrove({
		destDir: troveDir,
		id,
		...(marker === null
			? {}
			: { parent: marker.parent, parentDigest: marker.parentDigest }),
		sourceDir: folder,
	})

	// §6.1 in the creator position, before anything is public. Assembly makes
	// most checks true by construction; what this really guards is the
	// creator's own content — hidden text outside the block above all.
	const local = await checkTrove({ expectedId: id, read: localReader(troveDir) })
	if (!local.report.ok) {
		throw new Error(
			`the assembled trove fails its own contract checks — nothing was published:\n${describeFailures(local.report)}`,
		)
	}
	// The deploy config sits OUTSIDE the assets directory — wrangler publishes
	// its own scratch files, so the trove is always a subdirectory, never ".".
	// The name derives from the id (DNS-label-safe); the compatibility date is a
	// constant so two publishes of the same trove behave identically.
	writeFileSync(
		path.join(deployDir, "wrangler.jsonc"),
		`${JSON.stringify(
			{
				assets: { directory: "./trove" },
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
	// Announced before deploying: the two modes differ by whether the result is
	// permanent, and nothing else in the output distinguishes them.
	const anonymous = (await detectCredentialState()) === "anonymous"
	console.error(
		anonymous
			? "deploying anonymously — a 60-minute preview, deleted unless claimed"
			: "deploying with your wrangler credentials — this lands a PERMANENT worker in that Cloudflare account",
	)
	const deployed = await deployAssembled({ anonymous, deployDir })

	// Everything after the deploy runs inside a finally that prints the host and
	// claim URLs. The trove is LIVE from here on, so any later failure that
	// swallowed the claim URL would leave the creator holding nothing while an
	// unclaimed deployment evaporates within the hour — the outcome the standard
	// names as the worst first experience. Both awaits below throw, and fetch
	// rejects on a transport blip during exactly the window a fresh anonymous
	// slug may not resolve yet.
	try {
		await waitUntilServing(deployed.hostUrl)
		await verifyDeployed(deployed.hostUrl, id)
		try {
			const record = await registerTrove(registryUrl, id, deployed.hostUrl)
			console.log(`canonical: ${record.canonical}`)
		} catch (error) {
			console.error(
				`registration failed — the trove is live but unregistered: ${String(error)}`,
			)
			process.exitCode = 1
		}
	} finally {
		// Labelled: unlabelled bare URLs let a caller take the first line as
		// "the trove's URL", and on the registration-failure path that first
		// line is the HOST url — the one the remix skill says never to pass on.
		console.log(`host: ${deployed.hostUrl}`)
		if (deployed.claim !== null) {
			console.log(`claim: ${deployed.claim.url}`)
			console.log(
				`unclaimed, this trove is deleted in ${deployed.claim.deadlineMinutes} minutes`,
			)
		}
	}
}
