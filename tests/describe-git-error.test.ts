import { describe, expect, it } from "vitest";
import { describeGitError } from "../src/git/engine";
import { Libgit2Error } from "../src/git/libgit2/binding";

describe("describeGitError", () => {
	it("recognizes a Libgit2Error whose message mentions 401/403/unauthorized/forbidden as an auth failure", () => {
		for (const message of [
			"fetch: unexpected http status code: 401",
			"push failed: 403 Forbidden",
			"remote returned: Unauthorized",
			"authentication required",
		]) {
			expect(describeGitError(new Libgit2Error(message, -1))).toBe(
				"Authentication failed — check your token has the right scope and hasn't expired."
			);
		}
	});

	it("recognizes a Libgit2Error whose message mentions 404/not found as repository-not-found", () => {
		expect(describeGitError(new Libgit2Error("unexpected http status code: 404", -1))).toBe(
			"Repository not found — check the URL and that your token has access."
		);
		expect(describeGitError(new Libgit2Error("repository not found", -1))).toBe(
			"Repository not found — check the URL and that your token has access."
		);
	});

	it("recognizes libgit2's raw 'unsupported URL protocol' as an SSH-remote misconfiguration", () => {
		const err = new Libgit2Error(
			"listRemoteRefs(git@github.com:owner/repo.git): unsupported URL protocol",
			-1
		);
		expect(describeGitError(err)).toBe(
			"This repository's remote is configured for SSH, which Halyard Sync " +
				"can't use (no SSH transport on mobile) — open the setup wizard and " +
				"re-enter the HTTPS URL to fix it."
		);
	});

	it("falls back to the raw message for an unrecognized Libgit2Error", () => {
		const err = new Libgit2Error("git_merge_base: no common ancestor", -3);
		expect(describeGitError(err)).toBe("git_merge_base: no common ancestor");
	});

	it("recognizes network-shaped plain Errors thrown by requestUrl", () => {
		expect(describeGitError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(
			"Network error — check your connection and try again."
		);
		expect(describeGitError(new Error("Failed to fetch"))).toBe(
			"Network error — check your connection and try again."
		);
		expect(describeGitError(new Error("getaddrinfo ENOTFOUND example.com"))).toBe(
			"Network error — check your connection and try again."
		);
		expect(describeGitError(new Error("request timed out"))).toBe(
			"Network error — check your connection and try again."
		);
	});

	it("falls back to the raw message for anything unrecognized", () => {
		expect(describeGitError(new Error("something else entirely"))).toBe(
			"something else entirely"
		);
		expect(describeGitError("plain string")).toBe("plain string");
	});
});
