/**
 * The three PAT-only concrete `ForgeProvider`s (Bitbucket, Gitea/Forgejo,
 * Azure DevOps) — no device flow exists for any of them (see DESIGN.md's
 * "Auth" section). The two device-flow-capable providers (GitHub, GitLab)
 * are covered separately in `device-flow.test.ts`; the shared provider
 * abstraction itself (URL parsing/detection, `createProvider`,
 * `GenericProvider`) is in `providers.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { parseAzureDevOpsRemote, AzureDevOpsProvider } from "../src/auth/azuredevops";
import { BitbucketProvider } from "../src/auth/bitbucket";
import { GiteaProvider } from "../src/auth/gitea";
import type {
	RequestUrlLikeParam,
	RequestUrlLikeResponse,
} from "../src/git/http-client";

function jsonBody(value: unknown): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
}

/** Scripted requestUrl mock: pops one response per call, records requests. */
function scriptedRequests(
	responses: Array<{ status?: number; json: unknown }>
): {
	calls: RequestUrlLikeParam[];
	requestUrl: (param: RequestUrlLikeParam) => Promise<RequestUrlLikeResponse>;
} {
	const calls: RequestUrlLikeParam[] = [];
	return {
		calls,
		requestUrl: async (param) => {
			calls.push(param);
			const next = responses.shift();
			if (next === undefined) throw new Error("mock ran out of responses");
			return {
				status: next.status ?? 200,
				headers: {},
				arrayBuffer: jsonBody(next.json),
			};
		},
	};
}

const PR_PARAMS = {
	repoPath: "ws/repo",
	sourceBranch: "sync-conflict/desk-20260719",
	targetBranch: "main",
	title: "t",
	body: "b",
};

describe("BitbucketProvider", () => {
	it("does not support device flow", async () => {
		const provider = new BitbucketProvider({ requestUrl: scriptedRequests([]).requestUrl });
		expect(provider.deviceFlowSupported).toBe(false);
		await expect(provider.startDeviceFlow()).rejects.toThrow(/personal access token/i);
		await expect(provider.pollDeviceFlow()).rejects.toThrow(/personal access token/i);
	});

	it("uses the static x-bitbucket-api-token-auth username for git auth", () => {
		const provider = new BitbucketProvider({ requestUrl: scriptedRequests([]).requestUrl });
		expect(provider.gitAuth("tok")).toEqual({
			username: "x-bitbucket-api-token-auth",
			password: "tok",
		});
	});

	it("refuses to create a pull request without an account email configured", async () => {
		const provider = new BitbucketProvider({ requestUrl: scriptedRequests([]).requestUrl });
		await expect(provider.createPullRequest(PR_PARAMS, "tok")).rejects.toThrow(
			/account email/i
		);
	});

	it("creates a pull request via Basic auth (email:token) and the documented body shape", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{
				status: 201,
				json: { links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/7" } } },
			},
		]);
		const provider = new BitbucketProvider({
			requestUrl,
			accountEmail: "me@example.com",
		});
		const pr = await provider.createPullRequest(PR_PARAMS, "tok");

		expect(pr).toEqual({ url: "https://bitbucket.org/ws/repo/pull-requests/7" });
		expect(calls[0].url).toBe(
			"https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests"
		);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers?.["Authorization"]).toBe(
			`Basic ${btoa("me@example.com:tok")}`
		);
		expect(JSON.parse(calls[0].body as string)).toEqual({
			title: "t",
			description: "b",
			source: { branch: { name: "sync-conflict/desk-20260719" } },
			destination: { branch: { name: "main" } },
		});
	});

	it("surfaces the nested error.message shape on failure", async () => {
		const { requestUrl } = scriptedRequests([
			{ status: 400, json: { error: { message: "source and destination branches are equal" } } },
		]);
		const provider = new BitbucketProvider({
			requestUrl,
			accountEmail: "me@example.com",
		});
		await expect(provider.createPullRequest(PR_PARAMS, "tok")).rejects.toThrow(
			/source and destination branches are equal/
		);
	});
});

describe("GiteaProvider", () => {
	it("does not support device flow", async () => {
		const provider = new GiteaProvider({
			requestUrl: scriptedRequests([]).requestUrl,
			baseUrl: "https://codeberg.org",
		});
		expect(provider.deviceFlowSupported).toBe(false);
		await expect(provider.startDeviceFlow()).rejects.toThrow(/access token/i);
		await expect(provider.pollDeviceFlow()).rejects.toThrow(/access token/i);
	});

	it("puts the token in the username slot for git auth (x-oauth-basic password)", () => {
		const provider = new GiteaProvider({
			requestUrl: scriptedRequests([]).requestUrl,
			baseUrl: "https://codeberg.org",
		});
		expect(provider.gitAuth("tok")).toEqual({ username: "tok", password: "x-oauth-basic" });
	});

	it("creates a pull request against the self-managed base URL with an Authorization: token header", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{ status: 201, json: { html_url: "https://codeberg.org/o/r/pulls/3" } },
		]);
		const provider = new GiteaProvider({
			requestUrl,
			baseUrl: "https://codeberg.org/",
		});
		const pr = await provider.createPullRequest(
			{ ...PR_PARAMS, repoPath: "o/r" },
			"tok"
		);

		expect(pr).toEqual({ url: "https://codeberg.org/o/r/pulls/3" });
		expect(calls[0].url).toBe("https://codeberg.org/api/v1/repos/o/r/pulls");
		expect(calls[0].headers?.["Authorization"]).toBe("token tok");
		expect(JSON.parse(calls[0].body as string)).toEqual({
			title: "t",
			body: "b",
			head: "sync-conflict/desk-20260719",
			base: "main",
		});
	});

	it("throws with API details when PR creation fails", async () => {
		const { requestUrl } = scriptedRequests([
			{ status: 422, json: { message: "branch does not exist" } },
		]);
		const provider = new GiteaProvider({ requestUrl, baseUrl: "https://gitea.example.com" });
		await expect(
			provider.createPullRequest({ ...PR_PARAMS, repoPath: "o/r" }, "tok")
		).rejects.toThrow(/422.*branch does not exist/);
	});
});

