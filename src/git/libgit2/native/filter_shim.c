/*
 * filter_shim.c — an in-process libgit2 git_filter registering the
 * git-crypt-compatible clean/smudge behavior, with the actual encryption
 * delegated back out to JavaScript (WebCrypto, in the parallel
 * `src/git/gitcrypt.ts` phase — see the top-level phase brief for the split;
 * this file does not implement, vendor, or link any cryptography itself).
 *
 * =============================================================================
 * STATUS: COMPILED AND EXERCISED END-TO-END. Built for real via Docker +
 * emscripten/emsdk:6.0.3 against libgit2 v1.9.6 (see build/BUILD.md for the
 * full real build log, the two real bugs found in this file — a
 * const-variable-in-a-static-initializer error and a stray `/*` inside a
 * block comment — and how each was fixed). `tests/libgit2/
 * filter-smoke.test.ts` loads the compiled module, registers this exact
 * filter wired to the real `encryptBlob`/`decryptBlob` from
 * `src/git/gitcrypt.ts`, and verifies both the clean (encrypt) and smudge
 * (decrypt) directions against real on-disk git objects and a real working
 * tree file — not mocked. `tests/libgit2/asyncify-double-suspension.test.ts`
 * additionally proves the EM_ASYNC_JS bridge below survives being invoked
 * in the same top-level libgit2 call as a second, independent Asyncify
 * suspension point (a real network fetch, see `native/transport_shim.c`) —
 * see build/BUILD.md's "Asyncify ... RESOLVED" section for the full
 * writeup of why that risk turned out not to materialize for libgit2's
 * actual fetch/checkout call graph.
 * =============================================================================
 *
 * ---------------------------------------------------------------------------
 * The libgit2 filter API this implements (git2/sys/filter.h, main branch)
 * ---------------------------------------------------------------------------
 *
 *   struct git_filter {
 *       unsigned int           version;    // GIT_FILTER_VERSION == 1
 *       const char            *attributes; // see ATTRIBUTES note below
 *       git_filter_init_fn     initialize; // int(git_filter *self)
 *       git_filter_shutdown_fn shutdown;   // void(git_filter *self)
 *       git_filter_check_fn    check;      // see below
 *       git_filter_apply_fn    apply;      // deprecated in favor of stream; NULL here
 *       git_filter_stream_fn   stream;     // see below
 *       git_filter_cleanup_fn  cleanup;    // void(git_filter *self, void *payload)
 *   };
 *
 *   int git_filter_check(git_filter *self, void **payload,
 *                         const git_filter_source *src,
 *                         const char **attr_values);
 *     -> 0 to run this filter, GIT_PASSTHROUGH to skip it unmodified, or an
 *        error code. `attr_values` holds one resolved attribute value per
 *        whitespace-separated clause in `self->attributes` (see ATTRIBUTES
 *        note). `*payload` is filter-instance-and-call scoped: whatever is
 *        stashed here is handed back to `stream` and finally `cleanup`.
 *
 *   int git_filter_stream(git_writestream **out, git_filter *self,
 *                          void **payload, const git_filter_source *src,
 *                          git_writestream *next);
 *     -> constructs a `git_writestream` (write/close/free) that receives the
 *        *source* content (plaintext on clean, ciphertext on smudge) via
 *        repeated `write()` calls, and is responsible for pushing the
 *        *transformed* content into `next` (the next filter in the chain, or
 *        the terminal sink) via `next->write(...)` + eventually
 *        `next->close(...)`.
 *
 *   git_filter_source accessors (git2/sys/filter.h):
 *     git_repository   *git_filter_source_repo(const git_filter_source *src);
 *     const char        *git_filter_source_path(const git_filter_source *src);
 *     uint16_t           git_filter_source_filemode(const git_filter_source *src);
 *     const git_oid     *git_filter_source_id(const git_filter_source *src);
 *     git_filter_mode_t  git_filter_source_mode(const git_filter_source *src);
 *     uint32_t           git_filter_source_flags(const git_filter_source *src);
 *
 *   git_filter_mode_t (git2/filter.h):
 *     GIT_FILTER_TO_WORKTREE = 0  (== GIT_FILTER_SMUDGE — decrypt, odb -> disk)
 *     GIT_FILTER_TO_ODB      = 1  (== GIT_FILTER_CLEAN  — encrypt, disk -> odb)
 *
 *   int git_filter_register(const char *name, git_filter *filter, int priority);
 *     -> priority: real git-crypt runs after CRLF/ident-style filters in the
 *        clean direction and before them in the smudge direction (libgit2:
 *        "check and stream/apply callbacks issued in order of priority on
 *        smudge, reverse order of priority on clean" — GIT_FILTER_DRIVER_PRIORITY
 *        (200) is what libgit2 itself uses for attribute-driven `filter=`
 *        drivers and is the right value here too, ahead of CRLF (0) / ident
 *        (100), matching how real git orders driver filters last-to-run on
 *        clean / first-to-run on smudge relative to the built-ins).
 *
 * ATTRIBUTES (resolved — named-key phase): libgit2 parses `git_filter.attributes`
 * as a small whitespace-separated clause DSL (`"attr"`, `"attr=value"`,
 * `"!attr"`, `"-attr"`, `"+attr"`, ...), implemented in libgit2's own
 * `src/libgit2/filter.c`. Read directly (not guessed) against the pinned
 * v1.9.6 tag (`filter_def_scan_attrs`/`filter_def_set_attrs`/
 * `filter_list_check_attributes`, same file):
 *
 *   - A clause with NO `=value` (bare `"attr"`, no `-`/`+`/`!` prefix either)
 *     is recorded with `nmatches` NOT incremented for it, and its resolved
 *     "want" value is stored as NULL. `filter_list_check_attributes` skips
 *     any attribute slot whose "want" is NULL (`if (!want) continue;`) —
 *     i.e. a bare clause is never used to reject a path; it only ever
 *     fetches the path's resolved value for that attribute name and hands
 *     it to `check()` regardless of what it is (including NULL, when the
 *     path has no such attribute at all).
 *   - A clause WITH `=value` (`"attr=value"`) *does* increment `nmatches`,
 *     making libgit2 itself reject (skip calling `check()` for) any path
 *     whose resolved value doesn't literally string-equal `value` — no
 *     prefix/wildcard support exists in this DSL (`filter_list_check_attributes`
 *     does a plain `strcmp`, nothing else).
 *
 * Real git-crypt supports *named* keys via `filter=git-crypt-<keyname>`
 * (`.gitattributes`: "secrets/(asterisk) filter=git-crypt-secrets"), and
 * there is no way to write a single attribute clause matching both
 * `"git-crypt"` and every `"git-crypt-<name>"` value via libgit2's `=value`
 * exact-match form. **Fix**: `TETHER_GITCRYPT_ATTRIBUTES` below is the BARE
 * clause `"filter"` (no `=value`), which — per the above — means libgit2
 * calls `check()` for literally every path in the repo (not just git-crypt
 * ones), handing over whatever that path's resolved `filter` attribute value
 * is (or NULL). `filter_check` below does the actual git-crypt-vs-anything-
 * else decision itself: exactly `"git-crypt"` -> default key (`""`); starts
 * with `"git-crypt-"` -> that suffix as the key name; anything else
 * (`"lfs"`, an unrelated custom filter, NULL, or one of libgit2's internal
 * boolean-attribute sentinel strings such as `"[internal]__TRUE__"` from a
 * bare `filter`/`-filter`/`!filter` clause in some `.gitattributes`, which
 * bare-clause matching also lets through) -> `GIT_PASSTHROUGH`, i.e. not
 * this filter's concern. The broader "is this OK to sync at all" decision
 * (blocked vs. locked vs. ok) is made TS-side (`src/git/engine.ts`'s
 * `classifyFilters`), not here — this file only decides which paths its own
 * clean/smudge logic actually runs for.
 */

