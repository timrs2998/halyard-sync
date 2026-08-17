import { describe, expect, it } from "vitest";
import {
	createProvider,
	detectProvider,
	GenericProvider,
	normalizeRemoteUrl,
	sshUrlToHttps,
} from "../src/auth/providers";
import type { RequestUrlLike } from "../src/git/http-client";

const noRequest: RequestUrlLike = () => {
	throw new Error("no network expected");
};

describe("normalizeRemoteUrl", () => {
	it("parses a GitHub HTTPS URL and strips .git", () => {
		const parsed = normalizeRemoteUrl("https://github.com/owner/repo.git");
		expect(parsed.host).toBe("github.com");
		expect(parsed.origin).toBe("https://github.com");
		expect(parsed.repoPath).toBe("owner/repo");
	});

	it("parses nested GitLab project paths", () => {
		const parsed = normalizeRemoteUrl("https://gitlab.com/group/sub/project.git");
		expect(parsed.repoPath).toBe("group/sub/project");
	});

	it("keeps a non-standard port in host and origin", () => {
		const parsed = normalizeRemoteUrl("https://git.example.com:8443/o/r.git");
		expect(parsed.host).toBe("git.example.com:8443");
		expect(parsed.origin).toBe("https://git.example.com:8443");
	});

	it("tolerates trailing slashes and whitespace", () => {
		const parsed = normalizeRemoteUrl("  https://github.com/owner/repo/  ");
		expect(parsed.repoPath).toBe("owner/repo");
	});

	it("rejects ssh:// URLs with a pointer to HTTPS", () => {
		expect(() => normalizeRemoteUrl("ssh://git@github.com/owner/repo.git")).toThrow(
			/HTTPS/
		);
	});

	it("rejects scp-style git@ URLs with a pointer to HTTPS", () => {
		expect(() => normalizeRemoteUrl("git@github.com:owner/repo.git")).toThrow(
			/HTTPS/
		);
	});

	it("rejects git:// URLs", () => {
		expect(() => normalizeRemoteUrl("git://github.com/owner/repo.git")).toThrow(
			/HTTPS/
		);
	});

	it("rejects empty input and URLs without a repo path", () => {
		expect(() => normalizeRemoteUrl("   ")).toThrow(/empty/i);
		expect(() => normalizeRemoteUrl("https://github.com/")).toThrow(/path/i);
	});

	it("rejects non-web protocols", () => {
		expect(() => normalizeRemoteUrl("ftp://github.com/owner/repo")).toThrow(
			/protocol/i
		);
	});
});

describe("sshUrlToHttps", () => {
	it("converts scp-style git@host:path", () => {
		expect(sshUrlToHttps("git@github.com:owner/repo.git")).toBe(
			"https://github.com/owner/repo.git"
		);
	});

	it("converts scp-style with a nested path", () => {
		expect(sshUrlToHttps("git@gitlab.example.com:group/sub/project.git")).toBe(
			"https://gitlab.example.com/group/sub/project.git"
		);
	});

	it("converts ssh:// URLs", () => {
		expect(sshUrlToHttps("ssh://git@github.com/owner/repo.git")).toBe(
			"https://github.com/owner/repo.git"
		);
	});

	it("drops a custom SSH port from ssh:// URLs", () => {
		expect(sshUrlToHttps("ssh://git@git.example.com:2222/group/project.git")).toBe(
			"https://git.example.com/group/project.git"
		);
	});

	it("returns null for URLs already HTTPS/HTTP (nothing to convert)", () => {
		expect(sshUrlToHttps("https://github.com/owner/repo.git")).toBeNull();
		expect(sshUrlToHttps("http://git.example.com/owner/repo.git")).toBeNull();
	});

	it("returns null for unrecognized input", () => {
		expect(sshUrlToHttps("not a url at all")).toBeNull();
		expect(sshUrlToHttps("")).toBeNull();
		expect(sshUrlToHttps("git://github.com/owner/repo.git")).toBeNull();
	});
});

