import {
	MANIFEST_PATH,
	manifestSchema,
	recordUrlForId,
} from "@usecontextlayer/trove-standard"
import { registerTrove } from "@/src/registry"
import { describeFailures, summarizeReport } from "@/src/report"
import { fetchWhileSettling } from "@/src/serving"

// Registering (§8) — a separate command from publishing, and neither does the
// other. Publishing gets the bytes live and the trove is readable from that
// moment on, by anyone, with no involvement from us. Registering is what binds
// the id to that host and publishes an independent verdict about it.
//
// So registration is REQUIRED of a creator and OPTIONAL to a reader, and those
// are different things. What it buys is not access — it is the three things a
// trove cannot establish about itself: that nobody else can claim its id, that
// its conformance was observed by someone other than its author, and that a
// remix naming it as parent can be corroborated.
//
// The only argument is the trove's URL, because the trove carries its own id in
// the manifest it serves (§7): reading the id from the deployment is the same
// act that proves control of it, so there is nothing to carry between the two
// commands.

export async function register(options: {
	hostUrl: string
	registryUrl: string
}): Promise<void> {
	const { hostUrl, registryUrl } = options

	// The trove states its own identity, so the id is read from the deployment
	// rather than carried by the caller.
	const manifestUrl = new URL(hostUrl)
	manifestUrl.pathname = MANIFEST_PATH

	// Wait the same window `publish` waits. Propagation is per-asset and not
	// atomic, and a fresh preview flaps rather than simply coming up, so this
	// path can 404 seconds after the root served — measured, `publish` polled
	// through exactly that window and succeeded while `register`, run SIX
	// SECONDS later, answered "there is no trove to register … Publish it
	// first."
	//
	// The old message is the reason this is worth fixing rather than rewording.
	// Republishing mints a fresh id, a fresh host and a fresh 60-minute clock
	// and orphans the deployment that is already live, so the advice was not
	// merely wrong about the cause — it recommended the one destructive action
	// available. The agent that met it only avoided that by probing the URL by
	// hand and disbelieving the tool.
	let response: Response
	try {
		response = await fetchWhileSettling(manifestUrl)
	} catch (error) {
		throw new Error(
			`nothing is serving a trove at ${hostUrl}. If you just published it, propagation may still be settling — wait a minute and run this again; do NOT republish, which would mint a new id and orphan the trove that is already live. If you have not published it yet, publish it first.\n${String(error)}`,
		)
	}
	// safeParse, not parse: a bare ZodError reaches the caller as a JSON dump of
	// issue objects that never says which URL was read or what it should have
	// been — and the likeliest way to arrive here is pointing this command at
	// something that is not a trove at all.
	const parsed = manifestSchema.safeParse(await response.json())
	if (!parsed.success) {
		const why = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ")
		throw new Error(
			`${manifestUrl.href} did not parse as a trove manifest, so there is nothing to register here — ${why}`,
		)
	}

	const record = await registerTrove(registryUrl, parsed.data.id, hostUrl)

	// Derived from the registry that was actually written to, so the URL printed
	// always names the record this call just created.
	const recordUrl = recordUrlForId(registryUrl, parsed.data.id)

	// The trove's URL is repeated here on purpose: it is the thing to share, it
	// was printed by a different command, and this is the moment a creator is
	// looking for something to hand over.
	console.log(`trove: ${hostUrl}`)
	console.log(`record: ${recordUrl}`)
	console.log(`checks: ${summarizeReport(record.contractCheck)}`)
	// A trove that fails its checks is still RECORDED (§7: identity gates
	// registration, conformance does not) — but it must never read as success.
	// The stored verdict is the entire signal, and it is published verbatim.
	if (!record.contractCheck.ok) {
		console.error(
			`this trove FAILED its contract checks. It is registered — the registry publishes this verdict at ${recordUrl} — but it does not conform:\n${describeFailures(record.contractCheck)}`,
		)
		process.exitCode = 1
	}
}
