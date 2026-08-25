/**
 * The real implementation of `binding.ts`'s `Libgit2Module`/`Libgit2Repository`
 * contract, wrapping the compiled `build/dist/tether-libgit2.{js,wasm}`
 * module's `ccall`/`cwrap` surface.
 *
 * ---------------------------------------------------------------------------
 * What this file is (and is not)
 * ---------------------------------------------------------------------------
 *
 * `binding.ts` is a contract with no implementation; the two prior phases'
 * smoke tests (`tests/libgit2/filter-smoke.test.ts`,
 * `tests/libgit2/asyncify-double-suspension.test.ts`) prove the compiled
 * module works by calling its raw C entry points directly, not through that
 * contract. This file is the missing piece: a real `Libgit2Module`/
 * `Libgit2Repository` implementation, tested against the actual compiled
 * artifact the same way (see `tests/libgit2/engine.test.ts`).
 *
 * As of the engine-cutover phase, `src/git/engine.ts` (the engine the plugin
 * actually runs) wraps `wrapLibgit2Module`/the `Libgit2Module` this file
 * produces — see that file's `createGitEngine` and this directory's README
 * for the cutover's own notes (two real `fs-backend.ts` bugs found and
 * fixed while wiring it in for the first time).
 *
 * ---------------------------------------------------------------------------
 * Memory/ABI discipline (read before adding a new method)
 * ---------------------------------------------------------------------------
 *
 * Every libgit2 out-param that is a fixed-size `git_oid` (20 bytes, this
 * build is SHA-1 only — see `native/engine_shim.c`'s header comment) is
 * handled as raw bytes read directly out of `Module.HEAPU8`/written directly
 * into it via `writeOidHex`/`readOidHex` below — never via `git_oid_tostr`/
 * `git_oid_fromstr` round-trips, since we already have the bytes in hand on
 * one side of every conversion.
 *
 * Anything libgit2 would otherwise hand back as an array of structs
 * (`git_status_entry`, `git_remote_head`, a `git_index_entry` we'd need to
 * build) is instead produced by a small C collector in
 * `native/engine_shim.c` that flattens the data into a JS-trivial-to-parse
 * byte buffer (`[u32][u32 len][bytes]`-shaped records) or does the
 * struct-building itself in C. This file never hardcodes a libgit2 struct
 * offset or size — see `engine_shim.c`'s header comment for why (the real
 * compiler enforces struct layout there against the real, current headers;
 * a hand-copied offset in TS would not be caught by anything if libgit2's
 * layout ever changed).
 *
 * Every ccall goes through the `{ async: true }` path (`ccallAsync` below),
 * even for entry points that never actually suspend — same reasoning as
 * `filter-smoke.test.ts`'s own `ccallAsync` helper: Asyncify may need to
 * suspend for any call that reaches a registered filter or the HTTP
 * transport, and calls that don't suspend just resolve immediately.
 *
 * ---------------------------------------------------------------------------
 * What's implemented vs. explicitly skipped
 * ---------------------------------------------------------------------------
 *
 * Implemented and tested against the real compiled module (see
 * `tests/libgit2/engine.test.ts`): module lifecycle (`init`/`openRepository`/
 * `clone`/`close`), `addRemote`/`setConfig`/`getConfig`, `stagePath`/
 * `unstagePath`/`writeBlobAndStageOid`/`commit`, `resolveRef`/`writeRef`/
 * `currentBranch`, `readBlob`, `status`, `findMergeBase`/`log`, `checkout`,
 * `fetch`/`push`/`listRemoteRefs` (including HTTPS + Basic-auth credentials —
 * see `tests/libgit2/http-transport-auth.test.ts`), `registerGitCryptFilter`/
 * `unregisterGitCryptFilter`, and — this phase — `merge()` and
 * `listPathsWithAttribute()` (see each method's own doc comment above for the
 * full design/citations; both are covered in
 * `tests/libgit2/merge.test.ts`/`tests/libgit2/attribute.test.ts`).
 * `merge()` deliberately never calls the top-level `git_merge()` C entry
 * point — see that method's doc comment for why calling it would risk
 * writing `<<<<<<<` conflict markers into the working tree, which this
 * plugin's safety contract (`binding.ts`'s doc comment on `merge`) forbids.
 *
 * `registerGitCryptFilter`'s hooks already pass the `keyName` argument
 * straight through to `GitCryptFilterHooks.encrypt`/`decrypt` (see below) —
 * this file never hardcoded a single-key assumption; named git-crypt keys
 * (`filter=git-crypt-<keyname>`) were a `native/filter_shim.c` gap (the
 * attribute-matching layer, not this binding), closed in the named-key phase
 * (see `../README.md`'s Phase 7). No changes were needed here to support it.
 */

import {
	type CloneOptions,
	type FetchSummary,
	type GitCryptFilterHooks,
	type InitOptions,
	type Libgit2Author,
	type Libgit2Module,
	type Libgit2Repository,
	Libgit2Error,
	type MergeFileFavor,
	type MergeOutcome,
	type NetworkCallbacks,
	type Oid,
	type PushOptions,
	type RemoteRefInfo,
	type RepoPath,
	type StatusEntry,
} from "./binding";
import {
	basicAuthHeader,
	detectUnsupportedProtocolVersion,
	SmartHttpProtocolError,
	validateSmartHttpResponse,
} from "./http-transport";
import type { RequestUrlLike } from "../http-client";
import type {
	CcallArg,
	CcallArgType,
	NativeModule,
	NativeModuleFactory,
} from "./native-module";

// ---------------------------------------------------------------------------
// libgit2 return-code / enum constants actually branched on below (values
// confirmed against a real download of libgit2 v1.9.6's include/git2/errors.h
// and include/git2/{types,checkout}.h — see native/engine_shim.c's header
// comment and build/BUILD.md for how those headers were obtained for this
// phase).
// ---------------------------------------------------------------------------

const GIT_ENOTFOUND = -3;
const GIT_EEXISTS = -4;
const GIT_EUNBORNBRANCH = -9;
const GIT_OBJECT_COMMIT = 1;
const GIT_CHECKOUT_SAFE = 0;
const GIT_CHECKOUT_FORCE = 2;
/** `git_merge_analysis_t` bits (see `include/git2/merge.h` in a real libgit2
 * v1.9.6 checkout) — confirmed against the real header, not guessed: `NORMAL
 * = 1<<0`, `UP_TO_DATE = 1<<1`, `FASTFORWARD = 1<<2`, `UNBORN = 1<<3`.
 * `UNBORN` is always OR'd together with `FASTFORWARD` (verified by reading
 * `git_merge_analysis_for_ref`'s real implementation in `src/libgit2/merge.c`
 * — an unborn HEAD sets exactly `FASTFORWARD | UNBORN` and returns early), so
 * `merge()` below only ever needs to branch on the `UP_TO_DATE`/`FASTFORWARD`
 * bits directly; `NORMAL` alone (neither of those two bits set) is the real
 * three-way-merge case. */
const GIT_MERGE_ANALYSIS_UP_TO_DATE = 1 << 1;
const GIT_MERGE_ANALYSIS_FASTFORWARD = 1 << 2;
/** `git_merge_file_favor_t` (git2/merge.h). `NORMAL` marks conflicts
 * (default); `UNION` never conflicts at all, concatenating both sides'
 * distinct lines instead — a real behavior change, not a diff-algorithm
 * tuning knob, so it's caller-selected (`MergeFileFavor`) rather than always
 * on. OURS/THEIRS (1/2) aren't exposed at all: this plugin has no use for
 * "silently prefer one side," only "never conflict" (UNION) or "report the
 * conflict" (NORMAL). */
const GIT_MERGE_FILE_FAVOR_NORMAL = 0;
const GIT_MERGE_FILE_FAVOR_UNION = 3;

function mergeFileFavorValue(favor: MergeFileFavor | undefined): number {
	return favor === "union" ? GIT_MERGE_FILE_FAVOR_UNION : GIT_MERGE_FILE_FAVOR_NORMAL;
}
/** Percentage threshold for `GIT_MERGE_FIND_RENAMES` rename detection —
 * matches the real git CLI's own default (`merge.renames`/`diff.renames`
 * effective default), not a value invented for this project. */
const GIT_MERGE_RENAME_THRESHOLD_DEFAULT = 50;
/** Bitmask value `CredentialCallback`'s `allowedTypes` is documented to pass
 * for our HTTPS-token-only case — `GIT_CREDENTIAL_USERPASS_PLAINTEXT` (1).
 * We don't actually read this back from libgit2 (see the header comment on
 * `installHttpDispatch`: credentials are resolved once, up front, in TS, not
 * via libgit2's own `git_credential_acquire_cb` machinery), so this is just
 * the value passed into the callback for interface-shape compatibility. */
const GIT_CREDENTIAL_USERPASS_PLAINTEXT = 1;

const OID_SIZE = 20;

// ---------------------------------------------------------------------------
// Low-level memory / marshaling helpers
// ---------------------------------------------------------------------------

/**
 * Every `ccall` here goes through Asyncify (see this file's header comment),
 * so the return is always a promise. Overloaded per return type rather than
 * typed once as `unknown`: the ~70 call sites below all read the result
 * immediately as a libgit2 return code, and threading a cast through each of
 * them would lose exactly the checking this indirection exists to provide.
 */
