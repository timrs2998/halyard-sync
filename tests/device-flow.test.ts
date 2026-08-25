import { describe, expect, it } from "vitest";
import { GitHubProvider } from "../src/auth/github";
import { GitLabProvider } from "../src/auth/gitlab";
import type {
	RequestUrlLikeParam,
	RequestUrlLikeResponse,
} from "../src/git/http-client";

function jsonBody(value: unknown): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify(value)).buffer;
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

const START_JSON = {
	device_code: "dev-123",
	user_code: "ABCD-1234",
	verification_uri: "https://github.com/login/device",
	expires_in: 900,
	interval: 5,
};

describe("GitHub device flow", () => {
	it("starts the flow with client_id and scope repo", async () => {
		const { calls, requestUrl } = scriptedRequests([{ json: START_JSON }]);
		const provider = new GitHubProvider({ requestUrl, clientId: "cid" });
		const start = await provider.startDeviceFlow();

		expect(calls[0].url).toBe("https://github.com/login/device/code");
		expect(calls[0].method).toBe("POST");
		const form = new URLSearchParams(calls[0].body as string);
		expect(form.get("client_id")).toBe("cid");
		expect(form.get("scope")).toBe("repo");
		expect(start).toEqual({
			deviceCode: "dev-123",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresIn: 900,
			interval: 5,
		});
	});

	it("refuses to start without a client ID", async () => {
		const { requestUrl } = scriptedRequests([]);
		const provider = new GitHubProvider({ requestUrl, clientId: "" });
		expect(provider.deviceFlowSupported).toBe(false);
		await expect(provider.startDeviceFlow()).rejects.toThrow(/client ID/i);
	});

	it("polls pending -> slow_down -> success, growing the interval by 5s", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{ json: { error: "authorization_pending" } },
			{ json: { error: "slow_down" } },
			{ json: { error: "authorization_pending" } },
			{ json: { access_token: "tok-1", token_type: "bearer" } },
		]);
		const provider = new GitHubProvider({ requestUrl, clientId: "cid" });
		const sleeps: number[] = [];
		const result = await provider.pollDeviceFlow(
			{ ...startOf(), interval: 5 },
			{ sleep: async (ms) => void sleeps.push(ms), now: () => 0 }
		);

		expect(result).toEqual({ status: "success", token: "tok-1" });
		// 5s before each of the first two polls, then 10s after slow_down.
		expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
		const form = new URLSearchParams(calls[0].body as string);
		expect(calls[0].url).toBe("https://github.com/login/oauth/access_token");
		expect(form.get("device_code")).toBe("dev-123");
		expect(form.get("grant_type")).toBe(
			"urn:ietf:params:oauth:grant-type:device_code"
		);
	});

	it("honours a server-provided larger interval on slow_down", async () => {
		const { requestUrl } = scriptedRequests([
			{ json: { error: "slow_down", interval: 30 } },
			{ json: { access_token: "tok" } },
		]);
		const provider = new GitHubProvider({ requestUrl, clientId: "cid" });
		const sleeps: number[] = [];
		await provider.pollDeviceFlow(startOf(), {
			sleep: async (ms) => void sleeps.push(ms),
			now: () => 0,
		});
		expect(sleeps).toEqual([5000, 30000]);
	});

	it("reports expired_token as expired", async () => {
		const { requestUrl } = scriptedRequests([
			{ json: { error: "authorization_pending" } },
			{ json: { error: "expired_token" } },
		]);
		const provider = new GitHubProvider({ requestUrl, clientId: "cid" });
		const result = await provider.pollDeviceFlow(startOf(), {
			sleep: async () => {},
			now: () => 0,
		});
		expect(result).toEqual({ status: "expired" });
	});

	it("expires locally when the deadline passes without a server verdict", async () => {
		const { requestUrl } = scriptedRequests([]);
		const provider = new GitHubProvider({ requestUrl, clientId: "cid" });
		let clock = 0;
		const result = await provider.pollDeviceFlow(
			{ ...startOf(), expiresIn: 10 },
			{ sleep: async () => void (clock += 60_000), now: () => clock }
		);
		expect(result).toEqual({ status: "expired" });
	});

	it("reports access_denied as denied and unknown errors as error", async () => {
		const denied = new GitHubProvider({
			requestUrl: scriptedRequests([{ json: { error: "access_denied" } }]).requestUrl,
			clientId: "cid",
		});
		await expect(
			denied.pollDeviceFlow(startOf(), { sleep: async () => {}, now: () => 0 })
		).resolves.toEqual({ status: "denied" });

		const failed = new GitHubProvider({
			requestUrl: scriptedRequests([
				{ json: { error: "incorrect_device_code", error_description: "bad code" } },
			]).requestUrl,
			clientId: "cid",
		});
		await expect(
			failed.pollDeviceFlow(startOf(), { sleep: async () => {}, now: () => 0 })
		).resolves.toEqual({ status: "error", message: "bad code" });
	});

	it("supports cancellation between polls", async () => {
		const { requestUrl } = scriptedRequests([]);
		const provider = new GitHubProvider({ requestUrl, clientId: "cid" });
		const result = await provider.pollDeviceFlow(startOf(), {
			sleep: async () => {},
			now: () => 0,
			isCancelled: () => true,
		});
		expect(result).toEqual({ status: "cancelled" });
	});

	it("creates a pull request via the REST API", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{ status: 201, json: { html_url: "https://github.com/o/r/pull/7" } },
		]);
		const provider = new GitHubProvider({ requestUrl, clientId: "" });
		const pr = await provider.createPullRequest(
			{
				repoPath: "o/r",
				sourceBranch: "sync-conflict/desk-20260719",
				targetBranch: "main",
				title: "t",
				body: "b",
			},
			"tok"
		);
		expect(pr).toEqual({ url: "https://github.com/o/r/pull/7" });
		expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls");
		expect(calls[0].headers?.["Accept"]).toBe("application/vnd.github+json");
		expect(calls[0].headers?.["Authorization"]).toBe("Bearer tok");
		expect(JSON.parse(calls[0].body as string)).toEqual({
			title: "t",
			body: "b",
			head: "sync-conflict/desk-20260719",
			base: "main",
		});
	});

	it("throws with API details when PR creation fails", async () => {
		const { requestUrl } = scriptedRequests([
			{ status: 422, json: { message: "Validation Failed" } },
		]);
		const provider = new GitHubProvider({ requestUrl, clientId: "" });
		await expect(
			provider.createPullRequest(
				{ repoPath: "o/r", sourceBranch: "s", targetBranch: "m", title: "t", body: "" },
				"tok"
			)
		).rejects.toThrow(/422.*Validation Failed/);
	});
});

