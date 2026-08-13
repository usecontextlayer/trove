import { mkdtempSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { checkTrove, httpReader, mintId } from "@usecontextlayer/trove-standard"
import { assembleTrove } from "@/src/assemble"
import { localReader } from "@/src/local-reader"
import { readRemixMarker } from "@/src/remix"
import { describeFailures } from "@/src/report"
import {
	deployAssembled,
	detectCredentialState,
	waitUntilServing,
	writeWranglerConfig,
} from "@/src/wrangler"

// Publish (§8): mint the id locally, assemble, check locally, deploy, verify
// the DEPLOYED bytes, print. Registering is a SEPARATE command and this one
// never runs it — publishing gets bytes live, registering gets them certified,
// and they answer different questions.
//
// The URL this prints is the trove's only URL and is readable immediately, by
// anyone, with no involvement from Trove. That is the whole point of the
// design: our infrastructure is not on the path that reads someone else's
// static files. Registering adds a verdict and an id binding on top; it does
// not grant access, and nothing here waits for it.

// After a redeploy the same URL can serve the PREVIOUS version's bytes for
// minutes with nothing in the response revealing it (measured: 5 of 45
// one-second samples, every one cache-HIT). Registering off stale bytes would
// certify digests visitors don't receive — so the deployed bytes must verify
// against the §6.1 checker before the trove is handed over, with backoff sized
// to the measured minutes-long window.
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
			// Announced, not silent. Without a verdict line a caller cannot tell
			// whether verification succeeded, was abandoned, or never ran — and
			// a reader of the retry lines above reasonably concludes the step
			// timed out when it did not.
			console.error("deployed bytes verified against the manifest")
			return
		}
		lastFailures = describeFailures(report)
	}
	throw new Error(
		`the deployed trove does not match what was published:\n${lastFailures}`,
	)
}

/**
 * The claim expiry as a WALL CLOCK, which is what a creator can act on — a bare
 * duration makes them do arithmetic against a clock they cannot see from here.
 * Measured cost of getting this wrong: a naive agent read the docs' promise of
 * a "deadline", found a duration, converted it by hand with a `date` invocation
 * whose adjustment flag did nothing, and published the unchanged echo as a
 * measured expiry time — in bold, twice. The tool holds the only clock that
 * knows when the deploy actually happened, so it is the tool that must do this.
 *
 * The duration stays alongside it: it is the part that says how much room is
 * left, and the timestamp is the part that says when. `now` is a parameter
 * because the moment is the caller's to supply, which also makes the arithmetic
 * checkable without one.
 */
export function claimDeadlineLine(deadlineMinutes: number, now: Date): string {
	const deadline = new Date(now.getTime() + deadlineMinutes * 60_000)
	// Explicit components, not dateStyle/timeStyle: those cannot be combined with
	// timeZoneName (ECMA-402 rejects the pair outright), and the zone is the part
	// that makes a wall clock unambiguous to whoever reads it.
	const when = deadline.toLocaleString(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
		timeZoneName: "short",
	})
	return `unclaimed, this trove is deleted at ${when} — ${deadlineMinutes} minutes from now`
}

// Publishing takes no registryUrl: with registration split out, this command
// makes no request to the registry at all.
export async function publish(options: { folder: string }): Promise<void> {
	const { folder } = options

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
	console.error("contract checks passed on the assembled trove")

	writeWranglerConfig({ deployDir, id })

	// §6.2's security scans (Betterleaks, anti-trojan-source) are not wired yet.
	// Stated on every publish rather than silently skipped: certification must
	// never claim more than what ran.
	console.error(
		"note: local security scans are not wired yet (betterleaks, anti-trojan-source) — this is about the tool, not your content",
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
	// claim URLs and the command that registers the trove. The trove is LIVE
	// from here on, so any later failure that swallowed those would leave the
	// creator holding nothing while an unclaimed deployment evaporates within
	// the hour — the outcome the standard names as the worst first experience.
	// Both awaits below throw, and fetch rejects on a transport blip during
	// exactly the window a fresh anonymous slug may not resolve yet.
	try {
		await waitUntilServing(deployed.hostUrl)
		await verifyDeployed(deployed.hostUrl, id)
	} finally {
		// Labelled, because two URLs and an id go out together and an unlabelled
		// line invites a caller to share whichever came first.
		console.log(`id: ${id}`)
		console.log(`trove: ${deployed.hostUrl}`)
		if (deployed.claim !== null) {
			console.log(`claim: ${deployed.claim.url}`)
			console.log(claimDeadlineLine(deployed.claim.deadlineMinutes, new Date()))
		}
		// The trove is readable already; what is missing is the id binding and an
		// independent verdict. Naming the exact command AND what it buys is what
		// keeps a required step from reading like an optional one.
		console.log(
			"next: register it — this claims the id so nobody else can, and publishes a verdict a reader can check:",
		)
		console.log(`  npx @usecontextlayer/trove register ${deployed.hostUrl}`)
	}
}