function ccallAsync(
	Module: NativeModule,
	name: string,
	returnType: "number",
	argTypes: CcallArgType[],
	args: CcallArg[]
): Promise<number>;
function ccallAsync(
	Module: NativeModule,
	name: string,
	returnType: "string",
	argTypes: CcallArgType[],
	args: CcallArg[]
): Promise<string>;
function ccallAsync(
	Module: NativeModule,
	name: string,
	returnType: null,
	argTypes: CcallArgType[],
	args: CcallArg[]
): Promise<void>;
function ccallAsync(
	Module: NativeModule,
	name: string,
	returnType: "number" | "string" | null,
	argTypes: CcallArgType[],
	args: CcallArg[]
): Promise<number | string | void> {
	if (returnType === "number") {
		return Module.ccall(name, returnType, argTypes, args, { async: true });
	}
	if (returnType === "string") {
		return Module.ccall(name, returnType, argTypes, args, { async: true });
	}
	return Module.ccall(name, returnType, argTypes, args, { async: true });
}

function lastErrorInfo(Module: NativeModule): { message: string; klass: number } {
	// Synchronous, deliberately: git_error_last() reads libgit2's thread-local
	// error state, which the *next* Module call (even a free()) could
	// overwrite — this must run immediately after the failing call, with
	// nothing else in between.
	const ptr = Module.ccall("git_error_last", "number", [], []);
	if (!ptr) return { message: "(no libgit2 error set)", klass: 0 };
	const msgPtr = Module.getValue(ptr, "i32");
	const klass = Module.getValue(ptr + 4, "i32");
	return { message: Module.UTF8ToString(msgPtr), klass };
}

function throwIfError(Module: NativeModule, rc: number, context: string): void {
	if (rc >= 0) return;
	const { message, klass } = lastErrorInfo(Module);
	throw new Libgit2Error(`${context}: ${message} (libgit2 rc=${rc})`, rc, klass);
}

function mallocOutPtr(Module: NativeModule): number {
	return Module._malloc(4);
}

/** Reads a 4-byte scalar written by libgit2 into an out-param slot (either a
 * pointer value, or a 32-bit `size_t` count — both are 4 bytes on this
 * wasm32 build, see engine_shim.c's header comment), then frees the slot
 * itself (NOT whatever the value points to, which the caller frees
 * separately via the matching libgit2 `_free` once done with it). */
function readOutPtr(Module: NativeModule, slotPtr: number): number {
	const value = Module.getValue(slotPtr, "i32");
	Module._free(slotPtr);
	return value;
}

function hexToBytes(hex: string): Uint8Array {
	if (!/^[0-9a-f]{40}$/i.test(hex)) {
		throw new Error(`Libgit2 binding: expected a 40-char hex oid, got '${hex}'`);
	}
	const out = new Uint8Array(OID_SIZE);
	for (let i = 0; i < OID_SIZE; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	return out;
}

function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
	return s;
}

/** Mallocs a 20-byte buffer and writes `hex`'s raw bytes into it. Caller
 * frees. */
function writeOidHex(Module: NativeModule, hex: string): number {
	const ptr = Module._malloc(OID_SIZE);
	Module.HEAPU8.set(hexToBytes(hex), ptr);
	return ptr;
}

/** Reads 20 raw bytes at `ptr` (does NOT free `ptr` — the caller owns that,
 * since `ptr` is frequently a stack-local malloc'd buffer reused for
 * multiple purposes, or a pointer owned by libgit2 itself, e.g.
 * `git_reference_target`'s return value). */
function readOidHex(Module: NativeModule, ptr: number): Oid {
	return bytesToHex(Module.HEAPU8.subarray(ptr, ptr + OID_SIZE));
}

async function freeVoid(Module: NativeModule, fn: string, ptr: number): Promise<void> {
	if (!ptr) return;
	await ccallAsync(Module, fn, null, ["number"], [ptr]);
}

/** Parses the `[20-byte oid][u32 nameLen][name bytes]`-repeated flat format
 * produced by `tether_remote_ls_collect`/`tether_list_refs_with_glob` in
 * native/engine_shim.c. */
function parseOidNameRecords(
	Module: NativeModule,
	bufPtr: number,
	count: number
): Array<{ oidHex: string; name: string }> {
	const results: Array<{ oidHex: string; name: string }> = [];
	if (count === 0 || bufPtr === 0) return results;
	const heap: Uint8Array = Module.HEAPU8;
	const view = new DataView(heap.buffer);
	let offset = bufPtr;
	for (let i = 0; i < count; i++) {
		const oidHex = bytesToHex(heap.subarray(offset, offset + OID_SIZE));
		offset += OID_SIZE;
		const nameLen = view.getUint32(offset, true);
		offset += 4;
		const name = new TextDecoder().decode(heap.subarray(offset, offset + nameLen));
		offset += nameLen;
		results.push({ oidHex, name });
	}
	return results;
}

/** Parses the `[u32 statusFlags][u32 pathLen][path bytes]`-repeated flat
 * format produced by `tether_status_collect` in native/engine_shim.c. */
function parseStatusRecords(Module: NativeModule, bufPtr: number, count: number): StatusEntry[] {
	const entries: StatusEntry[] = [];
	if (count === 0 || bufPtr === 0) return entries;
	const heap: Uint8Array = Module.HEAPU8;
	const view = new DataView(heap.buffer);
	let offset = bufPtr;
	for (let i = 0; i < count; i++) {
		const statusFlags = view.getUint32(offset, true);
		offset += 4;
		const pathLen = view.getUint32(offset, true);
		offset += 4;
		const path = new TextDecoder().decode(heap.subarray(offset, offset + pathLen));
		offset += pathLen;
		entries.push({ path, statusFlags });
	}
	return entries;
}

/** Parses the `[u32 pathLen][path bytes]`-repeated flat format produced by
 * `tether_merge_conflict_paths_collect` in native/engine_shim.c. */
function parsePathRecords(Module: NativeModule, bufPtr: number, count: number): string[] {
	const results: string[] = [];
	if (count === 0 || bufPtr === 0) return results;
	const heap: Uint8Array = Module.HEAPU8;
	const view = new DataView(heap.buffer);
	let offset = bufPtr;
	for (let i = 0; i < count; i++) {
		const len = view.getUint32(offset, true);
		offset += 4;
		const path = new TextDecoder().decode(heap.subarray(offset, offset + len));
		offset += len;
		results.push(path);
	}
	return results;
}

/** Parses the `[u32 pathLen][path bytes][u32 valueLen][value bytes]`-repeated
 * flat format produced by `tether_list_paths_with_attribute` in
 * native/engine_shim.c. */
function parsePathValueRecords(
	Module: NativeModule,
	bufPtr: number,
	count: number
): Array<{ path: RepoPath; value: string }> {
	const results: Array<{ path: RepoPath; value: string }> = [];
	if (count === 0 || bufPtr === 0) return results;
	const heap: Uint8Array = Module.HEAPU8;
	const view = new DataView(heap.buffer);
	let offset = bufPtr;
	const decoder = new TextDecoder();
	for (let i = 0; i < count; i++) {
		const pathLen = view.getUint32(offset, true);
		offset += 4;
		const path = decoder.decode(heap.subarray(offset, offset + pathLen));
		offset += pathLen;
		const valueLen = view.getUint32(offset, true);
		offset += 4;
		const value = decoder.decode(heap.subarray(offset, offset + valueLen));
		offset += valueLen;
		results.push({ path, value });
	}
	return results;
}

// ---------------------------------------------------------------------------
// HTTP transport wiring (production, not the test-only anonymous-HTTP path
// asyncify-double-suspension.test.ts uses)
// ---------------------------------------------------------------------------

/**
 * Installs `Module.__httpDispatch`, the JS half of `native/transport_shim.c`'s
 * `EM_ASYNC_JS` seam (see that file's header comment) — every fetch/push/
 * listRemoteRefs call reinstalls this closure immediately before the network
 * ccall that will use it.
 *
 * CREDENTIAL DESIGN, stated explicitly because it diverges from libgit2's
 * own machinery. libgit2 resolves credentials lazily, mid-transport, via a
 * synchronous C callback (`git_credential_acquire_cb`) that may fire more
 * than once — try anonymous, retry with credentials on 401. Routing that
 * through Asyncify would add a second suspension seam on top of the one
 * `transport_shim.c` already has, an uninvestigated risk.
 *
 * Instead `net.onCredentials` resolves exactly once, up front, before the
 * network call starts, and the resulting Basic-auth header (built via
 * `basicAuthHeader` from `http-transport.ts`) is baked into every request
 * that dispatch closure makes for the rest of the call. So there is no
 * "try anonymous, then retry on 401" loop: credentials go out on the first
 * request whenever `onCredentials` returns any, which is how token auth
 * behaves anyway. A genuine mid-transport retry loop remains a real gap,
 * flagged here rather than silently narrowed.
 */
/**
 * Handle back from `installHttpDispatch` — lets a caller whose `ccallAsync`
 * came back with a negative rc check whether the actual cause was a
 * network-layer failure (see `getLastError`'s doc comment) before falling
 * back to whatever generic message `git_error_last()` happens to report.
 */
interface HttpDispatchHandle {
	getLastError(): string | null;
}

/**
 * The response `Content-Type` libgit2's smart-HTTP state machine expects for
 * a given request — derived here rather than reused from a shared builder,
 * since this dispatch closure only sees the URL/method/request-content-type
 * `native/transport_shim.c` already decided on, not something building a
 * `SmartHttpRequestSpec` from scratch could hand back. `null` means "don't
 * know how to validate this one" (an unrecognized request shape) rather than
 * "anything goes" — callers should skip validation, not treat it as a pass.
 */
