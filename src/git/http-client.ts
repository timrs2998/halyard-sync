/**
 * Structural types for Obsidian's `requestUrl`, shared by the libgit2
 * binding's HTTP transport wiring (`libgit2/engine.ts`'s
 * `installHttpDispatch`, `libgit2/http-transport.ts`) and the WASM loader
 * (`libgit2/loader.ts`).
 *
 * `requestUrl` goes through the native layer on both Electron and Capacitor,
 * so it bypasses CORS — no proxy needed. The trade-off is that it buffers
 * whole request/response bodies (no streaming), which is acceptable because
 * we clone shallow.
 *
 * The libgit2 binding talks to `requestUrl` directly — it already matches
 * `RequestUrlLike` structurally, so no adapter class is needed. See
 * `main.ts`'s `loadEngineModule`.
 */

/** Structural subset of Obsidian's RequestUrlParam. */
export interface RequestUrlLikeParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}

/** Structural subset of Obsidian's RequestUrlResponse. */
export interface RequestUrlLikeResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
}

export type RequestUrlLike = (
	param: RequestUrlLikeParam
) => PromiseLike<RequestUrlLikeResponse>;

/**
 * Wraps a `RequestUrlLike` with a hard timeout: if the underlying call
 * hasn't settled within `getTimeoutMs()` (checked fresh on every call, so a
 * live settings change takes effect on the very next request — no engine
 * rebuild needed), the returned promise rejects with a message containing
 * "timed out", which `git/engine.ts`'s `describeGitError` already
 * recognizes as a network error via its existing pattern match (no new
 * translation case needed).
 *
 * This does NOT cancel the underlying request — `requestUrl` exposes no
 * abort mechanism, so the real connection may still be sitting open in the
 * background after we stop waiting on it. What it does fix: a silent
 * indefinite hang (e.g. a proxy that accepts the connection but never
 * sends a response — the reported symptom behind adding this at all)
 * previously left `requestUrl`'s promise unsettled forever, which meant
 * "syncing" never left that state. `getTimeoutMs() <= 0` disables the
 * timeout for that call (pass-through).
 */
export function withRequestTimeout(
	requestUrlFn: RequestUrlLike,
	getTimeoutMs: () => number
): RequestUrlLike {
	return (param) => {
		const timeoutMs = getTimeoutMs();
		if (timeoutMs <= 0) return Promise.resolve(requestUrlFn(param));
		return new Promise<RequestUrlLikeResponse>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				reject(
					new Error(
						`Request to ${param.url} timed out after ${timeoutMs}ms — this often means ` +
							"a proxy or firewall is silently dropping the connection rather than " +
							"returning an error. Increase the timeout, or check your network's " +
							"proxy settings, in Halyard Sync's Advanced settings."
					)
				);
			}, timeoutMs);
			Promise.resolve(requestUrlFn(param)).then(
				(res) => {
					window.clearTimeout(timer);
					resolve(res);
				},
				(err: unknown) => {
					window.clearTimeout(timer);
					// requestUrl rejects with whatever the platform layer threw,
					// which is not guaranteed to be an Error — normalize so
					// callers can always read `.message`.
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			);
		});
	};
}

export interface RequestLogEntry {
	url: string;
	method: string;
	/** Null when the request threw/rejected instead of resolving. */
	status: number | null;
	durationMs: number;
	/** Non-null exactly when `status` is null. */
	error: string | null;
}

/**
 * Wraps a `RequestUrlLike` to report basic per-request diagnostics via
 * `onLog` — URL, method, status, and timing only, NEVER headers or bodies,
 * so an Authorization header (a bearer PAT) can never end up in a log this
 * way. `onLog` is called unconditionally on every request; callers (see
 * `main.ts`) decide whether to actually log by reading their own live
 * settings flag inside it — keeps the on/off toggle instant, same reason
 * `withRequestTimeout` re-reads its getter every call instead of baking in
 * a snapshot.
 */
export function withRequestLogging(
	requestUrlFn: RequestUrlLike,
	onLog: (entry: RequestLogEntry) => void
): RequestUrlLike {
	return async (param) => {
		const start = Date.now();
		const method = param.method ?? "GET";
		try {
			const res = await requestUrlFn(param);
			onLog({ url: param.url, method, status: res.status, durationMs: Date.now() - start, error: null });
			return res;
		} catch (err) {
			onLog({
				url: param.url,
				method,
				status: null,
				durationMs: Date.now() - start,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	};
}
