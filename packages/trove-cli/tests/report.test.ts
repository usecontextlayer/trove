import type { ContractCheckReport } from "@usecontextlayer/trove-standard"
import { describe, expect, it } from "vitest"
import { describeChecks, describeFailures } from "@/src/report"

// The two renderers answer different questions and the difference is the whole
// reason both exist: publish and register speak only when something is wrong,
// while `trove dev` is asked "is this ready", which only the passing checks can
// answer.

const mixedReport: ContractCheckReport = {
	checks: [
		{ name: "mandated-block", status: "ok" },
		{
			detail: "no hidden text is allowed outside the block",
			name: "anti-cloaking",
			status: "failed",
		},
		{
			detail: "this position does not verify manifest files",
			name: "files",
			status: "not-checked",
		},
	],
	ok: false,
}

describe("describeChecks", () => {
	it("renders every check, not only the failures", () => {
		const rendered = describeChecks(mixedReport)

		expect(rendered).toContain("mandated-block")
		expect(rendered).toContain("anti-cloaking")
		expect(rendered).toContain("files")
	})

	it("distinguishes the three verdicts, so a passing check never reads like a skipped one", () => {
		const lines = describeChecks(mixedReport).split("\n")

		expect(lines[0]).toContain("ok")
		expect(lines[1]).toContain("FAIL")
		expect(lines[2]).toContain("----")
		expect(lines[2]).not.toContain("ok")
	})

	it("carries each check's detail, which is the part that says what to fix", () => {
		expect(describeChecks(mixedReport)).toContain(
			"no hidden text is allowed outside the block",
		)
	})

	it("renders a wholly passing report without inventing a failure", () => {
		const rendered = describeChecks({
			checks: [{ name: "manifest", status: "ok" }],
			ok: true,
		})

		expect(rendered).toContain("manifest")
		expect(rendered).not.toContain("FAIL")
	})
})

describe("describeFailures", () => {
	it("reports only what failed, unlike describeChecks", () => {
		const rendered = describeFailures(mixedReport)

		expect(rendered).toContain("anti-cloaking")
		expect(rendered).not.toContain("mandated-block")
		expect(rendered).not.toContain("files")
	})
})
