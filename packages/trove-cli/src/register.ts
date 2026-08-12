import {
	MANIFEST_PATH,
	manifestSchema,
	recordUrlForId,
} from "@usecontextlayer/trove-standard"
import { registerTrove } from "@/src/registry"
import { describeFailures, summarizeReport } from "@/src/report"

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

/**
 * Normalize to an origin, and refuse the two arguments that are not one.
 *
 * A registry URL is the predictable confusion: `register` and `remix` both take
 * a trove's own URL, and the registry publishes that URL inside a record, so an
 * agent that read the record and took the wrong field arrives here.
 *
 * The root requirement is enforced (§2.1) rather than normalized away, because
 * silently discarding a path means acting on a URL the caller did not pass.
 * Which HOSTS are acceptable — https, `*.workers.dev` — is deliberately NOT
 * re-checked here: the registry owns that rule, and re-encoding it in a second
 * place is how the two drift apart.
 */
export function parseHostUrl(registryUrl: string, hostUrl: string): string {
	let url: URL
	try {
		url = new URL(hostUrl)
	} catch {
		throw new Error(
			`"${hostUrl}" is not a URL. trove register takes the trove's URL — the "trove:" line publish printed.`,
		)
	}
	if (url.origin === new URL(registryUrl).origin) {
		throw new Error(
			`${hostUrl} is a Trove registry URL, not a trove. trove register takes the trove's own URL — the "trove:" line publish printed.`,
		)
	}
	// §2.1, same rule the remix boundary enforces: a trove is served at a host
	// root. Silently returning the origin would accept a wrong argument and act
	// on a different one.
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		throw new Error(
			`${hostUrl} carries a path, query, or fragment. A trove is served at a host root, so its URL is just the origin — try ${url.origin}.`,
		)
	}
	return url.origin
}

export async function register(options: {
	hostUrl: string
	registryUrl: string
}): Promise<void> {
	const { hostUrl, registryUrl } = options

	// The trove states its own identity, so the id is read from the deployment
	// rather than carried by the caller.
	const manifestUrl = new URL(hostUrl)
	manifestUrl.pathname = MANIFEST_PATH
	const response = await fetch(manifestUrl)
	if (!response.ok) {
		throw new Error(
			`${manifestUrl.href} answered ${response.status} — there is no trove to register at ${hostUrl}. Publish it first.`,
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

	// The trove's URL is repeated here on purpose: it is the thing to share, it
	// was printed by a different command, and this is the moment a creator is
	// looking for something to hand over.
	console.log(`trove: ${hostUrl}`)
	console.log(`record: ${recordUrlForId(parsed.data.id)}`)
	console.log(`checks: ${summarizeReport(record.contractCheck)}`)
	// A trove that fails its checks is still RECORDED (§7: identity gates
	// registration, conformance does not) — but it must never read as success.
	// The stored verdict is the entire signal, and it is published verbatim.
	if (!record.contractCheck.ok) {
		console.error(
			`this trove FAILED its contract checks. It is registered — the registry publishes this verdict at ${recordUrlForId(parsed.data.id)} — but it does not conform:\n${describeFailures(record.contractCheck)}`,
		)
		process.exitCode = 1
	}
}