#include <stdlib.h>
#include <string.h>

#include <emscripten.h>
#include <git2.h>
#include <git2/sys/filter.h>

/* ---------------------------------------------------------------------------
 * JS interop seam (defines the seam; does not consume the other side of it)
 * ---------------------------------------------------------------------------
 *
 * Per the phase brief: the wiring phase (not this one) installs
 * `Module.__gitcryptEncrypt` / `Module.__gitcryptDecrypt` as JS functions
 * satisfying `GitCryptFilterHooks` in `../binding.ts` — i.e. they receive a
 * key name + a byte buffer and return a Promise<Uint8Array>, backed by
 * WebCrypto in `src/git/gitcrypt.ts` (which this file does not import,
 * reference, or assume exists — see the phase brief's scope boundary).
 * `Libgit2Module.registerGitCryptFilter(hooks)` in binding.ts is the
 * documented TS-side call that would perform that installation before
 * invoking `halyard_register_gitcrypt_filter()` below.
 *
 * ASYNCIFY, WHY IT'S NEEDED HERE SPECIFICALLY: `git_filter_stream_fn` is a
 * synchronous C entry point (libgit2 calls it in the middle of a checkout or
 * commit, expects it to run to completion before returning), but WebCrypto's
 * `SubtleCrypto.encrypt`/`decrypt` are Promise-based — there is no
 * synchronous WebCrypto. Emscripten's Asyncify
 * (https://emscripten.org/docs/porting/asyncify.html) is the documented
 * mechanism for exactly this: `EM_ASYNC_JS` lets a JS function marked async
 * be called from C as if it blocked, with the compiler inserting the
 * suspend/resume machinery (`-sASYNCIFY`, `-O3` recommended — unoptimized
 * Asyncify builds are large; also add every EM_ASYNC_JS-declared function to
 * `ASYNCIFY_IMPORTS` if the build ever mixes in manual `EM_JS` +
 * `Asyncify.handleSleep` calls elsewhere, though EM_ASYNC_JS handles this
 * automatically for functions declared this way).
 *
 * RISK, called out precisely because it is real: Asyncify's own docs state
 * "it is not safe to start an async operation while another is already
 * running." The filter callbacks below are the *only* Asyncify-touching
 * code path in the whole libgit2 build if `fs-backend.ts`'s recommendation
 * (eager in-memory FS mirroring, no Asyncify in the FS layer) is followed —
 * but `http-transport.ts`'s recommendation is to ALSO use Asyncify (for its
 * own, narrower reason — see that file's header). That means there are two
 * independent call paths in the same compiled module that suspend the WASM
 * instance: a fetch/push mid-transport, and a clean/smudge filter mid-
 * checkout-or-commit. libgit2's own internals are not reentrant across
 * threads, but Asyncify's hazard is about *nested* suspension on the SAME
 * call stack, not concurrent unrelated operations run to completion one at a
 * time — since this plugin's orchestrator already serializes all engine-
 * touching operations through one `AsyncLock` (`sync/async-lock.ts`, see
 * DESIGN.md's "Engine-touching operations... serialized" note), a fetch is
 * never in flight while a checkout's filter is also running. The risk that
 * DOES remain and needs real verification once a toolchain exists: whether
 * a single `git_remote_fetch` (transport Asyncify) can itself internally
 * trigger a filter invocation (smudge, on checkout during clone) while the
 * transport's own suspend/resume state is still unwound — i.e. whether
 * Asyncify's "one suspension at a time" rule is violated *within* one
 * top-level libgit2 call, not just across separate ones. This has not been
 * checked against libgit2's actual call graph and is exactly the kind of
 * thing the first real build + a deliberately crafted clone-of-an-encrypted-
 * repo-over-HTTP test needs to exercise before this is trusted.
 */