function expectedSmartHttpResponseContentType(
	dispatchUrl: string,
	method: string,
	requestContentType: string | null
): string | null {
	if (method === "GET") {
		let service: string | null;
		try {
			service = new URL(dispatchUrl).searchParams.get("service");
		} catch {
			return null;
		}
		return service ? `application/x-${service}-advertisement` : null;
	}
	if (requestContentType?.endsWith("-request")) {
		return requestContentType.replace(/-request$/, "-result");
	}
	return null;
}

async function installHttpDispatch(
	Module: NativeModule,
	requestUrlFn: RequestUrlLike,
	url: string,
	net?: NetworkCallbacks
): Promise<HttpDispatchHandle> {
	let authHeader: string | undefined;
	if (net?.onCredentials) {
		const creds = await net.onCredentials(url, null, GIT_CREDENTIAL_USERPASS_PLAINTEXT);
		if (creds) authHeader = basicAuthHeader(creds);
	}
	let lastError: string | null = null;
	Module.__httpDispatch = async (
		dispatchUrl: string,
		method: string,
		contentType: string | null,
		body: Uint8Array
	) => {
		// DO NOT advertise `Git-Protocol: version=2` here.
		//
		// This previously sent `version=2` on every request, on the premise
		// that libgit2's smart-protocol state machine parses both v0 and v2
		// and the header was "additive". That premise is false, and it broke
		// every sync against any v2-capable server (gitlab.com included):
		//
		//   listRemoteRefs(...): error parsing REF pkt-line (libgit2 rc=-1)
		//
		// libgit2 1.9.6 (see build/versions.env) implements protocol v0 only.
		// The compiled module contains the v0 capability strings (`multi_ack`,
		// `side-band-64k`, `thin-pack`) and none of the v2 request machinery —
		// no `ls-refs`, no `command=ls-refs`. Nothing in this transport or in
		// native/transport_shim.c frames v2 commands either, so there is no
		// layer here that could speak v2 even if the parser managed the
		// advertisement.
		//
		// What actually happened on the wire: asked for v2, GitLab correctly
		// replied with a v2 capability list (`version 2`, `ls-refs=unborn`,
		// `fetch=shallow ...`) and NO refs. libgit2 then tried to read that
		// as v0 ref pkt-lines and failed on the first one. Note the response
		// carries the same `application/x-git-upload-pack-advertisement`
		// content-type in both protocol versions, so the content-type guard
		// below cannot catch this — hence `detectUnsupportedProtocolVersion`.
		//
		// Omitting the header makes every server fall back to v0, which is
		// what this transport actually implements. Revisit only alongside a
		// libgit2 that ships v2 support AND v2 request framing here.
		const headers: Record<string, string> = {};
		if (contentType) headers["Content-Type"] = contentType;
		if (authHeader) headers["Authorization"] = authHeader;
		try {
			const res = await requestUrlFn({
				url: dispatchUrl,
				method,
				headers,
				body: body.byteLength > 0 ? body.slice().buffer : undefined,
				throw: false,
			});
			// Catches the "wrong URL / auth redirect to an HTML login page /
			// non-git HTTP endpoint" failure mode BEFORE handing the body to
			// libgit2's own pkt-line parser: without this, a 2xx response with
			// the wrong content-type (an SSO/proxy/error HTML page instead of the
			// real git advertisement) sails through as if it were valid, and
			// libgit2 fails deep inside its own parser with an opaque "error
			// parsing REF pkt-line" instead of something actionable. Reuses
			// `http-transport.ts`'s `validateSmartHttpResponse` rather than
			// reimplementing it — that helper was already written and
			// unit-tested there but never wired into this production dispatch
			// closure.
			const expectedContentType = expectedSmartHttpResponseContentType(dispatchUrl, method, contentType);
			if (expectedContentType) {
				validateSmartHttpResponse(
					{ method: method as "GET" | "POST", url: dispatchUrl, headers, expectedResponseContentType: expectedContentType },
					{ status: res.status, headers: res.headers ?? {} }
				);
			}
			const responseBody = new Uint8Array(res.arrayBuffer);
			// Same-content-type failure the check above cannot see — see
			// `detectUnsupportedProtocolVersion` and the `Git-Protocol` note
			// at the top of this closure.
			const protocolVersion = detectUnsupportedProtocolVersion(responseBody);
			if (protocolVersion !== null) {
				throw new SmartHttpProtocolError(
					`${dispatchUrl} answered in git wire protocol v${protocolVersion}, but this ` +
						"transport implements v0 only (libgit2 1.9.6 has no v2 support). Halyard Sync " +
						"does not request v2, so the server volunteered it — check for a proxy or " +
						"server policy forcing a protocol version.",
					res.status
				);
			}
			return { status: res.status, body: responseBody };
		} catch (err) {
			// MUST resolve, never reject: `native/transport_shim.c`'s
			// `tether_http_dispatch_js` (an `EM_ASYNC_JS` block) awaits this
			// function directly with no try/catch of its own. Asyncify's
			// resume machinery only drives the suspended WASM stack forward
			// on FULFILLMENT of that await — an uncaught rejection here
			// (a real network failure: a timed-out or reset connection, a
			// proxy/firewall killing the socket, DNS failure, ...) leaves
			// the underlying libgit2 call permanently suspended, which is
			// this plugin's actual "syncing hangs forever" bug, and shows
			// up in the console as an "Uncaught (in promise)" with nothing
			// in this plugin's own code ever seeing it — the real-world
			// symptom that led to this fix. `status: 0` here instead falls
			// straight into `http_stream_read`'s existing
			// `status < 200 || status >= 300` failure path in
			// transport_shim.c, which already frees the response and
			// returns -1 — a real, already-handled error path, not a new
			// one; no native rebuild needed for this fix.
			lastError = err instanceof Error ? err.message : String(err);
			return { status: 0, body: new Uint8Array(0) };
		}
	};
	return {
		getLastError: () => lastError,
	};
}

/**
 * Like `throwIfError`, but for a `ccallAsync` that ran after
 * `installHttpDispatch` — prefers `dispatch`'s captured network-layer
 * message (see `installHttpDispatch`'s doc comment) over whatever
 * `git_error_last()` reports, since the C-side failure path this fix
 * reuses (`status: 0` -> `http_stream_read`'s existing bounds check ->
 * `return -1`) never calls `git_error_set`, so libgit2's own error state at
 * that point is either stale (left over from something unrelated) or
 * simply absent.
 */
function throwIfNetworkError(
	Module: NativeModule,
	rc: number,
	context: string,
	dispatch: HttpDispatchHandle
): void {
	if (rc >= 0) return;
	const dispatchError = dispatch.getLastError();
	if (dispatchError !== null) {
		throw new Libgit2Error(`${context}: ${dispatchError}`, rc);
	}
	throwIfError(Module, rc, context);
}

// ---------------------------------------------------------------------------
// Libgit2Repository
// ---------------------------------------------------------------------------

class Libgit2RepositoryImpl implements Libgit2Repository {
	private index: number | null = null;
	private closed = false;

	constructor(
		private readonly Module: NativeModule,
		private repo: number,
		private readonly requestUrlFn: RequestUrlLike
	) {}

	private assertOpen(): void {
		if (this.closed) throw new Error("Libgit2Repository: method called after close()");
	}

