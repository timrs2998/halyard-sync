/**
 * GitLab: RFC 8628 device flow (GA in GitLab 17.9) + merge request creation.
 * Works against gitlab.com and self-managed instances via `baseUrl`
 * (instances older than 17.9 fall back to PAT — the device endpoints 404
 * there, which surfaces as a start-flow error).
 */

import type { RequestUrlLike } from "../git/http-client";
import {
	decodeJson,
	describeApiError,
	numberOr,
	pollDeviceToken,
	postForm,
	type DeviceFlowResult,
	type DeviceFlowStart,
	type ForgeProvider,
	type PollHooks,
	type PullRequestParams,
} from "./providers";

/** Filled in by the distributor after registering the OAuth app. */
export const DEFAULT_GITLAB_CLIENT_ID = "";

/** `api` is required for MR creation; `write_repository` for git push. */
const SCOPES = "write_repository api";

export interface GitLabProviderOptions {
	requestUrl: RequestUrlLike;
	clientId: string;
	/** Instance origin, e.g. "https://gitlab.com" or a self-managed host. */
	baseUrl?: string;
}

export class GitLabProvider implements ForgeProvider {
	readonly kind = "gitlab";
	readonly label = "GitLab";
	readonly patInstructions =
		"Create a personal access token with scopes `write_repository` and " +
		"`api` — `api` is needed so conflict branches can open merge requests. " +
		"The button below opens GitLab's token page with both scopes " +
		"pre-selected.";

	private readonly base: string;

	constructor(private readonly opts: GitLabProviderOptions) {
		this.base = (opts.baseUrl ?? "https://gitlab.com").replace(/\/+$/, "");
	}

	/** GitLab's token-creation page reads `name`/`scopes` off the query string
	 * and pre-fills the form (same mechanism GitLab's own docs use for
	 * onboarding links) — works for self-managed instances too since it's
	 * built off `this.base`, not a hardcoded gitlab.com URL. */
	get patUrl(): string {
		const params = new URLSearchParams({
			name: "halyard-sync",
			scopes: SCOPES.split(" ").join(","),
		});
		return `${this.base}/-/user_settings/personal_access_tokens?${params.toString()}`;
	}

	get deviceFlowSupported(): boolean {
		return this.opts.clientId.length > 0;
	}

	async startDeviceFlow(): Promise<DeviceFlowStart> {
		if (!this.deviceFlowSupported) {
			throw new Error("No GitLab OAuth client ID configured — use a personal access token.");
		}
		const { status, json } = await postForm(
			this.opts.requestUrl,
			`${this.base}/oauth/authorize_device`,
			{
				client_id: this.opts.clientId,
				scope: SCOPES,
			}
		);
		const deviceCode = json["device_code"];
		const userCode = json["user_code"];
		const verificationUri = json["verification_uri"];
		if (
			status !== 200 ||
			typeof deviceCode !== "string" ||
			typeof userCode !== "string" ||
			typeof verificationUri !== "string"
		) {
			throw new Error(
				`GitLab device flow failed to start (HTTP ${status}): ${describeApiError(json)}. ` +
					"Self-managed instances need GitLab 17.9+ for device flow — otherwise use a PAT."
			);
		}
		const complete = json["verification_uri_complete"];
		return {
			deviceCode,
			userCode,
			verificationUri,
			verificationUriComplete:
				typeof complete === "string" ? complete : undefined,
			expiresIn: numberOr(json["expires_in"], 300),
			interval: numberOr(json["interval"], 5),
		};
	}

	pollDeviceFlow(start: DeviceFlowStart, hooks?: PollHooks): Promise<DeviceFlowResult> {
		return pollDeviceToken(
			() =>
				postForm(this.opts.requestUrl, `${this.base}/oauth/token`, {
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
		const project = encodeURIComponent(params.repoPath);
		const response = await this.opts.requestUrl({
			url: `${this.base}/api/v4/projects/${project}/merge_requests`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				source_branch: params.sourceBranch,
				target_branch: params.targetBranch,
				title: params.title,
				description: params.body,
			}),
			throw: false,
		});
		const json = decodeJson(response.arrayBuffer);
		const url = json["web_url"];
		if (response.status !== 201 || typeof url !== "string") {
			throw new Error(
				`GitLab merge request creation failed (HTTP ${response.status}): ${describeApiError(json)}`
			);
		}
		return { url };
	}

	gitAuth(token: string): { username: string; password: string } {
		return { username: "oauth2", password: token };
	}
}
