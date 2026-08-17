/**
 * A minimal real smart-HTTP git server for the Asyncify double-suspension
 * probe (see `tests/libgit2/asyncify-double-suspension.test.ts`).
 *
 * This is test infrastructure only — it shells out to the real
 * `git http-backend` CGI program (part of any standard git install) via a
 * plain `node:http` server that speaks the CGI 1.1 protocol to it. This is
 * NOT a design precedent for the plugin itself (which never spawns
 * subprocesses — see DESIGN.md's "no shell, no subprocess" constraint); it
 * exists purely so the test can stand up a real git smart-HTTP endpoint
 * without depending on outbound network access to a public host, matching
 * the actual wire protocol (`GET /info/refs?service=git-upload-pack`,
 * `POST /git-upload-pack`) that `native/transport_shim.c`'s custom
 * subtransport and `../http-transport.ts` are both built around.
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface GitHttpBackendHandle {
	/** Base URL for the served repo, e.g. `http://127.0.0.1:54321/repo.git` — pass
	 * this straight through to a clone/fetch call. */
	url: string;
	close(): Promise<void>;
}

export interface GitHttpBackendAuthOptions {
	username: string;
	password: string;
}

export interface GitHttpBackendOptions {
	/** When set, every request must carry a matching `Authorization: Basic
	 * ...` header (base64 of `username:password`) or the server responds 401
	 * with a `WWW-Authenticate` header, WITHOUT ever invoking `git
	 * http-backend` — used by `http-transport-auth.test.ts` to prove
	 * `engine.ts`'s credential wiring actually sends the header, not just
	 * that a request without one happens to work. */
	requireAuth?: GitHttpBackendAuthOptions;
	/** Every request actually received, in order — lets a test assert on
	 * headers/paths without needing its own separate capture logic. */
	onRequest?: (req: { method: string; url: string; headers: Record<string, string | string[] | undefined> }) => void;
}

/**
 * Serve `projectRoot` (a directory containing one or more bare repos) over
 * smart HTTP on 127.0.0.1, an ephemeral port. `repoDirName` is the bare
 * repo's directory name directly under `projectRoot` (e.g. "repo.git").
 */
export function startGitHttpBackend(
	projectRoot: string,
	repoDirName: string,
	options?: GitHttpBackendOptions
): Promise<GitHttpBackendHandle> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			options?.onRequest?.({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers });

			if (options?.requireAuth) {
				const expected = `Basic ${Buffer.from(
					`${options.requireAuth.username}:${options.requireAuth.password}`,
					"utf8"
				).toString("base64")}`;
				if (req.headers.authorization !== expected) {
					res.writeHead(401, { "WWW-Authenticate": 'Basic realm="tether-sync test"' });
					res.end("authentication required");
					return;
				}
			}

			handleCgiRequest(req, res, projectRoot).catch((err) => {
				if (!res.headersSent) res.writeHead(500);
				res.end(`internal error: ${(err as Error).message}`);
			});
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}/${repoDirName}`,
				close: () =>
					new Promise<void>((res, rej) => {
						server.close((err) => (err ? rej(err) : res()));
					}),
			});
		});
	});
}

function handleCgiRequest(
	req: IncomingMessage,
	res: ServerResponse,
	projectRoot: string
): Promise<void> {
	return new Promise((resolve, reject) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_PROJECT_ROOT: projectRoot,
			GIT_HTTP_EXPORT_ALL: "1",
			REQUEST_METHOD: req.method ?? "GET",
			PATH_INFO: decodeURIComponent(url.pathname),
			QUERY_STRING: url.search.replace(/^\?/, ""),
			CONTENT_TYPE: req.headers["content-type"] ?? "",
			CONTENT_LENGTH: req.headers["content-length"] ?? "0",
			REMOTE_ADDR: req.socket.remoteAddress ?? "127.0.0.1",
			SERVER_PROTOCOL: "HTTP/1.1",
			GIT_HTTP_PROTOCOL: "0", // don't require protocol v2 upgrade dance
		};

		const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });

		const stderrChunks: Buffer[] = [];
		child.stderr.on("data", (c) => stderrChunks.push(c));

		const outChunks: Buffer[] = [];
		child.stdout.on("data", (c) => outChunks.push(c));

		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0 && outChunks.length === 0) {
				reject(
					new Error(
						`git http-backend exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8")}`
					)
				);
				return;
			}
			try {
				writeCgiResponse(res, Buffer.concat(outChunks));
				resolve();
			} catch (err) {
				reject(err as Error);
			}
		});

		req.pipe(child.stdin);
	});
}

/** Split a raw CGI response (headers, blank line, body) and forward it as a
 * real HTTP response, translating the CGI `Status:` pseudo-header into the
 * real status line. */
function writeCgiResponse(res: ServerResponse, raw: Buffer): void {
	const sep = raw.indexOf("\r\n\r\n");
	const headerEnd = sep !== -1 ? sep : raw.indexOf("\n\n");
	const headerLen = sep !== -1 ? 4 : 2;
	if (headerEnd === -1) {
		res.writeHead(502);
		res.end("malformed CGI response (no header/body separator)");
		return;
	}
	const headerText = raw.subarray(0, headerEnd).toString("utf8");
	const body = raw.subarray(headerEnd + headerLen);

	let status = 200;
	const headers: Record<string, string> = {};
	for (const line of headerText.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const name = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (name.toLowerCase() === "status") {
			status = parseInt(value, 10) || 200;
		} else {
			headers[name] = value;
		}
	}
	res.writeHead(status, headers);
	res.end(body);
}