	private async getIndex(): Promise<number> {
		if (this.index !== null) return this.index;
		const slot = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "git_repository_index", "number", ["number", "number"], [
			slot,
			this.repo,
		]);
		const idx = readOutPtr(this.Module, slot);
		throwIfError(this.Module, rc, "git_repository_index");
		this.index = idx;
		return idx;
	}

	// -- remote config -------------------------------------------------------

	async addRemote(name: string, url: string, opts?: { force?: boolean }): Promise<void> {
		this.assertOpen();
		const slot = mallocOutPtr(this.Module);
		let rc = await ccallAsync(this.Module, "git_remote_create", "number", [
			"number",
			"number",
			"string",
			"string",
		], [slot, this.repo, name, url]);
		if (rc === GIT_EEXISTS) {
			Module_free(this.Module, slot);
			if (!opts?.force) throwIfError(this.Module, rc, `addRemote(${name})`);
			rc = await ccallAsync(this.Module, "git_remote_set_url", "number", [
				"number",
				"string",
				"string",
			], [this.repo, name, url]);
			throwIfError(this.Module, rc, `addRemote/set_url(${name})`);
			return;
		}
		throwIfError(this.Module, rc, `addRemote(${name})`);
		const remote = readOutPtr(this.Module, slot);
		await freeVoid(this.Module, "git_remote_free", remote);
	}

	async setConfig(key: string, value: string): Promise<void> {
		this.assertOpen();
		const slot = mallocOutPtr(this.Module);
		let rc = await ccallAsync(this.Module, "git_repository_config", "number", ["number", "number"], [
			slot,
			this.repo,
		]);
		const cfg = readOutPtr(this.Module, slot);
		throwIfError(this.Module, rc, "git_repository_config");
		rc = await ccallAsync(this.Module, "git_config_set_string", "number", [
			"number",
			"string",
			"string",
		], [cfg, key, value]);
		await freeVoid(this.Module, "git_config_free", cfg);
		throwIfError(this.Module, rc, `setConfig(${key})`);
	}

	async getConfig(key: string): Promise<string | null> {
		this.assertOpen();
		// A *snapshot* config (not the live one `setConfig` writes through), by
		// real necessity, not by choice: a real bug found while testing this
		// against the compiled module — `git_config_get_string` on a live
		// config obtained via `git_repository_config` fails outright with
		// "get_string called on a live config object" (libgit2 rc=-1). libgit2
		// only allows reading a string value's `const char*` out of a
		// snapshot, whose backing memory it can guarantee won't mutate under
		// the caller; see `git_repository_config_snapshot`.
		const slot = mallocOutPtr(this.Module);
		let rc = await ccallAsync(this.Module, "git_repository_config_snapshot", "number", [
			"number",
			"number",
		], [slot, this.repo]);
		const cfg = readOutPtr(this.Module, slot);
		throwIfError(this.Module, rc, "git_repository_config_snapshot");

		const outSlot = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "git_config_get_string", "number", [
			"number",
			"number",
			"string",
		], [outSlot, cfg, key]);
		if (rc === GIT_ENOTFOUND) {
			Module_free(this.Module, outSlot);
			await freeVoid(this.Module, "git_config_free", cfg);
			return null;
		}
		throwIfError(this.Module, rc, `getConfig(${key})`);
		const strPtr = readOutPtr(this.Module, outSlot);
		const value = this.Module.UTF8ToString(strPtr);
		await freeVoid(this.Module, "git_config_free", cfg);
		return value;
	}

	// -- gitattributes filter detection --------------------------------------

	/**
	 * Walks every path currently in the index and asks libgit2's real
	 * `.gitattributes`-resolution machinery (`git_attr_get`, via
	 * `tether_list_paths_with_attribute` in native/engine_shim.c — see that
	 * function's doc comment for exactly why a C-side collector, not
	 * per-path `ccall`s, does the walk) which paths resolve `attribute` to a
	 * real string value. Uses `GIT_ATTR_CHECK_INDEX_ONLY` (baked into the
	 * native collector), matching this method's binding.ts doc comment
	 * ("equivalent to walking the index") — the same index-not-working-tree
	 * scope `detectUnsupportedFilters` uses in src/git/engine.ts, as opposed
	 * to its `detectUnsupportedFiltersInWorkingTree` pre-init variant.
	 */
	async listPathsWithAttribute(attribute: string): Promise<Array<{ path: RepoPath; value: string }>> {
		this.assertOpen();
		const index = await this.getIndex();
		const outBuf = mallocOutPtr(this.Module);
		const outCount = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "tether_list_paths_with_attribute", "number", [
			"number",
			"number",
			"string",
			"number",
			"number",
		], [this.repo, index, attribute, outBuf, outCount]);
		if (rc < 0) {
			Module_free(this.Module, outBuf);
			Module_free(this.Module, outCount);
			throwIfError(this.Module, rc, `listPathsWithAttribute(${attribute})`);
		}
		const bufPtr = readOutPtr(this.Module, outBuf);
		const count = readOutPtr(this.Module, outCount);
		const results = parsePathValueRecords(this.Module, bufPtr, count);
		if (bufPtr) Module_free(this.Module, bufPtr);
		return results;
	}

	// -- status ---------------------------------------------------------------

	async status(opts?: { pathspecs?: string[] }): Promise<StatusEntry[]> {
		this.assertOpen();
		const pathspecs = opts?.pathspecs ?? [];
		const stringPtrs: number[] = pathspecs.map((p) => this.Module.stringToNewUTF8(p));
		let arrPtr = 0;
		if (stringPtrs.length > 0) {
			arrPtr = this.Module._malloc(stringPtrs.length * 4);
			stringPtrs.forEach((ptr, i) => this.Module.setValue(arrPtr + i * 4, ptr, "i32"));
		}
		const outBuf = mallocOutPtr(this.Module);
		const outCount = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "tether_status_collect", "number", [
			"number",
			"number",
			"number",
			"number",
			"number",
		], [this.repo, arrPtr, stringPtrs.length, outBuf, outCount]);
		for (const ptr of stringPtrs) Module_free(this.Module, ptr);
		if (arrPtr) Module_free(this.Module, arrPtr);
		throwIfError(this.Module, rc, "status");
		const bufPtr = readOutPtr(this.Module, outBuf);
		const count = readOutPtr(this.Module, outCount);
		const entries = parseStatusRecords(this.Module, bufPtr, count);
		if (bufPtr) Module_free(this.Module, bufPtr);
		return entries;
	}

	// -- staging / commit ------------------------------------------------------

	async stagePath(path: RepoPath): Promise<void> {
		this.assertOpen();
		const index = await this.getIndex();
		let rc = await ccallAsync(this.Module, "git_index_add_bypath", "number", ["number", "string"], [
			index,
			path,
		]);
		throwIfError(this.Module, rc, `stagePath(${path})`);
		rc = await ccallAsync(this.Module, "git_index_write", "number", ["number"], [index]);
		throwIfError(this.Module, rc, `stagePath/index_write(${path})`);
	}

	async unstagePath(path: RepoPath): Promise<void> {
		this.assertOpen();
		const index = await this.getIndex();
		let rc = await ccallAsync(this.Module, "git_index_remove_bypath", "number", ["number", "string"], [
			index,
			path,
		]);
		throwIfError(this.Module, rc, `unstagePath(${path})`);
		rc = await ccallAsync(this.Module, "git_index_write", "number", ["number"], [index]);
		throwIfError(this.Module, rc, `unstagePath/index_write(${path})`);
	}

	async writeBlobAndStageOid(path: RepoPath, content: Uint8Array): Promise<Oid> {
		this.assertOpen();
		const index = await this.getIndex();
		const contentPtr = this.Module._malloc(content.byteLength || 1);
		this.Module.HEAPU8.set(content, contentPtr);
		const outOid = this.Module._malloc(OID_SIZE);
		const rc = await ccallAsync(this.Module, "tether_index_add_blob", "number", [
			"number",
			"number",
			"string",
			"number",
			"number",
			"number",
			"number",
		], [this.repo, index, path, contentPtr, content.byteLength, 0, outOid]);
		Module_free(this.Module, contentPtr);
		if (rc < 0) {
			Module_free(this.Module, outOid);
			throwIfError(this.Module, rc, `writeBlobAndStageOid(${path})`);
		}
		const oid = readOidHex(this.Module, outOid);
		Module_free(this.Module, outOid);
		const writeRc = await ccallAsync(this.Module, "git_index_write", "number", ["number"], [index]);
		throwIfError(this.Module, writeRc, `writeBlobAndStageOid/index_write(${path})`);
		return oid;
	}

	async commit(message: string, author: Libgit2Author): Promise<Oid | null> {
		this.assertOpen();
		const index = await this.getIndex();

		const treeOidPtr = this.Module._malloc(OID_SIZE);
		let rc = await ccallAsync(this.Module, "git_index_write_tree", "number", ["number", "number"], [
			treeOidPtr,
			index,
		]);
		throwIfError(this.Module, rc, "commit/index_write_tree");
		const newTreeHex = readOidHex(this.Module, treeOidPtr);

		// -- Determine the parent (if any) and whether the tree is unchanged. --
		let parentCommitPtr = 0;
		let parentCount = 0;
		let unchanged = false;

		const headSlot = mallocOutPtr(this.Module);
		const headRc = await ccallAsync(this.Module, "git_repository_head", "number", ["number", "number"], [
			headSlot,
			this.repo,
		]);
		if (headRc === GIT_ENOTFOUND || headRc === GIT_EUNBORNBRANCH) {
			Module_free(this.Module, headSlot);
		} else {
			throwIfError(this.Module, headRc, "commit/repository_head");
			const headRef = readOutPtr(this.Module, headSlot);
			const headOidPtr = await ccallAsync(this.Module, "git_reference_target", "number", ["number"], [
				headRef,
			]);
			const headOidCopy = this.Module._malloc(OID_SIZE);
			this.Module.HEAPU8.set(this.Module.HEAPU8.subarray(headOidPtr, headOidPtr + OID_SIZE), headOidCopy);
			await freeVoid(this.Module, "git_reference_free", headRef);

			const parentSlot = mallocOutPtr(this.Module);
			rc = await ccallAsync(this.Module, "git_commit_lookup", "number", ["number", "number", "number"], [
				parentSlot,
				this.repo,
				headOidCopy,
			]);
			Module_free(this.Module, headOidCopy);
			throwIfError(this.Module, rc, "commit/commit_lookup(parent)");
			parentCommitPtr = readOutPtr(this.Module, parentSlot);
			parentCount = 1;

			const parentTreeSlot = mallocOutPtr(this.Module);
			rc = await ccallAsync(this.Module, "git_commit_tree", "number", ["number", "number"], [
				parentTreeSlot,
				parentCommitPtr,
			]);
			throwIfError(this.Module, rc, "commit/commit_tree(parent)");
			const parentTreePtr = readOutPtr(this.Module, parentTreeSlot);
			const parentTreeOidPtr = await ccallAsync(this.Module, "git_tree_id", "number", ["number"], [
				parentTreePtr,
			]);
			const parentTreeHex = readOidHex(this.Module, parentTreeOidPtr);
			await freeVoid(this.Module, "git_tree_free", parentTreePtr);

			unchanged = parentTreeHex === newTreeHex;
		}

		if (unchanged) {
			if (parentCommitPtr) await freeVoid(this.Module, "git_commit_free", parentCommitPtr);
			Module_free(this.Module, treeOidPtr);
			return null;
		}

		const treeSlot = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "git_tree_lookup", "number", ["number", "number", "number"], [
			treeSlot,
			this.repo,
			treeOidPtr,
		]);
		Module_free(this.Module, treeOidPtr);
		throwIfError(this.Module, rc, "commit/tree_lookup");
		const tree = readOutPtr(this.Module, treeSlot);

		const sigSlot = mallocOutPtr(this.Module);
		if (author.time === undefined) {
			rc = await ccallAsync(this.Module, "git_signature_now", "number", [
				"number",
				"string",
				"string",
			], [sigSlot, author.name, author.email]);
		} else {
			// NOTE: git_time_t is a 64-bit C type; this build was never verified
			// against a real, non-integer-overflowing Emscripten ccall marshaling
			// path for a 64-bit *parameter* the way `tether_read_blob_at_path`
			// deliberately avoids for a 64-bit *return* value (see that C
			// function's header comment). Unix timestamps comfortably fit in
			// JS's safe-integer range and ccall's "number" arg marshaling for a
			// plain (non-BigInt) value has worked in every case this phase
			// tested, but this specific explicit-author-time path has NOT been
			// exercised by any test here — see tests/libgit2/engine.test.ts's
			// coverage notes and this file's header "what's implemented" list.
			rc = await ccallAsync(this.Module, "git_signature_new", "number", [
				"number",
				"string",
				"string",
				"number",
				"number",
			], [sigSlot, author.name, author.email, author.time, author.offset ?? 0]);
		}
		throwIfError(this.Module, rc, "commit/signature");
		const sig = readOutPtr(this.Module, sigSlot);

		let parentsArrPtr = 0;
		if (parentCount === 1) {
			parentsArrPtr = this.Module._malloc(4);
			this.Module.setValue(parentsArrPtr, parentCommitPtr, "i32");
		}

		const outOid = this.Module._malloc(OID_SIZE);
		rc = await ccallAsync(this.Module, "git_commit_create", "number", [
			"number",
			"number",
			"string",
			"number",
			"number",
			"string",
			"string",
			"number",
			"number",
			"number",
		], [outOid, this.repo, "HEAD", sig, sig, null, message, tree, parentCount, parentsArrPtr]);

		if (parentsArrPtr) Module_free(this.Module, parentsArrPtr);
		await freeVoid(this.Module, "git_signature_free", sig);
		await freeVoid(this.Module, "git_tree_free", tree);
		if (parentCommitPtr) await freeVoid(this.Module, "git_commit_free", parentCommitPtr);

		if (rc < 0) {
			Module_free(this.Module, outOid);
			throwIfError(this.Module, rc, "commit/commit_create");
		}
		const oid = readOidHex(this.Module, outOid);
		Module_free(this.Module, outOid);
		return oid;
	}

	// -- refs -------------------------------------------------------------

	async resolveRef(ref: string): Promise<Oid | null> {
		this.assertOpen();
		const outPtr = this.Module._malloc(OID_SIZE);
		const rc = await ccallAsync(this.Module, "git_reference_name_to_id", "number", [
			"number",
			"number",
			"string",
		], [outPtr, this.repo, ref]);
		if (rc === GIT_ENOTFOUND) {
			Module_free(this.Module, outPtr);
			return null;
		}
		throwIfError(this.Module, rc, `resolveRef(${ref})`);
		const oid = readOidHex(this.Module, outPtr);
		Module_free(this.Module, outPtr);
		return oid;
	}

	async writeRef(ref: string, oid: Oid, opts?: { force?: boolean }): Promise<void> {
		this.assertOpen();
		const oidPtr = writeOidHex(this.Module, oid);
		const slot = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "git_reference_create", "number", [
			"number",
			"number",
			"string",
			"number",
			"number",
			"string",
		], [slot, this.repo, ref, oidPtr, opts?.force ? 1 : 0, null]);
		Module_free(this.Module, oidPtr);
		if (rc < 0) {
			Module_free(this.Module, slot);
			throwIfError(this.Module, rc, `writeRef(${ref})`);
		}
		const created = readOutPtr(this.Module, slot);
		await freeVoid(this.Module, "git_reference_free", created);
	}

	async currentBranch(): Promise<string | null> {
		this.assertOpen();
		const slot = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "git_repository_head", "number", ["number", "number"], [
			slot,
			this.repo,
		]);
		if (rc === GIT_ENOTFOUND || rc === GIT_EUNBORNBRANCH) {
			Module_free(this.Module, slot);
			return null;
		}
		throwIfError(this.Module, rc, "currentBranch");
		const ref = readOutPtr(this.Module, slot);
		const name = await ccallAsync(this.Module, "git_reference_shorthand", "string", ["number"], [ref]);
		await freeVoid(this.Module, "git_reference_free", ref);
		return name;
	}

	// -- objects ------------------------------------------------------------

	async readBlob(commitOid: Oid, path: RepoPath): Promise<Uint8Array> {
		this.assertOpen();
		const commitPtr = writeOidHex(this.Module, commitOid);
		const outBuf = mallocOutPtr(this.Module);
		const outLen = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "tether_read_blob_at_path", "number", [
			"number",
			"number",
			"string",
			"number",
			"number",
		], [this.repo, commitPtr, path, outBuf, outLen]);
		Module_free(this.Module, commitPtr);
		if (rc < 0) {
			Module_free(this.Module, outBuf);
			Module_free(this.Module, outLen);
			throwIfError(this.Module, rc, `readBlob(${commitOid}, ${path})`);
		}
		const bufPtr = readOutPtr(this.Module, outBuf);
		const len = readOutPtr(this.Module, outLen);
		const out = new Uint8Array(len);
		out.set(this.Module.HEAPU8.subarray(bufPtr, bufPtr + len));
		if (bufPtr) Module_free(this.Module, bufPtr);
		return out;
	}

	async findMergeBase(oidA: Oid, oidB: Oid): Promise<Oid | null> {
		this.assertOpen();
		const aPtr = writeOidHex(this.Module, oidA);
		const bPtr = writeOidHex(this.Module, oidB);
		const outPtr = this.Module._malloc(OID_SIZE);
		const rc = await ccallAsync(this.Module, "git_merge_base", "number", [
			"number",
			"number",
			"number",
			"number",
		], [outPtr, this.repo, aPtr, bPtr]);
		Module_free(this.Module, aPtr);
		Module_free(this.Module, bPtr);
		if (rc === GIT_ENOTFOUND) {
			Module_free(this.Module, outPtr);
			return null;
		}
		throwIfError(this.Module, rc, "findMergeBase");
		const oid = readOidHex(this.Module, outPtr);
		Module_free(this.Module, outPtr);
		return oid;
	}

	async log(ref: string, opts?: { until?: Oid }): Promise<Oid[]> {
		this.assertOpen();
		const startHex = /^[0-9a-f]{40}$/i.test(ref) ? ref : await this.resolveRef(ref);
		if (startHex === null) throw new Libgit2Error(`log: cannot resolve ref '${ref}'`, GIT_ENOTFOUND);

		const startPtr = writeOidHex(this.Module, startHex);
		const untilPtr = opts?.until ? writeOidHex(this.Module, opts.until) : 0;
		const outBuf = mallocOutPtr(this.Module);
		const outCount = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "tether_revwalk_collect", "number", [
			"number",
			"number",
			"number",
			"number",
			"number",
		], [this.repo, startPtr, untilPtr, outBuf, outCount]);
		Module_free(this.Module, startPtr);
		if (untilPtr) Module_free(this.Module, untilPtr);
		if (rc < 0) {
			Module_free(this.Module, outBuf);
			Module_free(this.Module, outCount);
			throwIfError(this.Module, rc, `log(${ref})`);
		}
		const bufPtr = readOutPtr(this.Module, outBuf);
		const count = readOutPtr(this.Module, outCount);
		const oids: Oid[] = [];
		for (let i = 0; i < count; i++) oids.push(readOidHex(this.Module, bufPtr + i * OID_SIZE));
		if (bufPtr) Module_free(this.Module, bufPtr);
		return oids;
	}

	// -- merge / checkout ---------------------------------------------------

	/**
	 * Real merge, built entirely from `git_annotated_commit_from_ref`,
	 * `git_merge_analysis`, and — for the real three-way case —
	 * `git_merge_commits` (an in-memory-only merge, never `git_merge()`
	 * itself). That last choice is deliberate and load-bearing for the
	 * never-write-conflict-markers-into-notes safety property `binding.ts`'s
	 * doc comment on this method calls out, so it's spelled out here:
	 *
	 * The top-level `git_merge()` C entry point (already in
	 * `EXPORTED_FUNCTIONS`, still unused by this file) always ends by calling
	 * `git_checkout_index` against whatever index the merge produced —
	 * including a CONFLICTED one, which is exactly how real git writes
	 * `<<<<<<<`-marker files into the working tree on a real conflict.
	 * Passing `GIT_MERGE_FAIL_ON_CONFLICT` prevents that specific write (the
	 * merge aborts before any checkout, confirmed by reading
	 * `src/libgit2/merge.c`'s real `git_merge()`/`merge_annotated_commits()`
	 * implementation at v1.9.6), but then the failure carries no index to
	 * walk `git_index_conflict_iterator` over at all — so a single call to
	 * `git_merge()` cannot both (a) guarantee no working-tree/index write on
	 * conflict and (b) report which paths conflicted. `git_merge_commits()`
	 * (documented as producing a `git_index` "as-is," never touching the
	 * repository's real index or working directory either way) sidesteps
	 * the tradeoff entirely: it is safe to call unconditionally, and on
	 * conflict its resulting in-memory index is exactly what
	 * `git_index_conflict_iterator` needs, all without the real repository
	 * ever being touched. On a clean merge, this method then does the
	 * tree-write/commit-create/checkout sequence explicitly (mirroring how
	 * `commit()`/`checkout()` above already do their own explicit sequences
	 * rather than delegating to a single opaque libgit2 call) instead of
	 * letting `git_merge()` check out the result itself.
	 *
	 * Uses `git_annotated_commit_from_ref` (not `_lookup`) for `theirs`: this
	 * contract's `theirs` is always a ref name (e.g.
	 * `refs/remotes/<remote>/<branch>`, per `binding.ts`'s doc comment), so
	 * there is always a real `git_reference` to resolve it from — `_lookup`
	 * (by raw oid) is for a caller that only has an oid in hand, which never
	 * applies here. Not used, not a gap: same "explicitly narrower than the
	 * full C API, and why" reporting standard as e.g. `installHttpDispatch`'s
	 * credential-model doc comment.
	 *
	 * ASSUMPTION, matching `commit()`'s own pre-existing one (it
	 * unconditionally uses "HEAD" as `git_commit_create`'s `update_ref`):
	 * `ours` is the ref HEAD currently, symbolically, points at. Every real
	 * caller of `mergeUpstream`-equivalent logic in this plugin checks out
	 * the local branch before merging into it, so this holds in practice;
	 * this method does not independently re-verify it (no new failure mode
	 * beyond what `commit()` already accepts).
	 */
	async merge(
		ours: string,
		theirs: string,
		author: Libgit2Author,
		opts?: { favor?: MergeFileFavor }
	): Promise<MergeOutcome> {
		this.assertOpen();
		const oursFullRef = ours.startsWith("refs/") ? ours : `refs/heads/${ours}`;
		const theirsFullRef = theirs.startsWith("refs/") ? theirs : `refs/heads/${theirs}`;

		// -- Resolve `theirs` to a git_annotated_commit. --------------------
		const theirsRefSlot = mallocOutPtr(this.Module);
		let rc = await ccallAsync(this.Module, "git_reference_lookup", "number", [
			"number",
			"number",
			"string",
		], [theirsRefSlot, this.repo, theirsFullRef]);
		if (rc < 0) {
			Module_free(this.Module, theirsRefSlot);
			throwIfError(this.Module, rc, `merge/reference_lookup(${theirsFullRef})`);
		}
		const theirsRef = readOutPtr(this.Module, theirsRefSlot);

		const theirsAnnotatedSlot = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "git_annotated_commit_from_ref", "number", [
			"number",
			"number",
			"number",
		], [theirsAnnotatedSlot, this.repo, theirsRef]);
		await freeVoid(this.Module, "git_reference_free", theirsRef);
		if (rc < 0) {
			Module_free(this.Module, theirsAnnotatedSlot);
			throwIfError(this.Module, rc, `merge/annotated_commit_from_ref(${theirsFullRef})`);
		}
		const theirsAnnotated = readOutPtr(this.Module, theirsAnnotatedSlot);

		// -- Analyze against HEAD (== `ours`, per this method's assumption). --
		const theirsHeadsArr = this.Module._malloc(4);
		this.Module.setValue(theirsHeadsArr, theirsAnnotated, "i32");
		const analysisSlot = mallocOutPtr(this.Module);
		const preferenceSlot = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "git_merge_analysis", "number", [
			"number",
			"number",
			"number",
			"number",
			"number",
		], [analysisSlot, preferenceSlot, this.repo, theirsHeadsArr, 1]);
		Module_free(this.Module, theirsHeadsArr);
		if (rc < 0) {
			Module_free(this.Module, analysisSlot);
			Module_free(this.Module, preferenceSlot);
			await freeVoid(this.Module, "git_annotated_commit_free", theirsAnnotated);
			throwIfError(this.Module, rc, "merge/merge_analysis");
		}
		const analysis = readOutPtr(this.Module, analysisSlot);
		Module_free(this.Module, preferenceSlot);

		// git_annotated_commit_id returns a pointer OWNED by theirsAnnotated —
		// read it now, before any possible free of theirsAnnotated below.
		const theirsOidPtr = await ccallAsync(this.Module, "git_annotated_commit_id", "number", ["number"], [
			theirsAnnotated,
		]);
		const theirsOid = readOidHex(this.Module, theirsOidPtr);

		if (analysis & GIT_MERGE_ANALYSIS_UP_TO_DATE) {
			await freeVoid(this.Module, "git_annotated_commit_free", theirsAnnotated);
			return { kind: "uptodate" };
		}

		if (analysis & GIT_MERGE_ANALYSIS_FASTFORWARD) {
			await freeVoid(this.Module, "git_annotated_commit_free", theirsAnnotated);
			await this.writeRef(oursFullRef, theirsOid, { force: true });
			await this.checkout(oursFullRef, { force: true });
			return { kind: "fastforward", oid: theirsOid };
		}

		// -- NORMAL: a real three-way merge, entirely in-memory. ------------
		const headSlot = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "git_repository_head", "number", ["number", "number"], [
			headSlot,
			this.repo,
		]);
		if (rc < 0) {
			Module_free(this.Module, headSlot);
			await freeVoid(this.Module, "git_annotated_commit_free", theirsAnnotated);
			throwIfError(this.Module, rc, "merge/repository_head");
		}
		const headRef = readOutPtr(this.Module, headSlot);
		const headOidPtr = await ccallAsync(this.Module, "git_reference_target", "number", ["number"], [
			headRef,
		]);
		const headOidHex = readOidHex(this.Module, headOidPtr);
		await freeVoid(this.Module, "git_reference_free", headRef);

		const ourCommitSlot = mallocOutPtr(this.Module);
		const ourOidPtr = writeOidHex(this.Module, headOidHex);
		rc = await ccallAsync(this.Module, "git_commit_lookup", "number", ["number", "number", "number"], [
			ourCommitSlot,
			this.repo,
			ourOidPtr,
		]);
		Module_free(this.Module, ourOidPtr);
		if (rc < 0) {
			Module_free(this.Module, ourCommitSlot);
			await freeVoid(this.Module, "git_annotated_commit_free", theirsAnnotated);
			throwIfError(this.Module, rc, "merge/commit_lookup(ours)");
		}
		const ourCommit = readOutPtr(this.Module, ourCommitSlot);

		const theirCommitSlot = mallocOutPtr(this.Module);
		const theirsOidPtr2 = writeOidHex(this.Module, theirsOid);
		rc = await ccallAsync(this.Module, "git_commit_lookup", "number", ["number", "number", "number"], [
			theirCommitSlot,
			this.repo,
			theirsOidPtr2,
		]);
		Module_free(this.Module, theirsOidPtr2);
		await freeVoid(this.Module, "git_annotated_commit_free", theirsAnnotated);
		if (rc < 0) {
			Module_free(this.Module, theirCommitSlot);
			await freeVoid(this.Module, "git_commit_free", ourCommit);
			throwIfError(this.Module, rc, "merge/commit_lookup(theirs)");
		}
		const theirCommit = readOutPtr(this.Module, theirCommitSlot);

		// `tether_merge_commits_opts`, not a raw `git_merge_commits` call: a
		// real, non-default `git_merge_options` (rename detection, patience/
		// minimal diff, ignore-whitespace-change) built in C — see that
		// function's header comment in engine_shim.c for why each flag is on
		// and, for `file_favor`, why it deliberately isn't UNION. Same
		// in-memory-only safety property as before: still just produces an
		// index or a negative rc, never touches the repo's real index/working
		// tree either way.
		const indexSlot = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "tether_merge_commits_opts", "number", [
			"number",
			"number",
			"number",
			"number",
			"number",
			"number",
			"number",
			"number",
			"number",
			"number",
		], [
			indexSlot,
			this.repo,
			ourCommit,
			theirCommit,
			1, // find_renames
			GIT_MERGE_RENAME_THRESHOLD_DEFAULT,
			mergeFileFavorValue(opts?.favor),
			1, // diff_patience
			1, // diff_minimal
			1, // ignore_whitespace_change
		]);
		if (rc < 0) {
			Module_free(this.Module, indexSlot);
			await freeVoid(this.Module, "git_commit_free", ourCommit);
			await freeVoid(this.Module, "git_commit_free", theirCommit);
			throwIfError(this.Module, rc, "merge/merge_commits");
		}
		const mergeIndex = readOutPtr(this.Module, indexSlot);

		const hasConflicts = await ccallAsync(this.Module, "git_index_has_conflicts", "number", ["number"], [
			mergeIndex,
		]);

		if (hasConflicts) {
			const outBuf = mallocOutPtr(this.Module);
			const outCount = mallocOutPtr(this.Module);
			rc = await ccallAsync(this.Module, "tether_merge_conflict_paths_collect", "number", [
				"number",
				"number",
				"number",
			], [mergeIndex, outBuf, outCount]);
			if (rc < 0) {
				Module_free(this.Module, outBuf);
				Module_free(this.Module, outCount);
				await freeVoid(this.Module, "git_index_free", mergeIndex);
				await freeVoid(this.Module, "git_commit_free", ourCommit);
				await freeVoid(this.Module, "git_commit_free", theirCommit);
				throwIfError(this.Module, rc, "merge/conflict_paths_collect");
			}
			const bufPtr = readOutPtr(this.Module, outBuf);
			const count = readOutPtr(this.Module, outCount);
			const paths = parsePathRecords(this.Module, bufPtr, count);
			if (bufPtr) Module_free(this.Module, bufPtr);

			// SAFETY: `mergeIndex` is purely in-memory (git_merge_commits never
			// wrote to the repository's real index or working tree, and never
			// will — see this method's header comment). Free it and every
			// other handle and return, without EVER calling git_index_write,
			// git_checkout_*, or git_reference_create — the repository is
			// left byte-for-byte as it was before this call.
			await freeVoid(this.Module, "git_index_free", mergeIndex);
			await freeVoid(this.Module, "git_commit_free", ourCommit);
			await freeVoid(this.Module, "git_commit_free", theirCommit);
			return { kind: "conflict", paths };
		}

		// -- Clean merge: write the tree, create a two-parent commit, then --
		// -- explicitly check it out (mirrors checkout()'s own explicit    --
		// -- git_checkout_tree + git_repository_set_head sequence).        --
		// git_index_write_tree_to (not the 2-arg git_index_write_tree): the
		// in-memory index git_merge_commits produced has no backing
		// repository of its own (it isn't the handle git_repository_index
		// returns), so it must be told explicitly which repo's odb to write
		// the resulting tree objects into.
		const treeOidPtr = this.Module._malloc(OID_SIZE);
		rc = await ccallAsync(this.Module, "git_index_write_tree_to", "number", [
			"number",
			"number",
			"number",
		], [treeOidPtr, mergeIndex, this.repo]);
		await freeVoid(this.Module, "git_index_free", mergeIndex);
		if (rc < 0) {
			Module_free(this.Module, treeOidPtr);
			await freeVoid(this.Module, "git_commit_free", ourCommit);
			await freeVoid(this.Module, "git_commit_free", theirCommit);
			throwIfError(this.Module, rc, "merge/index_write_tree_to");
		}

		const treeSlot = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "git_tree_lookup", "number", ["number", "number", "number"], [
			treeSlot,
			this.repo,
			treeOidPtr,
		]);
		Module_free(this.Module, treeOidPtr);
		if (rc < 0) {
			Module_free(this.Module, treeSlot);
			await freeVoid(this.Module, "git_commit_free", ourCommit);
			await freeVoid(this.Module, "git_commit_free", theirCommit);
			throwIfError(this.Module, rc, "merge/tree_lookup");
		}
		const tree = readOutPtr(this.Module, treeSlot);

		const sigSlot = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "git_signature_now", "number", ["number", "string", "string"], [
			sigSlot,
			author.name,
			author.email,
		]);
		if (rc < 0) {
			Module_free(this.Module, sigSlot);
			await freeVoid(this.Module, "git_tree_free", tree);
			await freeVoid(this.Module, "git_commit_free", ourCommit);
			await freeVoid(this.Module, "git_commit_free", theirCommit);
			throwIfError(this.Module, rc, "merge/signature");
		}
		const sig = readOutPtr(this.Module, sigSlot);

		const parentsArr = this.Module._malloc(8);
		this.Module.setValue(parentsArr, ourCommit, "i32");
		this.Module.setValue(parentsArr + 4, theirCommit, "i32");

		const message = `Merge ${theirsFullRef} into ${ours}`;
		const outOid = this.Module._malloc(OID_SIZE);
		rc = await ccallAsync(this.Module, "git_commit_create", "number", [
			"number",
			"number",
			"string",
			"number",
			"number",
			"string",
			"string",
			"number",
			"number",
			"number",
		], [outOid, this.repo, "HEAD", sig, sig, null, message, tree, 2, parentsArr]);

		Module_free(this.Module, parentsArr);
		await freeVoid(this.Module, "git_signature_free", sig);
		await freeVoid(this.Module, "git_tree_free", tree);
		await freeVoid(this.Module, "git_commit_free", ourCommit);
		await freeVoid(this.Module, "git_commit_free", theirCommit);

		if (rc < 0) {
			Module_free(this.Module, outOid);
			throwIfError(this.Module, rc, "merge/commit_create");
		}
		const mergeOid = readOidHex(this.Module, outOid);
		Module_free(this.Module, outOid);

		await this.checkout(oursFullRef, { force: true });
		return { kind: "merged", oid: mergeOid };
	}

	async checkout(ref: string, opts?: { force?: boolean }): Promise<void> {
		this.assertOpen();
		// `git_reference_name_to_id` (what `resolveRef` wraps) requires a
		// fully-qualified name and returns GIT_EINVALIDSPEC (not GIT_ENOTFOUND)
		// for a bare shorthand like "main" — a real bug found while testing
		// this against the compiled module (checkout("main") threw "the given
		// reference name 'main' is not valid" instead of resolving). Since
		// `checkout`'s contract (unlike `resolveRef`'s) accepts a branch
		// shorthand, so resolve that up front instead of trying the bare name.
		const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
		const oidHex = await this.resolveRef(fullRef);
		if (oidHex === null) throw new Libgit2Error(`checkout: cannot resolve ref '${ref}'`, GIT_ENOTFOUND);

		const oidPtr = writeOidHex(this.Module, oidHex);
		const objSlot = mallocOutPtr(this.Module);
		let rc = await ccallAsync(this.Module, "git_object_lookup", "number", [
			"number",
			"number",
			"number",
			"number",
		], [objSlot, this.repo, oidPtr, GIT_OBJECT_COMMIT]);
		Module_free(this.Module, oidPtr);
		throwIfError(this.Module, rc, `checkout/object_lookup(${ref})`);
		const obj = readOutPtr(this.Module, objSlot);

		const optsPtr = this.Module._malloc(128);
		rc = await ccallAsync(this.Module, "git_checkout_options_init", "number", ["number", "number"], [
			optsPtr,
			1,
		]);
		if (rc < 0) {
			Module_free(this.Module, optsPtr);
			await freeVoid(this.Module, "git_object_free", obj);
			throwIfError(this.Module, rc, "checkout/options_init");
		}
		// `checkout_strategy` is the git_checkout_options struct's second
		// field (right after `version`), verified working against the real
		// compiled module by tests/libgit2/filter-smoke.test.ts before this
		// file existed — see this repo's README for the citation.
		this.Module.setValue(optsPtr + 4, opts?.force ? GIT_CHECKOUT_FORCE : GIT_CHECKOUT_SAFE, "i32");

		rc = await ccallAsync(this.Module, "git_checkout_tree", "number", ["number", "number", "number"], [
			this.repo,
			obj,
			optsPtr,
		]);
		Module_free(this.Module, optsPtr);
		await freeVoid(this.Module, "git_object_free", obj);
		throwIfError(this.Module, rc, `checkout_tree(${ref})`);

		rc = await ccallAsync(this.Module, "git_repository_set_head", "number", ["number", "string"], [
			this.repo,
			fullRef,
		]);
		throwIfError(this.Module, rc, `checkout/set_head(${fullRef})`);
	}

	// -- network ------------------------------------------------------------

	async fetch(remote: string, branch?: string, net?: NetworkCallbacks, depth?: number): Promise<FetchSummary> {
		this.assertOpen();
		const slot = mallocOutPtr(this.Module);
		let rc = await ccallAsync(this.Module, "git_remote_lookup", "number", ["number", "number", "string"], [
			slot,
			this.repo,
			remote,
		]);
		throwIfError(this.Module, rc, `fetch/remote_lookup(${remote})`);
		const remotePtr = readOutPtr(this.Module, slot);

		const remoteUrl = await ccallAsync(this.Module, "git_remote_url", "string", ["number"], [remotePtr]);
		const dispatch = await installHttpDispatch(this.Module, this.requestUrlFn, remoteUrl ?? "", net);

		const refspec = branch ? `+refs/heads/${branch}:refs/remotes/${remote}/${branch}` : null;
		rc = await ccallAsync(this.Module, "tether_remote_fetch", "number", ["number", "string", "number"], [
			remotePtr,
			refspec,
			depth ?? 0,
		]);
		await freeVoid(this.Module, "git_remote_free", remotePtr);
		throwIfNetworkError(this.Module, rc, `fetch(${remote})`, dispatch);

		const glob = branch ? `refs/remotes/${remote}/${branch}` : `refs/remotes/${remote}/*`;
		const outBuf = mallocOutPtr(this.Module);
		const outCount = mallocOutPtr(this.Module);
		rc = await ccallAsync(this.Module, "tether_list_refs_with_glob", "number", [
			"number",
			"string",
			"number",
			"number",
		], [this.repo, glob, outBuf, outCount]);
		throwIfError(this.Module, rc, "fetch/list_refs");
		const bufPtr = readOutPtr(this.Module, outBuf);
		const count = readOutPtr(this.Module, outCount);
		const records = parseOidNameRecords(this.Module, bufPtr, count);
		if (bufPtr) Module_free(this.Module, bufPtr);

		const updatedRefs: Record<string, Oid> = {};
		for (const r of records) updatedRefs[r.name] = r.oidHex;
		return { updatedRefs };
	}

	async push(remote: string, opts?: PushOptions, net?: NetworkCallbacks): Promise<void> {
		this.assertOpen();
		const slot = mallocOutPtr(this.Module);
		let rc = await ccallAsync(this.Module, "git_remote_lookup", "number", ["number", "number", "string"], [
			slot,
			this.repo,
			remote,
		]);
		throwIfError(this.Module, rc, `push/remote_lookup(${remote})`);
		const remotePtr = readOutPtr(this.Module, slot);

		const remoteUrl = await ccallAsync(this.Module, "git_remote_url", "string", ["number"], [remotePtr]);
		const dispatch = await installHttpDispatch(this.Module, this.requestUrlFn, remoteUrl ?? "", net);

		const localRef = opts?.ref ?? (await this.currentBranch());
		if (!localRef) {
			await freeVoid(this.Module, "git_remote_free", remotePtr);
			throw new Libgit2Error("push: no local branch to push (detached/unborn HEAD and no ref given)", GIT_ENOTFOUND);
		}
		const remoteRef = opts?.remoteRef ?? localRef;
		const refspec = `${opts?.force ? "+" : ""}refs/heads/${localRef}:refs/heads/${remoteRef}`;

		rc = await ccallAsync(this.Module, "tether_remote_push", "number", ["number", "string"], [
			remotePtr,
			refspec,
		]);
		await freeVoid(this.Module, "git_remote_free", remotePtr);
		throwIfNetworkError(this.Module, rc, `push(${remote})`, dispatch);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.index !== null) {
			await freeVoid(this.Module, "git_index_free", this.index);
			this.index = null;
		}
		await freeVoid(this.Module, "git_repository_free", this.repo);
	}
}

