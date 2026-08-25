/*
 * transport_shim.c — a custom libgit2 git_smart_subtransport bridging one
 * real HTTP request/response round-trip to JS via Asyncify (EM_ASYNC_JS),
 * exactly the way `../http-transport.ts`'s header comment describes
 * (buffered request in, whole-body response out, Asyncify scoped to the
 * dispatch point only).
 *
 * =============================================================================
 * WHY THIS FILE EXISTS: this is test-only infrastructure written specifically
 * to answer BUILD.md's single biggest open question — whether a real,
 * single top-level libgit2 call (fetch+checkout, as `git_clone` itself
 * does) can trigger BOTH the transport's Asyncify suspension (this file)
 * AND the git-crypt filter's Asyncify suspension (`filter_shim.c`) without
 * violating Asyncify's "no nested async start" rule. It is deliberately
 * minimal: only enough of the smart-HTTP subtransport contract to make a
 * real `git_remote_fetch` against a real `git http-backend` succeed, not a
 * production-grade transport (no auth, no redirects, no proxy support —
 * `../http-transport.ts`'s pure-TS helpers already cover the request-
 * framing/validation logic a production version would reuse; this C side
 * is what's still missing per that file's own "what's real vs scaffolded"
 * note, and remains scaffolding beyond what this test exercises).
 * =============================================================================
 *
 * See native/filter_shim.c's header comment for the general EM_ASYNC_JS/
 * Asyncify mechanism explanation — not repeated here.
 */

#include <stdlib.h>
#include <string.h>

#include <emscripten.h>
#include <git2.h>
#include <git2/sys/transport.h>

/* One full HTTP round-trip: method + url + optional body in, whole response
 * body + status out. `Module.__httpDispatch` must be installed by the
 * caller (test harness) before any fetch that reaches this transport runs —
 * see tests/libgit2/asyncify-double-suspension.test.ts. */
EM_ASYNC_JS(uint8_t *, halyard_http_dispatch_js, (
	const char *url,
	const char *method,
	const char *content_type,
	const uint8_t *body,
	size_t body_len,
	size_t *out_len,
	int *out_status
), {
	if (!Module.__httpDispatch) {
		throw new Error("halyard_http_dispatch_js: Module.__httpDispatch is not installed");
	}
	var urlStr = UTF8ToString(url);
	var methodStr = UTF8ToString(method);
	var contentTypeStr = content_type ? UTF8ToString(content_type) : null;
	var bodyBytes = body_len > 0 ? HEAPU8.slice(body, body + body_len) : new Uint8Array(0);
	var result = await Module.__httpDispatch(urlStr, methodStr, contentTypeStr, bodyBytes);
	var respBytes = result.body instanceof Uint8Array ? result.body : new Uint8Array(result.body);
	var ptr = _malloc(respBytes.byteLength || 1);
	HEAPU8.set(respBytes, ptr);
	setValue(out_len, respBytes.byteLength, "i32");
	setValue(out_status, result.status, "i32");
	return ptr;
});

/* ---------------------------------------------------------------------------
 * Buffered request/response stream, one per action() call — mirrors
 * ../http-transport.ts's SmartHttpStream (write buffers the request body,
 * the first read() triggers the one real dispatch, subsequent reads drain
 * the already-fetched response).
 * ---------------------------------------------------------------------------
 */

typedef struct {
	git_smart_subtransport_stream parent; /* MUST be first member (see
	                                        * filter_shim.c's identical note
	                                        * on this libgit2 convention). */
	char *url;
	char *content_type; /* NULL for GET/discovery */
	uint8_t *write_buf;
	size_t write_len;
	size_t write_cap;
	uint8_t *read_buf;
	size_t read_len;
	size_t read_cursor;
	int dispatched;
} halyard_http_stream;

static int buf_append(uint8_t **buf, size_t *len, size_t *cap, const char *data, size_t add) {
	if (*len + add > *cap) {
		size_t new_cap = *cap == 0 ? 4096 : *cap;
		while (new_cap < *len + add) new_cap *= 2;
		uint8_t *grown = (uint8_t *)realloc(*buf, new_cap);
		if (grown == NULL) return -1;
		*buf = grown;
		*cap = new_cap;
	}
	memcpy(*buf + *len, data, add);
	*len += add;
	return 0;
}