describe("GitLab device flow", () => {
	it("starts the RFC 8628 flow with write_repository + api scopes", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{
				json: {
					device_code: "gl-dev",
					user_code: "WXYZ",
					verification_uri: "https://gitlab.com/oauth/device",
					verification_uri_complete: "https://gitlab.com/oauth/device?user_code=WXYZ",
					expires_in: 300,
					interval: 5,
				},
			},
		]);
		const provider = new GitLabProvider({ requestUrl, clientId: "glcid" });
		const start = await provider.startDeviceFlow();

		expect(calls[0].url).toBe("https://gitlab.com/oauth/authorize_device");
		const form = new URLSearchParams(calls[0].body as string);
		expect(form.get("scope")).toBe("write_repository api");
		expect(start.userCode).toBe("WXYZ");
		expect(start.verificationUriComplete).toBe(
			"https://gitlab.com/oauth/device?user_code=WXYZ"
		);
	});

	it("builds a patUrl that pre-fills name + comma-joined scopes", () => {
		const provider = new GitLabProvider({ requestUrl: scriptedRequests([]).requestUrl, clientId: "" });
		const url = new URL(provider.patUrl);
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://gitlab.com/-/user_settings/personal_access_tokens"
		);
		expect(url.searchParams.get("name")).toBe("halyard-sync");
		expect(url.searchParams.get("scopes")).toBe("write_repository,api");
	});

	it("builds patUrl against the self-managed base URL", () => {
		const provider = new GitLabProvider({
			requestUrl: scriptedRequests([]).requestUrl,
			clientId: "",
			baseUrl: "https://git.corp.example/",
		});
		expect(provider.patUrl.startsWith("https://git.corp.example/-/user_settings/personal_access_tokens?")).toBe(true);
	});

	it("uses the self-managed base URL for all endpoints", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{
				json: {
					device_code: "d",
					user_code: "u",
					verification_uri: "https://git.corp.example/oauth/device",
				},
			},
			{ json: { access_token: "tok" } },
		]);
		const provider = new GitLabProvider({
			requestUrl,
			clientId: "cid",
			baseUrl: "https://git.corp.example/",
		});
		const start = await provider.startDeviceFlow();
		await provider.pollDeviceFlow(start, { sleep: async () => {}, now: () => 0 });
		expect(calls[0].url).toBe("https://git.corp.example/oauth/authorize_device");
		expect(calls[1].url).toBe("https://git.corp.example/oauth/token");
	});

	it("polls the token endpoint through the same pending/expired machine", async () => {
		const { requestUrl } = scriptedRequests([
			{ json: { error: "authorization_pending" } },
			{ json: { error: "expired_token" } },
		]);
		const provider = new GitLabProvider({ requestUrl, clientId: "cid" });
		const result = await provider.pollDeviceFlow(
			{
				deviceCode: "d",
				userCode: "u",
				verificationUri: "v",
				expiresIn: 300,
				interval: 5,
			},
			{ sleep: async () => {}, now: () => 0 }
		);
		expect(result).toEqual({ status: "expired" });
	});

	it("creates a merge request with a URL-encoded project path", async () => {
		const { calls, requestUrl } = scriptedRequests([
			{ status: 201, json: { web_url: "https://gitlab.com/g/p/-/merge_requests/3" } },
		]);
		const provider = new GitLabProvider({ requestUrl, clientId: "" });
		const mr = await provider.createPullRequest(
			{
				repoPath: "group/sub/project",
				sourceBranch: "conflict",
				targetBranch: "main",
				title: "t",
				body: "desc",
			},
			"tok"
		);
		expect(mr).toEqual({ url: "https://gitlab.com/g/p/-/merge_requests/3" });
		expect(calls[0].url).toBe(
			"https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests"
		);
		expect(calls[0].headers?.["Authorization"]).toBe("Bearer tok");
		expect(JSON.parse(calls[0].body as string)).toEqual({
			source_branch: "conflict",
			target_branch: "main",
			title: "t",
			description: "desc",
		});
	});

	it("surfaces GitLab array-form error messages", async () => {
		const { requestUrl } = scriptedRequests([
			{ status: 409, json: { message: ["Another open merge request already exists"] } },
		]);
		const provider = new GitLabProvider({ requestUrl, clientId: "" });
		await expect(
			provider.createPullRequest(
				{ repoPath: "g/p", sourceBranch: "s", targetBranch: "m", title: "t", body: "" },
				"tok"
			)
		).rejects.toThrow(/Another open merge request/);
	});
});

function startOf() {
	return {
		deviceCode: "dev-123",
		userCode: "ABCD-1234",
		verificationUri: "https://github.com/login/device",
		expiresIn: 900,
		interval: 5,
	};
}
