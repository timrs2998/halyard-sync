/**
 * Gitea / Forgejo (including Codeberg): PAT-only (no released device flow —
 * see DESIGN.md "Future: Gitea/Forgejo device flow") + pull request creation
 * over REST. Self-hosted, so the base URL comes from settings
 * (`giteaSelfManagedBase`), the same pattern as GitLab's self-managed base.
 * Forgejo is a Gitea fork with a compatible API, so this module covers both.
 *
 * Git-auth convention (verified against current Gitea docs, mirrored by
 * Codeberg): HTTP Basic auth accepts the token in EITHER the username or
 * the password slot — Gitea's docs show both `curl -u username:TOKEN` and
 * `curl -u TOKEN:x-oauth-basic` as working forms. We use the token-as-
 * username form (mirroring GitHub's `x-access-token` pattern) because it
 * needs no extra "what's your Gitea username" setting.
 */

import type { RequestUrlLike } from "../git/http-client";
import {
	decodeJson,
	describeApiError,
	type DeviceFlowResult,
	type DeviceFlowStart,
	type ForgeProvider,
	type PullRequestParams,
} from "./providers";

/** Documented fixed password paired with the token-as-username form. */
const GIT_AUTH_PASSWORD = "x-oauth-basic";

export interface GiteaProviderOptions {
	requestUrl: RequestUrlLike;
	/** Instance origin, e.g. "https://codeberg.org" or a self-managed host. */
	baseUrl: string;
}

function splitRepoPath(repoPath: string): { owner: string; repo: string } {
	const slash = repoPath.indexOf("/");
	if (slash === -1) {
		throw new Error(`Not a Gitea owner/repo path: '${repoPath}'.`);
	}
	return { owner: repoPath.slice(0, slash), repo: repoPath.slice(slash + 1) };
}

export class GiteaProvider implements ForgeProvider {
	readonly kind = "gitea";
	readonly label = "Gitea/Forgejo";
	readonly deviceFlowSupported = false;
	readonly patInstructions =
		"Create an access token (Settings → Applications → Manage Access Tokens) " +
		"with repository read/write permission and paste it here. Works the same " +
		"way for Gitea, Forgejo, and Codeberg.";

	private readonly base: string;

	constructor(private readonly opts: GiteaProviderOptions) {
		this.base = opts.baseUrl.replace(/\/+$/, "");
	}

	startDeviceFlow(): Promise<DeviceFlowStart> {
		return Promise.reject(
			new Error(
				"Device flow sign-in is not available for Gitea/Forgejo yet — use an access token."
			)
		);
	}

	pollDeviceFlow(): Promise<DeviceFlowResult> {
		return Promise.reject(
			new Error(
				"Device flow sign-in is not available for Gitea/Forgejo yet — use an access token."
			)
		);
	}

	async createPullRequest(
		params: PullRequestParams,
		token: string
	): Promise<{ url: string }> {
		const { owner, repo } = splitRepoPath(params.repoPath);
		const response = await this.opts.requestUrl({
			url: `${this.base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
			method: "POST",
			headers: {
				Authorization: `token ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
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
				`Gitea/Forgejo pull request creation failed (HTTP ${response.status}): ${describeApiError(json)}`
			);
		}
		return { url };
	}

	gitAuth(token: string): { username: string; password: string } {
		return { username: token, password: GIT_AUTH_PASSWORD };
	}
}