static int http_stream_write(git_smart_subtransport_stream *stream, const char *buffer, size_t len) {
	halyard_http_stream *s = (halyard_http_stream *)stream;
	return buf_append(&s->write_buf, &s->write_len, &s->write_cap, buffer, len);
}

static int http_stream_read(
	git_smart_subtransport_stream *stream,
	char *buffer,
	size_t buf_size,
	size_t *bytes_read) {
	halyard_http_stream *s = (halyard_http_stream *)stream;

	if (!s->dispatched) {
		size_t out_len = 0;
		int status = 0;
		const char *method = s->content_type != NULL ? "POST" : "GET";
		uint8_t *resp = halyard_http_dispatch_js(
			s->url, method, s->content_type,
			s->write_len > 0 ? s->write_buf : NULL, s->write_len,
			&out_len, &status);
		if (resp == NULL) return -1;
		if (status < 200 || status >= 300) {
			free(resp);
			return -1;
		}
		s->read_buf = resp;
		s->read_len = out_len;
		s->read_cursor = 0;
		s->dispatched = 1;
	}

	size_t remaining = s->read_len - s->read_cursor;
	size_t n = remaining < buf_size ? remaining : buf_size;
	if (n > 0) memcpy(buffer, s->read_buf + s->read_cursor, n);
	s->read_cursor += n;
	*bytes_read = n;
	return 0;
}

static void http_stream_free(git_smart_subtransport_stream *stream) {
	halyard_http_stream *s = (halyard_http_stream *)stream;
	free(s->url);
	free(s->content_type);
	free(s->write_buf);
	free(s->read_buf);
	free(s);
}

/* ---------------------------------------------------------------------------
 * The subtransport itself
 * ---------------------------------------------------------------------------
 */

typedef struct {
	git_smart_subtransport parent;
} halyard_http_subtransport;

static int subtransport_action(
	git_smart_subtransport_stream **out,
	git_smart_subtransport *transport,
	const char *url,
	git_smart_service_t action) {
	(void)transport;

	halyard_http_stream *s = (halyard_http_stream *)calloc(1, sizeof(halyard_http_stream));
	if (s == NULL) return -1;
	s->parent.subtransport = transport;
	s->parent.read = http_stream_read;
	s->parent.write = http_stream_write;
	s->parent.free = http_stream_free;

	const char *suffix;
	const char *content_type = NULL;
	switch (action) {
		case GIT_SERVICE_UPLOADPACK_LS:
			suffix = "/info/refs?service=git-upload-pack";
			break;
		case GIT_SERVICE_UPLOADPACK:
			suffix = "/git-upload-pack";
			content_type = "application/x-git-upload-pack-request";
			break;
		case GIT_SERVICE_RECEIVEPACK_LS:
			suffix = "/info/refs?service=git-receive-pack";
			break;
		case GIT_SERVICE_RECEIVEPACK:
		default:
			suffix = "/git-receive-pack";
			content_type = "application/x-git-receive-pack-request";
			break;
	}

	size_t base_len = strlen(url);
	while (base_len > 0 && url[base_len - 1] == '/') base_len--;
	size_t suffix_len = strlen(suffix);
	char *full_url = (char *)malloc(base_len + suffix_len + 1);
	if (full_url == NULL) {
		free(s);
		return -1;
	}
	memcpy(full_url, url, base_len);
	memcpy(full_url + base_len, suffix, suffix_len + 1);
	s->url = full_url;
	s->content_type = content_type != NULL ? strdup(content_type) : NULL;

	*out = (git_smart_subtransport_stream *)s;
	return 0;
}

static int subtransport_close(git_smart_subtransport *transport) {
	(void)transport;
	return 0;
}

static void subtransport_free(git_smart_subtransport *transport) {
	free(transport);
}

static int subtransport_create(git_smart_subtransport **out, git_transport *owner, void *param) {
	(void)owner;
	(void)param;
	halyard_http_subtransport *t = (halyard_http_subtransport *)calloc(1, sizeof(halyard_http_subtransport));
	if (t == NULL) return -1;
	t->parent.action = subtransport_action;
	t->parent.close = subtransport_close;
	t->parent.free = subtransport_free;
	*out = (git_smart_subtransport *)t;
	return 0;
}

static git_smart_subtransport_definition halyard_http_definition = {
	subtransport_create,
	1, /* rpc: stateless request/response, like real HTTP */
	NULL
};

