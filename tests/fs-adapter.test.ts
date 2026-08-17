import { describe, expect, it } from "vitest";
import { toAdapterPath } from "../src/git/fs-adapter";

describe("toAdapterPath", () => {
	it("strips leading slashes", () => {
		expect(toAdapterPath("/.git/config")).toBe(".git/config");
	});

	it("converts backslashes to forward slashes", () => {
		expect(toAdapterPath("\\notes\\daily\\a.md")).toBe("notes/daily/a.md");
	});

	it("collapses duplicate slashes and dot segments", () => {
		expect(toAdapterPath("//a//./b/../c/")).toBe("a/c");
	});

	it("maps root spellings to '/'", () => {
		expect(toAdapterPath("")).toBe("/");
		expect(toAdapterPath(".")).toBe("/");
		expect(toAdapterPath("/")).toBe("/");
		expect(toAdapterPath("./")).toBe("/");
	});
});
