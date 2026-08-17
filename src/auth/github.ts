/**
 * GitHub: OAuth device flow + pull request creation over REST.
 *
 * The device flow only works once the plugin distributor registers an OAuth
 * app and fills in the client ID (constant below or settings override);
 * with an empty ID the UI hides device flow and offers PAT only.
 */

import type { RequestUrlLike } from "../git/http-client";
import {
	decodeJson,
	describeApiError,
	numberOr,
	pollDeviceToken,
	postForm,
	stringOr,
	type DeviceFlowResult,
	type DeviceFlowStart,
	type ForgeProvider,
	type PollHooks,
	type PullRequestParams,
} from "./providers";

/** Filled in by the distributor after registering the OAuth app. */
export const DEFAULT_GITHUB_CLIENT_ID = "";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_BASE = "https://api.github.com";

export interface GitHubProviderOptions {
	requestUrl: RequestUrlLike;
	clientId: string;
}

export class GitHubProvider implements ForgeProvider {
	readonly kind = "github";
	readonly label = "GitHub";
	readonly patInstructions =
		"Create a fine-grained personal access token scoped to this repository " +
		"with permissions: Contents (read/write), Metadata (read), and Pull " +
		"requests (read/write) — the last one lets conflict branches open PRs. " +
		"A classic token with the repo scope works too — either kind is " +
		"accepted here; use https://github.com/settings/tokens/new?scopes=repo " +
		"if you'd rather create a classic one.";
	readonly patUrl = "https://github.com/settings/personal-access-tokens/new";

	constructor(private readonly opts: GitHubProviderOptions) {}

	get deviceFlowSupported(): boolean {
		return this.opts.clientId.length > 0;
	}

	async startDeviceFlow(): Promise<DeviceFlowStart> {
		if (!this.deviceFlowSupported) {
			throw new Error("No GitHub OAuth client ID configured — use a personal access token.");
		}
		const { status, json } = await postForm(this.opts.requestUrl, DEVICE_CODE_URL, {
			client_id: this.opts.clientId,
			scope: "repo",
		});
		const deviceCode = json["device_code"];
		const userCode = json["user_code"];
		if (status !== 200 || typeof deviceCode !== "string" || typeof userCode !== "string") {
			throw new Error(
				`GitHub device flow failed to start (HTTP ${status}): ${describeApiError(json)}`
			);
		}
		return {
			deviceCode,
			userCode,
			verificationUri: stringOr(
				json["verification_uri"],
				"https://github.com/login/device"
			),
			expiresIn: numberOr(json["expires_in"], 900),
			interval: numberOr(json["interval"], 5),
		};
	}

	pollDeviceFlow(start: DeviceFlowStart, hooks?: PollHooks): Promise<DeviceFlowResult> {
		return pollDeviceToken(
			() =>
				postForm(this.opts.requestUrl, ACCESS_TOKEN_URL, {
					client_id: this.opts.clientId,
					device_code: start.deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			start,
			hooks
		);
	}

	async createPullRequest(
		params: PullRequestParams,
		token: string
	): Promise<{ url: string }> {
		const response = await this.opts.requestUrl({
			url: `${API_BASE}/repos/${params.repoPath}/pulls`,
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				title: params.title,
				body: params.body,
				head: params.sourceBranch,
				base: params.targetBranch,
			}),
			throw: false,
		});
		const json = decodeJson(response.arrayBuffer);
		const url = json["html_url"];
		if (response.status !== 201 || typeof url !== "string") {
			throw new Error(
				`GitHub pull request creation failed (HTTP ${response.status}): ${describeApiError(json)}`
			);
		}
		return { url };
	}

	gitAuth(token: string): { username: string; password: string } {
		return { username: "x-access-token", password: token };
	}
}
