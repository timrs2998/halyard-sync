/**
 * Forge provider abstraction: detect GitHub / GitLab / generic from the
 * remote URL, normalize remote URLs (HTTPS only — SSH cannot work on
 * mobile), and define the interface device flows and PR creation implement.
 *
 * Network access goes through an injected `requestUrl`-like function (same
 * DI pattern as git/http-client) so everything here is unit-testable.
 */

import type { RequestUrlLike } from "../git/http-client";
import { AzureDevOpsProvider } from "./azuredevops";
import { BitbucketProvider } from "./bitbucket";
import { DEFAULT_GITHUB_CLIENT_ID, GitHubProvider } from "./github";
import { GiteaProvider } from "./gitea";
import { DEFAULT_GITLAB_CLIENT_ID, GitLabProvider } from "./gitlab";

export type ProviderKind =
	| "github"
	| "gitlab"
	| "bitbucket"
	| "gitea"
	| "azuredevops"
	| "generic";

export interface ParsedRemote {
	/** Host including port, e.g. "gitlab.example.com:8443". */
	host: string;
	/** Scheme + host, e.g. "https://gitlab.example.com:8443". */
	origin: string;
	/** "owner/repo" or "group/sub/project" — no leading slash, no ".git". */
	repoPath: string;
}

/**
 * Parse an HTTPS remote URL. SSH forms are rejected with a pointer to the
 * HTTPS equivalent: mobile has no subprocess to run SSH in, so HTTPS is the
 * only transport that works everywhere.
 */
export function normalizeRemoteUrl(input: string): ParsedRemote {
	const url = input.trim();
	if (url.length === 0) {
		throw new Error("Remote URL is empty.");
	}
	// "ssh://git@host/..." and scp-style "git@host:owner/repo.git". The
	// scp-style pattern cannot false-positive on https:// URLs because the
	// character class excludes "/".
	if (/^ssh:\/\//i.test(url) || /^[^/@\s]+@[^/@\s]+:/.test(url)) {
		throw new Error(
			"SSH remote URLs are not supported (mobile devices cannot use SSH keys). " +
				"Use the HTTPS URL instead, e.g. https://github.com/owner/repo.git"
		);
	}
	if (/^git:\/\//i.test(url)) {
		throw new Error("git:// remotes are not supported — use the HTTPS URL.");
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(
			`Not a valid URL: '${url}'. Expected e.g. https://github.com/owner/repo.git`
		);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(
			`Unsupported protocol '${parsed.protocol}' — use an HTTPS remote URL.`
		);
	}
	const repoPath = parsed.pathname
		.replace(/\/+$/, "")
		.replace(/^\/+/, "")
		.replace(/\.git$/i, "");
	if (repoPath.length === 0) {
		throw new Error("Remote URL has no repository path (expected /owner/repo).");
	}
	return {
		host: parsed.host,
		origin: `${parsed.protocol}//${parsed.host}`,
		repoPath,
	};
}

/**
 * Best-effort SSH -> HTTPS conversion, for prepopulating the setup wizard's
 * URL field from a vault's already-existing git remote (see
 * `main.ts`'s `detectExistingRemoteUrl`) — NOT used by `normalizeRemoteUrl`
 * above, which deliberately rejects SSH outright rather than silently
 * rewriting it for an actual sync operation. Recognizes both SSH forms
 * `normalizeRemoteUrl` itself checks for (`ssh://...` and scp-style
 * `user@host:path`); returns null for anything else, including URLs that
 * are already HTTPS/HTTP (nothing to convert) or unrecognized garbage —
 * callers should fall back to the original string in that case.
 *
 * A custom SSH port (`ssh://host:2222/...`) is dropped: HTTPS git access
 * lives at the ordinary host on 443, and an SSH-specific port carries no
 * meaning there.
 */
export function sshUrlToHttps(url: string): string | null {
	const trimmed = url.trim();
	const sshScheme = /^ssh:\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::\d+)?(\/.+)$/i.exec(trimmed);
	if (sshScheme) {
		const [, host, path] = sshScheme;
		return `https://${host}${path}`;
	}
	// scp-style: user@host:path — same character-class guard normalizeRemoteUrl
	// uses so this never fires on a bare https:// URL.
	const scpLike = /^[^/@\s]+@([^/@\s]+):(.+)$/.exec(trimmed);
	if (scpLike) {
		const [, host, path] = scpLike;
		return `https://${host}/${path.replace(/^\/+/, "")}`;
	}
	return null;
}

