/**
 * Mounts a real host directory into the compiled module's classic FS, with
 * ownership normalized so libgit2's owner check can't reject it.
 *
 * NODEFS reports the host's real `stat.uid`, but Emscripten's `geteuid()` is a
 * stub that always returns 0. libgit2 compares the two in its ownership check
 * — its equivalent of git's `safe.directory` mitigation for CVE-2022-24765 —
 * and fails with GIT_EOWNER (-36, "repository path is not owned by current
 * user") whenever they disagree. So a NODEFS-backed repo works as root or on
 * Windows (both report uid 0) and fails for an ordinary Linux user, including
 * GitHub Actions' `runner`.
 *
 * That check exists to stop git from acting on a repository owned by someone
 * else. It has nothing useful to say about a temp directory the test itself
 * just created, so these mounts report uid 0 and let it pass.
 *
 * The plugin never hits this: it mounts `VaultMirror` (see
 * `src/git/libgit2/fs-backend.ts`), whose nodes come from `FS.createNode` and
 * already report uid 0. NODEFS is a test-only convenience.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const PATCHED = Symbol.for("tether.nodefs.ownership-normalized");

/** Creates `mountPoint`, mounts `hostDir` there via NODEFS, normalizes ownership. */
export function mountHostDir(Module: any, hostDir: string, mountPoint: string): void {
	Module.FS.mkdir(mountPoint);
	Module.FS.mount(Module.NODEFS, { root: hostDir }, mountPoint);
	normalizeNodefsOwnership(Module);
}

/**
 * Forces every NODEFS `getattr` in this module instance to report uid/gid 0.
 * Idempotent, and scoped to the one instance: `-sMODULARIZE=1` gives each
 * `factory()` call its own `NODEFS` object.
 */
export function normalizeNodefsOwnership(Module: any): void {
	const ops = Module.NODEFS?.node_ops;
	if (!ops || ops[PATCHED]) return;

	const original = ops.getattr;
	ops.getattr = (node: unknown) => {
		const attr = original.call(ops, node);
		attr.uid = 0;
		attr.gid = 0;
		return attr;
	};
	ops[PATCHED] = true;
}