EM_ASYNC_JS(uint8_t *, halyard_gitcrypt_encrypt_js, (const char *key_name, const uint8_t *plaintext, size_t plaintext_len, size_t *out_len), {
	// `Module.__gitcryptEncrypt` is installed by the wiring phase (see
	// header comment) and must match `GitCryptFilterHooks.encrypt` in
	// ../binding.ts: (keyName: string, plaintext: Uint8Array) => Promise<Uint8Array>.
	if (!Module.__gitcryptEncrypt) {
		throw new Error("halyard_gitcrypt_encrypt_js: Module.__gitcryptEncrypt is not installed — registerGitCryptFilter() was not called before this filter ran");
	}
	var keyName = UTF8ToString(key_name);
	// .slice (not .subarray) so the copy survives independently of HEAPU8
	// being detached/resized by an intervening allocation while we await.
	var input = HEAPU8.slice(plaintext, plaintext + plaintext_len);
	var output = await Module.__gitcryptEncrypt(keyName, input);
	var ptr = _malloc(output.byteLength);
	HEAPU8.set(output, ptr);
	// Variable-length EM_ASYNC_JS returns can only be one scalar (the
	// pointer); the length rides out through this caller-supplied
	// out-param, the standard idiom for buffer-returning Emscripten JS
	// library functions.
	setValue(out_len, output.byteLength, "i32");
	return ptr;
});