/** Thin wrapper so every `_free` call site above reads the same regardless of
 * whether the value being freed is a raw pointer or an out-param slot — both
 * are the same `Module._free`, this alias exists purely so call sites read
 * as "free this WASM allocation" without implying async/await is needed
 * (freeing a malloc'd buffer is always synchronous; only libgit2 object
 * destructors that might run cleanup logic go through `freeVoid`/ccall). */
function Module_free(Module: NativeModule, ptr: number): void {
	if (ptr) Module._free(ptr);
}

// ---------------------------------------------------------------------------
// Libgit2Module
// ---------------------------------------------------------------------------

class Libgit2ModuleImpl implements Libgit2Module {
	constructor(
		private readonly Module: NativeModule,
		private readonly requestUrlFn: RequestUrlLike
	) {}

	async init(options: InitOptions): Promise<Libgit2Repository> {
		const slot = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "git_repository_init", "number", [
			"number",
			"string",
			"number",
		], [slot, options.dir, 0]);
		throwIfError(this.Module, rc, `init(${options.dir})`);
		const repo = readOutPtr(this.Module, slot);
		if (options.defaultBranch) {
			const headRc = await ccallAsync(this.Module, "git_repository_set_head", "number", [
				"number",
				"string",
			], [repo, `refs/heads/${options.defaultBranch}`]);
			throwIfError(this.Module, headRc, "init/set_head");
		}
		return new Libgit2RepositoryImpl(this.Module, repo, this.requestUrlFn);
	}

	async openRepository(dir: string): Promise<Libgit2Repository> {
		const slot = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "git_repository_open", "number", ["number", "string"], [
			slot,
			dir,
		]);
		throwIfError(this.Module, rc, `openRepository(${dir})`);
		return new Libgit2RepositoryImpl(this.Module, readOutPtr(this.Module, slot), this.requestUrlFn);
	}

	async clone(options: CloneOptions, net?: NetworkCallbacks): Promise<Libgit2Repository> {
		const remoteName = options.remote ?? "origin";
		const repo = (await this.init({ dir: options.dir })) as Libgit2RepositoryImpl;
		try {
			await repo.addRemote(remoteName, options.url);
			const branchForFetch = options.singleBranch ? options.ref : undefined;
			const summary = await repo.fetch(remoteName, branchForFetch, net, options.depth);

			let targetBranch = options.ref;
			if (!targetBranch) {
				const names = Object.keys(summary.updatedRefs).map((r) => r.split("/").pop() ?? r);
				targetBranch =
					names.find((n) => n === "main") ?? names.find((n) => n === "master") ?? names[0];
			}
			if (!targetBranch) {
				throw new Libgit2Error("clone: remote advertised no branches to check out", GIT_ENOTFOUND);
			}

			const remoteRefName = `refs/remotes/${remoteName}/${targetBranch}`;
			const oid = summary.updatedRefs[remoteRefName] ?? (await repo.resolveRef(remoteRefName));
			if (!oid) {
				throw new Libgit2Error(
					`clone: could not resolve ${remoteRefName} after fetch`,
					GIT_ENOTFOUND
				);
			}
			await repo.writeRef(`refs/heads/${targetBranch}`, oid, { force: true });
			await repo.checkout(`refs/heads/${targetBranch}`, { force: true });
			return repo;
		} catch (err) {
			await repo.close();
			throw err;
		}
	}

	async listRemoteRefs(url: string, prefix: string, net?: NetworkCallbacks): Promise<RemoteRefInfo[]> {
		const dispatch = await installHttpDispatch(this.Module, this.requestUrlFn, url, net);
		const outBuf = mallocOutPtr(this.Module);
		const outCount = mallocOutPtr(this.Module);
		const rc = await ccallAsync(this.Module, "tether_remote_ls_collect", "number", [
			"string",
			"number",
			"number",
		], [url, outBuf, outCount]);
		throwIfNetworkError(this.Module, rc, `listRemoteRefs(${url})`, dispatch);
		const bufPtr = readOutPtr(this.Module, outBuf);
		const count = readOutPtr(this.Module, outCount);
		const records = parseOidNameRecords(this.Module, bufPtr, count);
		if (bufPtr) Module_free(this.Module, bufPtr);
		return records
			.filter((r) => r.name.startsWith(prefix))
			.map((r) => ({ ref: r.name, oid: r.oidHex }));
	}

	async registerGitCryptFilter(hooks: GitCryptFilterHooks): Promise<void> {
		this.Module.__gitcryptEncrypt = (keyName: string, pt: Uint8Array) => hooks.encrypt(keyName, pt);
		this.Module.__gitcryptDecrypt = (keyName: string, ct: Uint8Array) => hooks.decrypt(keyName, ct);
		const rc = await ccallAsync(this.Module, "tether_register_gitcrypt_filter", "number", [], []);
		throwIfError(this.Module, rc, "registerGitCryptFilter");
	}

	async unregisterGitCryptFilter(): Promise<void> {
		const rc = await ccallAsync(this.Module, "tether_unregister_gitcrypt_filter", "number", [], []);
		delete this.Module.__gitcryptEncrypt;
		delete this.Module.__gitcryptDecrypt;
		throwIfError(this.Module, rc, "unregisterGitCryptFilter");
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The compiled module's factory function shape (Emscripten's
 * `-sMODULARIZE=1 -sEXPORT_NAME=TetherLibgit2` output — see build/BUILD.md).
 * Its module surface is declared in `native-module.ts`. */
