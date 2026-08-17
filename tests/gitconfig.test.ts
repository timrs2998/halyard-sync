import { describe, expect, it } from "vitest";
import { parseGitConfigRemoteUrl } from "../src/git/gitconfig";

const REAL_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = true
[remote "origin"]
\turl = git@github.com:owner/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\tmerge = refs/heads/main
`;

describe("parseGitConfigRemoteUrl", () => {
	it("extracts a remote's url from a realistic config file", () => {
		expect(parseGitConfigRemoteUrl(REAL_CONFIG, "origin")).toBe(
			"git@github.com:owner/repo.git"
		);
	});

	it("returns null for a remote name that isn't configured", () => {
		expect(parseGitConfigRemoteUrl(REAL_CONFIG, "upstream")).toBeNull();
	});

	it("returns null when there is no matching [remote] section at all", () => {
		expect(parseGitConfigRemoteUrl("[core]\n\tbare = false\n", "origin")).toBeNull();
	});

	it("distinguishes between multiple remotes", () => {
		const multi = `[remote "origin"]
\turl = https://github.com/owner/repo.git
[remote "upstream"]
\turl = https://github.com/other/repo.git
`;
		expect(parseGitConfigRemoteUrl(multi, "origin")).toBe("https://github.com/owner/repo.git");
		expect(parseGitConfigRemoteUrl(multi, "upstream")).toBe("https://github.com/other/repo.git");
	});

	it("tolerates CRLF line endings", () => {
		const crlf = REAL_CONFIG.replace(/\n/g, "\r\n");
		expect(parseGitConfigRemoteUrl(crlf, "origin")).toBe("git@github.com:owner/repo.git");
	});

	it("does not leak a url line from a later, unrelated section", () => {
		const trailingSection = `[remote "origin"]
\tfetch = +refs/heads/*:refs/remotes/origin/*
[core]
\turl = not-a-remote-url
`;
		expect(parseGitConfigRemoteUrl(trailingSection, "origin")).toBeNull();
	});
});