describe("detectProvider", () => {
	it("detects github.com", () => {
		expect(detectProvider("https://github.com/o/r.git")).toBe("github");
	});

	it("detects gitlab.com", () => {
		expect(detectProvider("https://gitlab.com/o/r.git")).toBe("gitlab");
	});

	it("detects a user-flagged self-managed GitLab host", () => {
		expect(
			detectProvider("https://git.corp.example/o/r.git", "https://git.corp.example")
		).toBe("gitlab");
	});

	it("accepts a bare host for the self-managed base URL", () => {
		expect(detectProvider("https://git.corp.example/o/r.git", "git.corp.example")).toBe(
			"gitlab"
		);
	});

	it("detects bitbucket.org", () => {
		expect(detectProvider("https://bitbucket.org/ws/r.git")).toBe("bitbucket");
	});

	it("detects dev.azure.com and legacy *.visualstudio.com hosts", () => {
		expect(detectProvider("https://dev.azure.com/org/proj/_git/repo")).toBe(
			"azuredevops"
		);
		expect(detectProvider("https://org.visualstudio.com/proj/_git/repo")).toBe(
			"azuredevops"
		);
	});

	it("detects a user-flagged self-managed Gitea/Forgejo host", () => {
		expect(
			detectProvider(
				"https://git.corp.example/o/r.git",
				undefined,
				"https://git.corp.example"
			)
		).toBe("gitea");
	});

	it("accepts a bare host for the Gitea self-managed base URL", () => {
		expect(
			detectProvider("https://codeberg.org/o/r.git", undefined, "codeberg.org")
		).toBe("gitea");
	});

	it("prefers gitlab over gitea when a host matches both self-managed settings", () => {
		expect(
			detectProvider(
				"https://git.corp.example/o/r.git",
				"git.corp.example",
				"git.corp.example"
			)
		).toBe("gitlab");
	});

	it("falls back to generic for unknown hosts", () => {
		expect(detectProvider("https://codeberg.org/o/r.git")).toBe("generic");
		expect(
			detectProvider("https://codeberg.org/o/r.git", "https://git.corp.example")
		).toBe("generic");
	});
});

describe("createProvider", () => {
	it("builds providers matching detection", () => {
		expect(
			createProvider("https://github.com/o/r.git", { requestUrl: noRequest }).kind
		).toBe("github");
		expect(
			createProvider("https://gitlab.com/o/r.git", { requestUrl: noRequest }).kind
		).toBe("gitlab");
		expect(
			createProvider("https://codeberg.org/o/r.git", { requestUrl: noRequest }).kind
		).toBe("generic");
		expect(
			createProvider("https://bitbucket.org/ws/r.git", { requestUrl: noRequest }).kind
		).toBe("bitbucket");
		expect(
			createProvider("https://dev.azure.com/org/proj/_git/repo", {
				requestUrl: noRequest,
			}).kind
		).toBe("azuredevops");
		expect(
			createProvider("https://codeberg.org/o/r.git", {
				requestUrl: noRequest,
				giteaSelfManagedBase: "codeberg.org",
			}).kind
		).toBe("gitea");
	});

	it("hides device flow when no client ID is configured", () => {
		const github = createProvider("https://github.com/o/r.git", {
			requestUrl: noRequest,
		});
		expect(github.deviceFlowSupported).toBe(false);
		const withId = createProvider("https://github.com/o/r.git", {
			requestUrl: noRequest,
			githubClientId: "abc123",
		});
		expect(withId.deviceFlowSupported).toBe(true);
	});
});

describe("GenericProvider", () => {
	it("degrades PR creation to null", async () => {
		const provider = new GenericProvider();
		await expect(provider.createPullRequest()).resolves.toBeNull();
	});

	it("uses oauth2 as the default token username, configurable", () => {
		expect(new GenericProvider().gitAuth("tok")).toEqual({
			username: "oauth2",
			password: "tok",
		});
		expect(new GenericProvider("token-user").gitAuth("tok")).toEqual({
			username: "token-user",
			password: "tok",
		});
	});

	it("does not support device flow", async () => {
		const provider = new GenericProvider();
		expect(provider.deviceFlowSupported).toBe(false);
		await expect(provider.startDeviceFlow()).rejects.toThrow(/token/i);
	});
});

describe("provider gitAuth usernames", () => {
	it("GitHub uses x-access-token, GitLab uses oauth2", () => {
		const github = createProvider("https://github.com/o/r.git", {
			requestUrl: noRequest,
		});
		expect(github.gitAuth("tok")).toEqual({
			username: "x-access-token",
			password: "tok",
		});
		const gitlab = createProvider("https://gitlab.com/o/r.git", {
			requestUrl: noRequest,
		});
		expect(gitlab.gitAuth("tok")).toEqual({ username: "oauth2", password: "tok" });
	});

	it("Bitbucket uses the static token-auth username", () => {
		const bitbucket = createProvider("https://bitbucket.org/ws/r.git", {
			requestUrl: noRequest,
		});
		expect(bitbucket.gitAuth("tok")).toEqual({
			username: "x-bitbucket-api-token-auth",
			password: "tok",
		});
	});

	it("Gitea/Forgejo puts the token in the username slot", () => {
		const gitea = createProvider("https://codeberg.org/o/r.git", {
			requestUrl: noRequest,
			giteaSelfManagedBase: "codeberg.org",
		});
		expect(gitea.gitAuth("tok")).toEqual({ username: "tok", password: "x-oauth-basic" });
	});

	it("Azure DevOps uses an empty username", () => {
		const azure = createProvider("https://dev.azure.com/org/proj/_git/repo", {
			requestUrl: noRequest,
		});
		expect(azure.gitAuth("tok")).toEqual({ username: "", password: "tok" });
	});
});