export type Libgit2ModuleFactory = NativeModuleFactory;

export interface Libgit2EngineOptions {
	/** The real `requestUrl`-shaped function every network operation is
	 * routed through — see `installHttpDispatch`'s header comment. */
	requestUrl: RequestUrlLike;
}

/**
 * Wraps an ALREADY-INSTANTIATED compiled module (i.e. `factory()` has
 * already resolved) — the seam that lets a caller mount a filesystem backend
 * (`Module.FS.mount(...)`, e.g. NODEFS in tests, or the classic-FS
 * `VaultMirror` glue in `fs-backend.ts` for production) on the raw `Module`
 * BEFORE any libgit2 call touches a path under that mount, which
 * `createLibgit2Module` below can't support since it only ever hands back
 * the opaque `Libgit2Module`/`Libgit2Repository` wrapper (deliberately, per
 * `binding.ts`'s header comment: no native handle ever leaks into this
 * contract). Calls `git_libgit2_init` and registers the HTTPS-capable smart
 * transport, same as `createLibgit2Module`.
 */
export async function wrapLibgit2Module(
	m: NativeModule,
	options: Libgit2EngineOptions
): Promise<Libgit2Module> {
	let rc = await ccallAsync(m, "git_libgit2_init", "number", [], []);
	if (rc < 0) throwIfError(m, rc, "git_libgit2_init");
	rc = await ccallAsync(m, "tether_register_http_transport", "number", [], []);
	if (rc < 0) throwIfError(m, rc, "tether_register_http_transport");
	return new Libgit2ModuleImpl(m, options.requestUrl);
}

/**
 * Loads the compiled module via `factory`, calls `git_libgit2_init`, and
 * registers the (production, HTTPS-capable) custom smart-HTTP transport —
 * see `native/transport_shim.c`'s `tether_register_http_transport`, which
 * this phase extended to register under both `http` and `https` schemes.
 *
 * Use `wrapLibgit2Module` directly instead when the caller needs to mount a
 * filesystem backend on the raw module before any git call runs (see that
 * function's header comment) — this function is the convenience path for
 * when the module's default filesystem (whatever `factory()` already set up)
 * is sufficient.
 */
export async function createLibgit2Module(
	factory: Libgit2ModuleFactory,
	options: Libgit2EngineOptions
): Promise<Libgit2Module> {
	const Module = await factory();
	return wrapLibgit2Module(Module, options);
}