EM_ASYNC_JS(uint8_t *, halyard_gitcrypt_decrypt_js, (const char *key_name, const uint8_t *ciphertext, size_t ciphertext_len, size_t *out_len), {
	if (!Module.__gitcryptDecrypt) {
		throw new Error("halyard_gitcrypt_decrypt_js: Module.__gitcryptDecrypt is not installed — registerGitCryptFilter() was not called before this filter ran");
	}
	var keyName = UTF8ToString(key_name);
	var input = HEAPU8.slice(ciphertext, ciphertext + ciphertext_len);
	var output = await Module.__gitcryptDecrypt(keyName, input);
	var ptr = _malloc(output.byteLength);
	HEAPU8.set(output, ptr);
	setValue(out_len, output.byteLength, "i32");
	return ptr;
});

/* ---------------------------------------------------------------------------
 * The buffering git_writestream
 * ---------------------------------------------------------------------------
 *
 * git-crypt's on-disk format is not chunk-streamable at the crypto layer:
 * the CTR nonce is derived from an HMAC over the *whole* plaintext (see
 * ../../gitcrypt.ts's header comment citing AGWA/git-crypt's crypto.cpp),
 * so this shim cannot encrypt/decrypt incrementally as `write()` chunks
 * arrive — it buffers everything and only calls out to JS once, in
 * `close()`, matching git-crypt's own whole-file framing. `next` (the
 * downstream writestream) only ever sees one `write()` + one `close()`
 * call as a result, which is within the bounds of what any git_writestream
 * consumer must tolerate (libgit2's own CRLF filter's stream buffers
 * per-line, not per-arbitrary-chunk, for a similar reason).
 */

typedef struct {
	git_writestream parent; /* MUST be the first member: libgit2 casts a
	                          * git_writestream* back to this struct via
	                          * plain pointer reinterpretation ("allocate
	                          * extra data and put the git_filter struct at
	                          * the start of your data buffer" — same
	                          * convention documented for git_filter's own
	                          * self-pointer in sys/filter.h). */
	git_writestream *next;
	git_filter_mode_t mode;
	char *key_name; /* owned; freed in stream_free */
	uint8_t *buffer;
	size_t len;
	size_t cap;
} halyard_gitcrypt_stream;

