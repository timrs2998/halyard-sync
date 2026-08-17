/**
 * Shared HTTP-request helpers for the real libgit2 smart-HTTP transport
 * (`native/transport_shim.c` + `libgit2/engine.ts`'s `installHttpDispatch`).
 *
 * The actual smart-HTTP subtransport (request framing per action, buffered
 * request/response streaming) is hand-written C, registered directly with
 * libgit2 (`git_transport_register`) — not implemented here. This file holds
 * only the two pieces of that dispatch path that ARE real TypeScript, reused
 * rather than reimplemented in C:
 *
 * - `basicAuthHeader`: builds the `Authorization: Basic ...` header
 *   `installHttpDispatch` bakes into every request for a fetch/push/
 *   listRemoteRefs call once (see that function's own doc comment).
 * - `validateSmartHttpResponse`: catches the "wrong URL / auth redirect to
 *   an HTML login page / non-git HTTP endpoint" failure mode — a 2xx
 *   response with the wrong content-type — before the body reaches
 *   libgit2's own pkt-line parser, which would otherwise fail deep inside
 *   with an opaque low-level error instead of an actionable one.
 *
 * An earlier phase scaffolded a full pure-TS smart-HTTP subtransport here
 * (request building per `git_smart_service_t` action, a buffered
 * `git_smart_subtransport_stream` equivalent, an integer-handle registry for
 * a future WASM-boundary binding) as a JS-side target for C glue that was
 * never written — the phase that actually wired the transport into the
 * compiled module went straight to hand-written C instead
 * (`native/transport_shim.c`), so that scaffolding was never called by
 * anything and was removed. It's recoverable from git history if a future
 * phase wants to route the C transport's request-framing through JS instead
 * of duplicating it there.
 */

export interface SmartHttpCredentials {
	username: string;
	password: string;
}

export function basicAuthHeader(credentials: SmartHttpCredentials): string {
	// Consistent with the rest of the bundle's Buffer availability story
	// (DESIGN.md's polyfill-buffer.js gotcha: a global `Buffer` is expected
	// to work on both desktop and mobile once bundled).
	const raw = `${credentials.username}:${credentials.password}`;
	return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export interface SmartHttpRequestSpec {
	method: "GET" | "POST";
	url: string;
	headers: Record<string, string>;
	/** Expected `Content-Type` of a well-formed response, checked by
	 * `validateSmartHttpResponse` — this is the same check libgit2's own
	 * `http.c` performs, since a misconfigured server (or a redirect to an
	 * HTML login page instead of the git endpoint — the classic "wrong URL"
	 * failure mode) responds 200 with the wrong content type, and silently
	 * treating that body as pkt-lines produces a confusing low-level parse
	 * error instead of an actionable one. */
	expectedResponseContentType: string;
}

export class SmartHttpProtocolError extends Error {
	constructor(
		message: string,
		readonly statusCode: number
	) {
		super(message);
		this.name = "SmartHttpProtocolError";
	}
}

/**
 * Validate a response against what `spec` expected. Content-type comparison
 * strips any `; charset=...` suffix and is case-insensitive on the media
 * type, matching how header values are actually compared in practice (git
 * servers are not perfectly consistent about casing/parameters here).
 */
export function validateSmartHttpResponse(
	spec: SmartHttpRequestSpec,
	response: { status: number; headers: Record<string, string> }
): void {
	if (response.status < 200 || response.status >= 300) {
		throw new SmartHttpProtocolError(
			`Unexpected HTTP status ${response.status} for ${spec.method} ${spec.url}`,
			response.status
		);
	}
	const contentTypeHeader =
		response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";
	const mediaType = contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
	if (mediaType !== spec.expectedResponseContentType.toLowerCase()) {
		throw new SmartHttpProtocolError(
			`Expected content-type '${spec.expectedResponseContentType}' for ${spec.method} ` +
				`${spec.url}, got '${contentTypeHeader || "(missing)"}' — likely wrong URL, ` +
				"an auth redirect to an HTML login page, or a non-git HTTP endpoint.",
			response.status
		);
	}
}

/**
 * Detects a smart-HTTP response written in a git wire protocol newer than the
 * v0 this transport implements, returning the version or `null`.
 *
 * `validateSmartHttpResponse` structurally cannot catch this: a v0 and a v2
 * advertisement carry the *same* `application/x-git-upload-pack-advertisement`
 * content-type, and differ only in the body. A v2 body opens with the service
 * pkt, a flush, then a `version 2` pkt-line and a capability list, with no refs
 * at all — so libgit2's v0 parser hits `version 2` where it wants
 * `<oid> <refname>` and dies with "error parsing REF pkt-line", which says
 * nothing about the real cause.
 *
 * v0 never sends a version pkt-line, so finding one at all above v1 is
 * unambiguous. `libgit2/engine.ts` deliberately does not advertise v2, so
 * reaching this means a server volunteered it anyway.
 */
export function detectUnsupportedProtocolVersion(body: Uint8Array): number | null {
	// Hand-rolled ASCII decode of just the head: pkt-line framing and
	// capability names are ASCII by definition, and this avoids depending on
	// TextDecoder being present in every runtime this bundle targets.
	const limit = Math.min(body.length, 256);
	let head = "";
	for (let i = 0; i < limit; i++) head += String.fromCharCode(body[i]);

	// A pkt-line is a 4-hex-digit length prefix followed by its payload.
	const match = /[0-9a-f]{4}version (\d+)/.exec(head);
	if (match === null) return null;
	const version = Number(match[1]);
	return Number.isFinite(version) && version >= 2 ? version : null;
}
