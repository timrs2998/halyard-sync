/**
 * Bitbucket Cloud: PAT-only (Atlassian API tokens — app passwords are being
 * retired: no new ones since 2025-09-09, brownout 2026-06-09 to 2026-07-27,
 * fully removed 2026-07-28) + pull request creation over REST.
 *
 * Two DIFFERENT Basic-auth username conventions are involved here (verified
 * against Atlassian's current docs — this was the one under-documented
 * detail the design flagged):
 *   - git-over-HTTPS: the static username `x-bitbucket-api-token-auth`
 *     works with any API token as the password (Atlassian support,
 *     "Using API tokens"). No settings needed.
 *   - REST API calls (including PR creation): the docs are explicit that
 *     this is different from git — Basic auth needs the *Atlassian account
 *     email* as username, not the static git username. That email isn't
 *     derivable from anything else the plugin collects, so it's a settings
 *     field (`bitbucketAccountEmail`); without it PR creation throws and
 *     the conflict resolver degrades to "branch pushed, open a PR manually"
 *     (see sync/conflicts.ts).
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

const API_BASE = "https://api.bitbucket.org/2.0";

/** Documented static username for git-over-HTTPS with an API token. */
const GIT_AUTH_USERNAME = "x-bitbucket-api-token-auth";

export interface BitbucketProviderOptions {
	requestUrl: RequestUrlLike;
	/** Atlassian account email, required only for REST calls (see module docs). */
	accountEmail?: string;
}

/** "{workspace}/{repo_slug}" -> the two path segments Bitbucket's API wants. */
function splitRepoPath(repoPath: string): { workspace: string; repoSlug: string } {
	const slash = repoPath.indexOf("/");
	if (slash === -1) {
		throw new Error(`Not a Bitbucket workspace/repo path: '${repoPath}'.`);
	}
	return { workspace: repoPath.slice(0, slash), repoSlug: repoPath.slice(slash + 1) };
}

/** Bitbucket errors arrive as {"error": {"message": "..."}}, not a top-level string. */
function describeBitbucketError(json: Record<string, unknown>): string {
	const err = json["error"];
	if (typeof err === "object" && err !== null) {
		const message = (err as Record<string, unknown>)["message"];
		if (typeof message === "string" && message.length > 0) return message;
	}
	return describeApiError(json);
}

export class BitbucketProvider implements ForgeProvider {
	readonly kind = "bitbucket";
	readonly label = "Bitbucket";
	readonly deviceFlowSupported = false;
	readonly patInstructions =
		"Create an Atlassian API token (id.atlassian.com → Security → API tokens → " +
		"Create API token with scopes, app: Bitbucket) with scopes Repositories " +
		"(read/write) and Pull requests (read/write). Bitbucket app passwords are " +
		"being retired (no new ones since 2025-09-09, fully removed 2026-07-28) — " +
		"use an API token instead. Also set your Atlassian account email under " +
		"Advanced: the REST API needs it (alongside the token) to open pull " +
		"requests, even though git sync itself doesn't.";

	constructor(private readonly opts: BitbucketProviderOptions) {}

	startDeviceFlow(): Promise<DeviceFlowStart> {
		return Promise.reject(
			new Error("Bitbucket has no device-flow sign-in — use a personal access token.")
		);
	}

	pollDeviceFlow(): Promise<DeviceFlowResult> {
		return Promise.reject(
			new Error("Bitbucket has no device-flow sign-in — use a personal access token.")
		);
	}

	async createPullRequest(
		params: PullRequestParams,
		token: string
	): Promise<{ url: string }> {
		const email = this.opts.accountEmail?.trim();
		if (email === undefined || email.length === 0) {
			throw new Error(
				"Bitbucket pull request creation needs your Atlassian account email " +
					"(Settings → Advanced → Bitbucket account email) alongside the API token."
			);
		}
		const { workspace, repoSlug } = splitRepoPath(params.repoPath);
		const response = await this.opts.requestUrl({
			url: `${API_BASE}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests`,
			method: "POST",
			headers: {
				Authorization: `Basic ${btoa(`${email}:${token}`)}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				title: params.title,
				description: params.body,
				source: { branch: { name: params.sourceBranch } },
				destination: { branch: { name: params.targetBranch } },
			}),
			throw: false,
		});
		const json = decodeJson(response.arrayBuffer);
		const links = json["links"];
		const html =
			typeof links === "object" && links !== null
				? (links as Record<string, unknown>)["html"]
				: undefined;
		const url =
			typeof html === "object" && html !== null
				? (html as Record<string, unknown>)["href"]
				: undefined;
		if (response.status !== 201 || typeof url !== "string") {
			throw new Error(
				`Bitbucket pull request creation failed (HTTP ${response.status}): ${describeBitbucketError(json)}`
			);
		}
		return { url };
	}

	gitAuth(token: string): { username: string; password: string } {
		return { username: GIT_AUTH_USERNAME, password: token };
	}
}