/** Tolerate a bare host ("gitlab.example.com") in the self-managed setting. */
function baseUrlHost(baseUrl: string): string | null {
	const trimmed = baseUrl.trim();
	if (trimmed.length === 0) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	try {
		return new URL(withScheme).host.toLowerCase();
	} catch {
		return null;
	}
}

export function detectProvider(
	remoteUrl: string,
	gitlabSelfManagedBase?: string,
	giteaSelfManagedBase?: string
): ProviderKind {
	const host = normalizeRemoteUrl(remoteUrl).host.toLowerCase();
	if (host === "github.com" || host === "www.github.com") return "github";
	if (host === "gitlab.com" || host === "www.gitlab.com") return "gitlab";
	if (host === "bitbucket.org" || host === "www.bitbucket.org") return "bitbucket";
	if (host === "dev.azure.com" || /(^|\.)visualstudio\.com$/.test(host)) {
		return "azuredevops";
	}
	if (gitlabSelfManagedBase !== undefined && baseUrlHost(gitlabSelfManagedBase) === host) {
		return "gitlab";
	}
	if (giteaSelfManagedBase !== undefined && baseUrlHost(giteaSelfManagedBase) === host) {
		return "gitea";
	}
	return "generic";
}

// ---------------------------------------------------------------------------
// Device flow types + shared poll loop (RFC 8628)
// ---------------------------------------------------------------------------

export interface DeviceFlowStart {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** GitLab sends a URL with the code pre-filled; GitHub does not. */
	verificationUriComplete?: string;
	expiresIn: number;
	/** Minimum seconds between polls. */
	interval: number;
}

export type DeviceFlowResult =
	| { status: "success"; token: string }
	| { status: "expired" }
	| { status: "denied" }
	| { status: "cancelled" }
	| { status: "error"; message: string };

export interface PollHooks {
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	isCancelled?: () => boolean;
	onPoll?: (status: "pending" | "slow_down") => void;
}

export interface JsonHttpResult {
	status: number;
	json: Record<string, unknown>;
}

export function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function decodeJson(buf: ArrayBuffer): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(buf));
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export async function postForm(
	requestUrlFn: RequestUrlLike,
	url: string,
	form: Record<string, string>
): Promise<JsonHttpResult> {
	const response = await requestUrlFn({
		url,
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams(form).toString(),
		throw: false,
	});
	return { status: response.status, json: decodeJson(response.arrayBuffer) };
}

export function describeApiError(json: Record<string, unknown>): string {
	for (const key of ["error_description", "message", "error"]) {
		const value = json[key];
		if (typeof value === "string" && value.length > 0) return value;
		// GitLab MR errors arrive as {"message": ["source_branch ..."]}.
		if (Array.isArray(value) && value.length > 0) return value.join("; ");
	}
	return "no error details in response";
}

/**
 * Poll a token endpoint until the flow completes. Waits one interval before
 * the first poll (RFC 8628 §3.5), honours `slow_down` by growing the
 * interval (+5s unless the server names a larger one), and stops on
 * cancellation, expiry, denial, or an unrecognized error.
 */
export async function pollDeviceToken(
	fetchToken: () => Promise<JsonHttpResult>,
	start: DeviceFlowStart,
	hooks: PollHooks = {}
): Promise<DeviceFlowResult> {
	const sleep =
		hooks.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)));
	const now = hooks.now ?? Date.now;
	const deadline = now() + start.expiresIn * 1000;
	let intervalSec = start.interval > 0 ? start.interval : 5;

	for (;;) {
		await sleep(intervalSec * 1000);
		if (hooks.isCancelled?.()) return { status: "cancelled" };
		if (now() > deadline) return { status: "expired" };
		const { json } = await fetchToken();
		const token = json["access_token"];
		if (typeof token === "string" && token.length > 0) {
			return { status: "success", token };
		}
		const error = typeof json["error"] === "string" ? json["error"] : "";
		switch (error) {
			case "authorization_pending":
				hooks.onPoll?.("pending");
				continue;
			case "slow_down": {
				const next = json["interval"];
				intervalSec =
					typeof next === "number" && next > intervalSec
						? next
						: intervalSec + 5;
				hooks.onPoll?.("slow_down");
				continue;
			}
			case "expired_token":
				return { status: "expired" };
			case "access_denied":
				return { status: "denied" };
			default:
				return { status: "error", message: describeApiError(json) };
		}
	}
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface PullRequestParams {
	/** "owner/repo" (GitHub) or full project path (GitLab). */
	repoPath: string;
	sourceBranch: string;
	targetBranch: string;
	title: string;
	body: string;
}

