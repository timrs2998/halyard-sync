import { describe, expect, it } from "vitest";
import { effectiveIgnoreGlobs, findExcludingPatterns } from "../src/sync/ignore-claims";

describe("managed ignore claims", () => {
	it("unions and deduplicates user and managed patterns", () => {
		expect(effectiveIgnoreGlobs(
			["notes/", "Sources/ledger/"],
			{
				"fetch:ledger": { label: "Ledger", patterns: ["Sources/ledger/", "cache/"] },
			}
		)).toEqual(["notes/", "Sources/ledger/", "cache/"]);
	});

	it("reports broader and wildcard blockers without treating unrelated paths as blockers", () => {
		expect(findExcludingPatterns(
			["Sources/ledger/"],
			["Sources/", "*.tmp"],
			["other/", "Sources/patient-portal/"]
		)).toEqual(["Sources/"]);
	});

	it("supports exact and backslash-normalized legacy patterns", () => {
		expect(findExcludingPatterns(
			["Sources/ledger/"],
			["./Sources/ledger/", "Sources\\ledger\\"],
			[]
		)).toEqual(["./Sources/ledger/", "Sources\\ledger\\"]);
	});
});