/* Registers the same subtransport for BOTH "http" and "https" — added when
 * this file grew a real production caller (engine.ts's fetch/push): libgit2
 * dispatches purely on URL scheme to find a registered transport, and this
 * build's libgit2 has no built-in https transport at all (USE_HTTPS=OFF, see
 * build.sh's CMake option comment — no TLS library exists to link into a
 * WASM build). There is no TLS termination happening in this C shim either
 * way: same as `../http-transport.ts`'s header comment says, `requestUrl`
 * (Obsidian's real HTTP client, injected into `Module.__httpDispatch` by
 * `engine.ts`) is the only thing that ever actually opens a socket/TLS
 * connection — this file only decides "what request to build for this
 * action" and hands the resulting bytes to whatever JS function is
 * installed, regardless of whether the URL said http or https. Registering
 * both schemes under the identical definition is therefore correct, not a
 * shortcut: the scheme only ever affects what string gets embedded in the
 * URL AND (in engine.ts, not here) how the credential/basic-auth header is
 * decided to apply, never how this C code behaves. */
EMSCRIPTEN_KEEPALIVE
int halyard_register_http_transport(void) {
	int rc = git_transport_register("http", git_transport_smart, &halyard_http_definition);
	if (rc < 0 && rc != GIT_EEXISTS) return rc;
	rc = git_transport_register("https", git_transport_smart, &halyard_http_definition);
	if (rc < 0 && rc != GIT_EEXISTS) return rc;
	return 0;
}

EMSCRIPTEN_KEEPALIVE
int halyard_unregister_http_transport(void) {
	int rc1 = git_transport_unregister("http");
	int rc2 = git_transport_unregister("https");
	if (rc1 < 0) return rc1;
	if (rc2 < 0) return rc2;
	return 0;
}

/* ---------------------------------------------------------------------------
 * The Asyncify double-suspension probe itself: ONE top-level libgit2 call
 * (one JS -> C entry, no return to JS in between) that performs a real
 * fetch (transport Asyncify, above) immediately followed by a checkout that
 * may smudge a git-crypt-filtered file (filter Asyncify, filter_shim.c) —
 * see BUILD.md for why this specific shape (not two separate top-level
 * ccalls) is required to actually exercise the flagged risk.
 * ---------------------------------------------------------------------------
 */

EMSCRIPTEN_KEEPALIVE
int halyard_test_clone_and_checkout(const char *url, const char *dest, char *commit_oid_hex_out) {
	git_repository *repo = NULL;
	git_remote *remote = NULL;
	git_object *head_commit = NULL;
	git_oid head_oid;
	int rc;

	rc = git_repository_init(&repo, dest, 0);
	if (rc < 0) return rc;

	rc = git_remote_create(&remote, repo, "origin", url);
	if (rc < 0) goto done;

	/* --- Asyncify suspension #1: transport dispatch, possibly more than
	 * once (discovery + upload-pack), all within this one call. --- */
	rc = git_remote_fetch(remote, NULL, NULL, NULL);
	if (rc < 0) goto done;

	rc = git_reference_name_to_id(&head_oid, repo, "refs/remotes/origin/main");
	if (rc < 0) {
		rc = git_reference_name_to_id(&head_oid, repo, "refs/remotes/origin/master");
	}
	if (rc < 0) goto done;

	rc = git_reference_create(NULL, repo, "refs/heads/main", &head_oid, 1, NULL);
	if (rc < 0) goto done;

	rc = git_repository_set_head(repo, "refs/heads/main");
	if (rc < 0) goto done;

	rc = git_object_lookup(&head_commit, repo, &head_oid, GIT_OBJECT_COMMIT);
	if (rc < 0) goto done;

	{
		git_checkout_options opts;
		git_checkout_options_init(&opts, GIT_CHECKOUT_OPTIONS_VERSION);
		opts.checkout_strategy = GIT_CHECKOUT_FORCE;
		/* --- Asyncify suspension #2: filter smudge, in the SAME top-level
		 * call as suspension #1 above. This is the exact scenario in
		 * question. --- */
		rc = git_checkout_tree(repo, head_commit, &opts);
	}
	if (rc < 0) goto done;

	if (commit_oid_hex_out != NULL) {
		git_oid_tostr(commit_oid_hex_out, 41, &head_oid);
	}
	rc = 0;

done:
	if (head_commit != NULL) git_object_free(head_commit);
	if (remote != NULL) git_remote_free(remote);
	if (repo != NULL) git_repository_free(repo);
	return rc;
}