describe("parseAzureDevOpsRemote", () => {
	it("parses the modern dev.azure.com form", () => {
		expect(parseAzureDevOpsRemote("https://dev.azure.com/fabrikam/2016_10_31/_git/repo")).toEqual({
			organization: "fabrikam",
			project: "2016_10_31",
			repository: "repo",
		});
	});

	it("parses the legacy *.visualstudio.com form", () => {
		expect(
			parseAzureDevOpsRemote("https://fabrikam.visualstudio.com/2016_10_31/_git/repo")
		).toEqual({
			organization: "fabrikam",
			project: "2016_10_31",
			repository: "repo",
		});
	});

	it("decodes URL-encoded project/repo segments", () => {
		expect(
			parseAzureDevOpsRemote("https://dev.azure.com/org/My%20Project/_git/My%20Repo")
		).toEqual({
			organization: "org",
			project: "My Project",
			repository: "My Repo",
		});
	});

	it("rejects URLs without a /_git/ segment", () => {
		expect(() => parseAzureDevOpsRemote("https://dev.azure.com/org/project")).toThrow(
			/_git/
		);
	});

	it("rejects a dev.azure.com URL missing the project segment", () => {
		expect(() => parseAzureDevOpsRemote("https://dev.azure.com/_git/repo")).toThrow(
			/Azure DevOps/
		);
	});
});

describe("AzureDevOpsProvider", () => {
	it("does not support device flow", async () => {
		const provider = new AzureDevOpsProvider({
			requestUrl: scriptedRequests([]).requestUrl,
			remoteUrl: "https://dev.azure.com/org/proj/_git/repo",
		});
		expect(provider.deviceFlowSupported).toBe(false);
		await expect(provider.startDeviceFlow()).rejects.toThrow(/personal access token/i);
		await expect(provider.pollDeviceFlow()).rejects.toThrow(/personal access token/i);
	});

	it("uses an empty username with the PAT as password", () => {
		const provider = new AzureDevOpsProvider({
			requestUrl: scriptedRequests([]).requestUrl,
			remoteUrl: "https://dev.azure.com/org/proj/_git/repo",
		});
		expect(provider.gitAuth("tok")).toEqual({ username: "", password: "tok" });
	});

	it("throws immediately when constructed from a non-Azure-DevOps-shaped remote", () => {
		expect(
			() =>
				new AzureDevOpsProvider({
					requestUrl: scriptedRequests([]).requestUrl,
					remoteUrl: "https://github.com/o/r.git",
				})
		).toThrow(/_git/);
	});

	it("resolves the repository GUID before creating the pull request, then builds the web URL itself", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{ status: 200, json: { id: "3411ebc1-d5aa-464f-9615-0b527bc66719" } },
			{ status: 200, json: { pullRequestId: 22 } },
		]);
		const provider = new AzureDevOpsProvider({
			requestUrl,
			remoteUrl: "https://dev.azure.com/fabrikam/2016_10_31/_git/repo",
		});
		const pr = await provider.createPullRequest(
			{
				repoPath: "unused",
				sourceBranch: "sync-conflict/desk-20260719",
				targetBranch: "main",
				title: "t",
				body: "b",
			},
			"my-pat"
		);

		expect(calls).toHaveLength(2);
		// Lookup call.
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toBe(
			"https://dev.azure.com/fabrikam/2016_10_31/_apis/git/repositories/repo?api-version=7.1"
		);
		expect(calls[0].headers?.["Authorization"]).toBe(`Basic ${btoa(":my-pat")}`);

		// Create call, addressed by the resolved GUID, no project segment.
		expect(calls[1].method).toBe("POST");
		expect(calls[1].url).toBe(
			"https://dev.azure.com/fabrikam/_apis/git/repositories/" +
				"3411ebc1-d5aa-464f-9615-0b527bc66719/pullrequests?api-version=7.1"
		);
		expect(JSON.parse(calls[1].body as string)).toEqual({
			sourceRefName: "refs/heads/sync-conflict/desk-20260719",
			targetRefName: "refs/heads/main",
			title: "t",
			description: "b",
		});

		expect(pr).toEqual({
			url: "https://dev.azure.com/fabrikam/2016_10_31/_git/repo/pullrequest/22",
		});
	});

	it("throws without attempting PR creation when the repository lookup fails", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{ status: 404, json: { message: "repository not found" } },
		]);
		const provider = new AzureDevOpsProvider({
			requestUrl,
			remoteUrl: "https://dev.azure.com/fabrikam/proj/_git/repo",
		});
		await expect(
			provider.createPullRequest(
				{ repoPath: "x", sourceBranch: "s", targetBranch: "m", title: "t", body: "" },
				"pat"
			)
		).rejects.toThrow(/repository not found/);
		expect(calls).toHaveLength(1);
	});
});