export interface ForgeProvider {
	readonly kind: ProviderKind;
	readonly label: string;
	/** False when no OAuth client ID is configured — UI falls back to PAT. */
	readonly deviceFlowSupported: boolean;
	/** Per-provider guidance rendered next to the PAT field. */
	readonly patInstructions: string;
	/** Direct link to the host's token-creation page, if one exists — the UI
	 * renders an "Open token page" button next to the PAT field when set. */
	readonly patUrl?: string;
	startDeviceFlow(): Promise<DeviceFlowStart>;
	pollDeviceFlow(start: DeviceFlowStart, hooks?: PollHooks): Promise<DeviceFlowResult>;
	/** Null when the provider cannot create PRs (caller degrades gracefully). */
	createPullRequest(
		params: PullRequestParams,
		token: string
	): Promise<{ url: string } | null>;
	gitAuth(token: string): { username: string; password: string };
}

/** PAT-only provider for self-hosted/unknown forges. */
export class GenericProvider implements ForgeProvider {
	readonly kind = "generic";
	readonly label = "Generic git host";
	readonly deviceFlowSupported = false;
	readonly patInstructions =
		"Create an access token with repository read/write permission on your " +
		"git host and paste it here. If your host expects a specific username " +
		"for token auth, set it under Advanced.";

	constructor(private readonly username: string = "oauth2") {}

	startDeviceFlow(): Promise<DeviceFlowStart> {
		return Promise.reject(
			new Error("Device flow sign-in is not available for this git host — use an access token.")
		);
	}

	pollDeviceFlow(): Promise<DeviceFlowResult> {
		return Promise.reject(
			new Error("Device flow sign-in is not available for this git host — use an access token.")
		);
	}

	createPullRequest(): Promise<null> {
		return Promise.resolve(null);
	}

	gitAuth(token: string): { username: string; password: string } {
		return { username: this.username.length > 0 ? this.username : "oauth2", password: token };
	}
}

export interface ProviderConfig {
	requestUrl: RequestUrlLike;
	githubClientId?: string;
	gitlabClientId?: string;
	/** Marks a self-managed GitLab instance host. */
	gitlabSelfManagedBase?: string;
	/** Marks a self-managed Gitea/Forgejo instance host. */
	giteaSelfManagedBase?: string;
	/** Atlassian account email — Bitbucket's REST API needs it alongside the API token. */
	bitbucketAccountEmail?: string;
	/** Username the generic provider sends with a PAT (default "oauth2"). */
	genericUsername?: string;
}

/**
 * Build the provider for a remote URL. Throws on unparseable/SSH URLs —
 * callers surface the message to the user.
 *
 * (The module cycle with github.ts/gitlab.ts/bitbucket.ts/gitea.ts/
 * azuredevops.ts is benign: they only call hoisted helper functions from
 * here inside method bodies, never at module evaluation time.)
 */
export function createProvider(remoteUrl: string, config: ProviderConfig): ForgeProvider {
	const kind = detectProvider(
		remoteUrl,
		config.gitlabSelfManagedBase,
		config.giteaSelfManagedBase
	);
	switch (kind) {
		case "github":
			return new GitHubProvider({
				requestUrl: config.requestUrl,
				clientId:
					config.githubClientId !== undefined && config.githubClientId.length > 0
						? config.githubClientId
						: DEFAULT_GITHUB_CLIENT_ID,
			});
		case "gitlab":
			return new GitLabProvider({
				requestUrl: config.requestUrl,
				clientId:
					config.gitlabClientId !== undefined && config.gitlabClientId.length > 0
						? config.gitlabClientId
						: DEFAULT_GITLAB_CLIENT_ID,
				// The remote's own origin doubles as the API base, which
				// covers self-managed instances automatically.
				baseUrl: normalizeRemoteUrl(remoteUrl).origin,
			});
		case "bitbucket":
			return new BitbucketProvider({
				requestUrl: config.requestUrl,
				accountEmail: config.bitbucketAccountEmail,
			});
		case "gitea":
			return new GiteaProvider({
				requestUrl: config.requestUrl,
				baseUrl: normalizeRemoteUrl(remoteUrl).origin,
			});
		case "azuredevops":
			return new AzureDevOpsProvider({
				requestUrl: config.requestUrl,
				remoteUrl,
			});
		default:
			return new GenericProvider(config.genericUsername);
	}
}
