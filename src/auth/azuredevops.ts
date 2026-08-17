/**
 * Azure DevOps: PAT-only (Entra ID device flow exists in principle but
 * routinely hits tenant conditional-access/admin-consent policies in real
 * orgs — not worth it for v1, see DESIGN.md) + pull request creation over
 * REST.
 *
 * Git-auth convention (verified against Microsoft's docs): empty username,
 * PAT as password, Base64-encoded Basic auth. The same convention works for
 * the REST API (`curl -u :{PAT} ...`).
 *
 * PR creation needs the repository's internal GUID, not owner/repo names —
 * unlike every other provider here. `createPullRequest` therefore does a
 * lookup call first (`GET .../_apis/git/repositories/{repoNameOrId}`, which
 * Microsoft's API accepts by name OR id) to resolve the GUID before POSTing
 * the pull request.
 */

import type { RequestUrlLike } from "../git/http-client";
import {
	decodeJson,
	describeApiError,
	normalizeRemoteUrl,
	type DeviceFlowResult,
	type DeviceFlowStart,
	type ForgeProvider,
	type PullRequestParams,
} from "./providers";

const API_VERSION = "7.1";

export interface AzureDevOpsRepoRef {
	organization: string;
	project: string;
	repository: string;
}

/**
 * Parses both supported remote URL shapes:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}.visualstudio.com/{project}/_git/{repo}   (legacy)
 */
export function parseAzureDevOpsRemote(remoteUrl: string): AzureDevOpsRepoRef {
	const { host, repoPath } = normalizeRemoteUrl(remoteUrl);
	const segments = repoPath.split("/").filter((s) => s.length > 0);
	const gitIndex = segments.indexOf("_git");
	if (gitIndex === -1 || gitIndex === segments.length - 1) {
		throw new Error(
			`Not an Azure DevOps repository URL (expected '.../_git/<repo>'): '${remoteUrl}'`
		);
	}
	const repository = decodeURIComponent(segments[gitIndex + 1]);
	const isVisualStudioHost = /(^|\.)visualstudio\.com$/i.test(host);

	let organization: string;
	let projectSegments: string[];
	if (isVisualStudioHost) {
		organization = host.split(".")[0];
		projectSegments = segments.slice(0, gitIndex);
	} else {
		if (gitIndex < 2) {
			throw new Error(
				`Not an Azure DevOps repository URL (missing org/project): '${remoteUrl}'`
			);
		}
		organization = decodeURIComponent(segments[0]);
		projectSegments = segments.slice(1, gitIndex);
	}
	if (projectSegments.length === 0 || organization.length === 0) {
		throw new Error(
			`Not an Azure DevOps repository URL (missing project): '${remoteUrl}'`
		);
	}
	return {
		organization,
		project: decodeURIComponent(projectSegments.join("/")),
		repository,
	};
}

export interface AzureDevOpsProviderOptions {
	requestUrl: RequestUrlLike;
	/** The vault's configured remote URL — parsed once at construction. */
	remoteUrl: string;
}

export class AzureDevOpsProvider implements ForgeProvider {
	readonly kind = "azuredevops";
	readonly label = "Azure DevOps";
	readonly deviceFlowSupported = false;
	readonly patInstructions =
		"Create a personal access token (Azure DevOps → User settings → Personal " +
		"access tokens) with scope Code (Read & Write) and paste it here.";

	private readonly repoRef: AzureDevOpsRepoRef;

	constructor(private readonly opts: AzureDevOpsProviderOptions) {
		// Thrown eagerly so a malformed remote surfaces immediately at
		// provider-construction time, same as GitLab/GitHub's URL handling.
		this.repoRef = parseAzureDevOpsRemote(opts.remoteUrl);
	}

	startDeviceFlow(): Promise<DeviceFlowStart> {
		return Promise.reject(
			new Error(
				"Device flow sign-in is not available for Azure DevOps — use a personal access token."
			)
		);
	}

	pollDeviceFlow(): Promise<DeviceFlowResult> {
		return Promise.reject(
			new Error(
				"Device flow sign-in is not available for Azure DevOps — use a personal access token."
			)
		);
	}

	private authHeader(token: string): string {
		return `Basic ${btoa(`:${token}`)}`;
	}

	private async resolveRepositoryId(token: string): Promise<string> {
		const { organization, project, repository } = this.repoRef;
		const url =
			`https://dev.azure.com/${encodeURIComponent(organization)}/` +
			`${encodeURIComponent(project)}/_apis/git/repositories/` +
			`${encodeURIComponent(repository)}?api-version=${API_VERSION}`;
		const response = await this.opts.requestUrl({
			url,
			method: "GET",
			headers: {
				Authorization: this.authHeader(token),
				Accept: "application/json",
			},
			throw: false,
		});
		const json = decodeJson(response.arrayBuffer);
		const id = json["id"];
		if (response.status !== 200 || typeof id !== "string") {
			throw new Error(
				`Azure DevOps repository lookup failed (HTTP ${response.status}): ${describeApiError(json)}`
			);
		}
		return id;
	}

	async createPullRequest(
		params: PullRequestParams,
		token: string
	): Promise<{ url: string }> {
		const repositoryId = await this.resolveRepositoryId(token);
		const { organization, project, repository } = this.repoRef;
		const url =
			`https://dev.azure.com/${encodeURIComponent(organization)}/_apis/git/repositories/` +
			`${encodeURIComponent(repositoryId)}/pullrequests?api-version=${API_VERSION}`;
		const response = await this.opts.requestUrl({
			url,
			method: "POST",
			headers: {
				Authorization: this.authHeader(token),
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				sourceRefName: `refs/heads/${params.sourceBranch}`,
				targetRefName: `refs/heads/${params.targetBranch}`,
				title: params.title,
				description: params.body,
			}),
			throw: false,
		});
		const json = decodeJson(response.arrayBuffer);
		const pullRequestId = json["pullRequestId"];
		// Docs list 200 as the documented success status; some deployments
		// return 201 for resource creation — accept either.
		if (
			(response.status !== 200 && response.status !== 201) ||
			typeof pullRequestId !== "number"
		) {
			throw new Error(
				`Azure DevOps pull request creation failed (HTTP ${response.status}): ${describeApiError(json)}`
			);
		}
		// The REST response has no ready-made web URL (only API self-links),
		// so build the browser URL from the pieces we already have.
		const webUrl =
			`https://dev.azure.com/${encodeURIComponent(organization)}/` +
			`${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/` +
			`pullrequest/${pullRequestId}`;
		return { url: webUrl };
	}

	gitAuth(token: string): { username: string; password: string } {
		return { username: "", password: token };
	}
}
