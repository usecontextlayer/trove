// The artifact id grammar, from §3 of the standard: 24 characters of lowercase
// Crockford base32. Crockford excludes `i`, `l`, `o` and `u`, so an id can be
// read aloud or transcribed without ambiguity. 24 characters is 120 bits.
const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

export const ID_LENGTH = 24

export const ID_PATTERN = /^[0-9a-hj-km-np-tv-z]{24}$/

export function isWellFormedId(id: string): boolean {
	return ID_PATTERN.test(id)
}

export function assertWellFormedId(id: string): void {
	if (!isWellFormedId(id)) {
		throw new Error(
			`Malformed artifact id ${JSON.stringify(id)}: expected ${ID_LENGTH} characters of lowercase Crockford base32 (${ID_PATTERN})`,
		)
	}
}

/**
 * Mint a fresh artifact id. `byte & 31` maps uniformly onto the 32-character
 * alphabet (256 = 8 × 32). Uses `globalThis.crypto`, present in Node ≥ 20,
 * workerd, and browsers, so minting works in every position the standard's
 * tooling runs in.
 */
export function mintId(): string {
	const bytes = new Uint8Array(ID_LENGTH)
	globalThis.crypto.getRandomValues(bytes)
	let id = ""
	for (const byte of bytes) {
		id += CROCKFORD_ALPHABET[byte & 31]
	}
	return id
}