static int stream_grow(halyard_gitcrypt_stream *s, size_t additional) {
	if (s->len + additional <= s->cap) return 0;
	size_t new_cap = s->cap == 0 ? 4096 : s->cap;
	while (new_cap < s->len + additional) new_cap *= 2;
	uint8_t *grown = (uint8_t *)realloc(s->buffer, new_cap);
	if (grown == NULL) return -1;
	s->buffer = grown;
	s->cap = new_cap;
	return 0;
}

static int stream_write(git_writestream *stream, const char *buffer, size_t len) {
	halyard_gitcrypt_stream *s = (halyard_gitcrypt_stream *)stream;
	if (stream_grow(s, len) < 0) return -1;
	memcpy(s->buffer + s->len, buffer, len);
	s->len += len;
	return 0;
}

static int stream_close(git_writestream *stream) {
	halyard_gitcrypt_stream *s = (halyard_gitcrypt_stream *)stream;
	size_t out_len = 0;
	uint8_t *out_ptr;

	if (s->mode == GIT_FILTER_TO_ODB) {
		out_ptr = halyard_gitcrypt_encrypt_js(s->key_name, s->buffer, s->len, &out_len);
	} else {
		out_ptr = halyard_gitcrypt_decrypt_js(s->key_name, s->buffer, s->len, &out_len);
	}
	if (out_ptr == NULL) return -1;

	int rc = s->next->write(s->next, (const char *)out_ptr, out_len);
	free(out_ptr);
	if (rc < 0) return rc;
	return s->next->close(s->next);
}

static void stream_free(git_writestream *stream) {
	halyard_gitcrypt_stream *s = (halyard_gitcrypt_stream *)stream;
	free(s->buffer);
	free(s->key_name);
	free(s);
}

/* ---------------------------------------------------------------------------
 * The git_filter itself
 * ---------------------------------------------------------------------------
 */

/* Bare clause (no `=value`) — see the ATTRIBUTES note in the file header for
 * why: this makes libgit2 call filter_check() for every path's resolved
 * `filter` attribute value (default key, a named key, something unrelated,
 * or none at all), and filter_check() itself decides what to do with it. */
/* Must be a preprocessor macro, not a `static const char *` variable: this
 * is used as a member initializer for the file-scope `halyard_gitcrypt_filter`
 * struct below, and ISO C does not treat a `const`-qualified variable's
 * value as a constant expression there (`const` in C means "read-only",
 * not "compile-time constant" the way it does in C++) -- a real compiler
 * error found on the first actual build:
 * "error: initializer element is not a compile-time constant". */
#define TETHER_GITCRYPT_ATTRIBUTES "filter"
/* The unnamed-key attribute value exactly, and the named-key value prefix —
 * distinct from TETHER_GITCRYPT_FILTER_NAME below, which is the name this
 * filter is REGISTERED under with libgit2 (git_filter_register), not an
 * attribute value. */
#define TETHER_GITCRYPT_ATTR_VALUE "git-crypt"
#define TETHER_GITCRYPT_NAMED_KEY_PREFIX "git-crypt-"
static const char *TETHER_GITCRYPT_FILTER_NAME = "git-crypt";
/* Matches libgit2's own attribute-driven filter drivers' priority (see the
 * file header's priority note) — a named constant here rather than a bare
 * "200" so the rationale travels with the value. */
#define TETHER_GITCRYPT_PRIORITY 200

