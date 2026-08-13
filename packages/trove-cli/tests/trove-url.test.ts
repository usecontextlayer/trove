import { describe, expect, it } from "vitest"
import { parseTroveUrl } from "@/src/trove-url"

// One boundary for the three commands that take a trove's URL. These cases were
// previously duplicated across remix's and register's suites, which is how the
// two implementations drifted apart in their messages while agreeing on their
// rules — the duplication in the tests was the tell.

const REGISTRY = "https://trove.usecontextlayer.com"

function parse(from: string): string {
	return parseTroveUrl({ command: "trove verify", from, registryUrl: REGISTRY })
}

describe("parseTroveUrl", () => {
	it("normalizes a trove's own URL to its origin", () => {
		expect(parse("https://trove-abc.some-account.workers.dev/")).toBe(
			"https://trove-abc.some-account.workers.dev",
		)
	})

	// The two URL-taking commands take different URLs, so an agent will
	// eventually hand each the other's. A registry URL 302s to a trove and has
	// no subtree, so every path built under it 404s.
	it("rejects a registry URL, naming both places the right one is published", () => {
		const attempt = () => parse(`${REGISTRY}/a/0123456789abcdefghjkmnpq`)
		expect(attempt).toThrow(/registry URL, not a trove/)
		expect(attempt).toThrow(/"trove:" line/)
		expect(attempt).toThrow(/hostUrl/)
	})

	it("names the command that was actually run", () => {
		// The rules are shared; the sentence is the caller's, so a reader is told
		// about the command they typed rather than about some other one.
		expect(() =>
			parseTroveUrl({ command: "trove remix", from: "nope", registryUrl: REGISTRY }),
		).toThrow(/trove remix/)
		expect(() =>
			parseTroveUrl({ command: "trove register", from: "nope", registryUrl: REGISTRY }),
		).toThrow(/trove register/)
	})

	it("rejects something that is not a URL", () => {
		expect(() => parse("trove-abc.workers.dev")).toThrow(/not a URL/)
	})

	// §2.1: troves live at a host root. A URL carrying a path parses fine and
	// then resolves every manifest entry against the wrong base, so it is
	// refused rather than normalized away — silently dropping the path would act
	// on a URL the caller never passed.
	it.each([
		["a path", "https://trove-abc.some-account.workers.dev/sub/path"],
		["a query", "https://trove-abc.some-account.workers.dev/?a=1"],
		["a fragment", "https://trove-abc.some-account.workers.dev/#x"],
	])(
		"rejects a trove URL carrying %s, naming the URL that would work",
		(_label, given) => {
			expect(() => parse(given)).toThrow(/host root/)
			expect(() => parse(given)).toThrow(
				/https:\/\/trove-abc\.some-account\.workers\.dev/,
			)
		},
	)
})
