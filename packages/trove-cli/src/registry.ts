// The registry client — one call (§8 step 5). registryUrl arrives as a
// parameter (the CLI wires it from env.ts) so the seam stays explicit.

export interface RegistryRecord {
	canonical: string
	contractCheck: unknown
	hostUrl: string
	id: string
	parent: string | null
	registeredAt: string
	standard: number
}

export async function registerArtifact(
	registryUrl: string,
	id: string,
	hostUrl: string,
): Promise<RegistryRecord> {
	const response = await fetch(new URL("/register", registryUrl), {
		body: JSON.stringify({ hostUrl, id }),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
	const body = (await response.json()) as RegistryRecord & { error?: string }
	if (!response.ok) {
		throw new Error(
			`registration failed (${response.status}): ${body.error ?? JSON.stringify(body)}`,
		)
	}
	return body
}