static int filter_check(
	git_filter *self,
	void **payload,
	const git_filter_source *src,
	const char **attr_values) {
	const char *value;
	const char *key_name;
	const size_t prefix_len = sizeof(TETHER_GITCRYPT_NAMED_KEY_PREFIX) - 1;
	(void)self;
	(void)src;
	/* attr_values[0] corresponds to the single bare "filter" clause in
	 * TETHER_GITCRYPT_ATTRIBUTES above -- since that clause has no `=value`,
	 * libgit2 calls check() for EVERY path (see the ATTRIBUTES note in the
	 * file header), handing back whatever that path's resolved `filter`
	 * attribute value actually is: NULL (no filter attribute at all), the
	 * literal string "git-crypt" (default key), "git-crypt-<name>" (a named
	 * key), some unrelated filter's name ("lfs", ...), or one of libgit2's
	 * internal boolean-attribute sentinel strings (from a bare
	 * `filter`/`-filter`/`!filter` clause in some .gitattributes, which this
	 * shim's own bare-clause matching also lets through here). Everything
	 * except the first two cases is not this filter's concern. */
	if (attr_values == NULL || attr_values[0] == NULL) {
		return GIT_PASSTHROUGH;
	}
	value = attr_values[0];
	if (strcmp(value, TETHER_GITCRYPT_ATTR_VALUE) == 0) {
		key_name = ""; /* the default/unnamed key */
	} else if (strncmp(value, TETHER_GITCRYPT_NAMED_KEY_PREFIX, prefix_len) == 0) {
		key_name = value + prefix_len; /* everything after "git-crypt-" */
	} else {
		return GIT_PASSTHROUGH;
	}
	*payload = strdup(key_name);
	if (*payload == NULL) return -1;
	return 0;
}

static int filter_stream(
	git_writestream **out,
	git_filter *self,
	void **payload,
	const git_filter_source *src,
	git_writestream *next) {
	(void)self;
	halyard_gitcrypt_stream *s = (halyard_gitcrypt_stream *)calloc(1, sizeof(halyard_gitcrypt_stream));
	if (s == NULL) return -1;

	s->parent.write = stream_write;
	s->parent.close = stream_close;
	s->parent.free = stream_free;
	s->next = next;
	s->mode = git_filter_source_mode(src);
	/* Ownership transfers from the strdup'd payload (freed by filter_cleanup
	 * below, once per check()) to a second strdup owned by the stream
	 * itself (freed in stream_free) -- check() and stream() are not
	 * guaranteed to be the last consumers of *payload at the same time in
	 * every libgit2 version, so the stream keeps its own copy rather than
	 * assuming it may take ownership of *payload directly. */
	s->key_name = strdup(payload != NULL && *payload != NULL ? (const char *)*payload : "");
	if (s->key_name == NULL) {
		free(s);
		return -1;
	}

	*out = (git_writestream *)s;
	return 0;
}

static void filter_cleanup(git_filter *self, void *payload) {
	(void)self;
	free(payload); /* the strdup("") from filter_check */
}

static git_filter halyard_gitcrypt_filter = {
	GIT_FILTER_VERSION,
	TETHER_GITCRYPT_ATTRIBUTES,
	NULL, /* initialize: no per-registration setup needed */
	NULL, /* shutdown: no per-registration teardown needed */
	filter_check,
	NULL, /* apply: deprecated in favor of stream (see file header) */
	filter_stream,
	filter_cleanup,
};

/* ---------------------------------------------------------------------------
 * Entry points called from TS (via Module.ccall / cwrap once compiled — see
 * build/BUILD.md's "EXPORTED_FUNCTIONS" note)
 * ---------------------------------------------------------------------------
 */

/* Install Module.__gitcryptEncrypt / Module.__gitcryptDecrypt BEFORE calling
 * this (see binding.ts's Libgit2Module.registerGitCryptFilter, which is the
 * documented caller). Returns libgit2's git_filter_register return code
 * (0 on success, < 0 on error — e.g. already registered). */
EMSCRIPTEN_KEEPALIVE
int halyard_register_gitcrypt_filter(void) {
	return git_filter_register(
		TETHER_GITCRYPT_FILTER_NAME,
		&halyard_gitcrypt_filter,
		TETHER_GITCRYPT_PRIORITY);
}

EMSCRIPTEN_KEEPALIVE
int halyard_unregister_gitcrypt_filter(void) {
	return git_filter_unregister(TETHER_GITCRYPT_FILTER_NAME);
}
