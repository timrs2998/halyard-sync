/**
 * The compiled module as these tests see it.
 *
 * Production code talks to the module through `NativeModule` (see
 * `src/git/libgit2/native-module.ts`). These tests additionally mount a real
 * host directory through NODEFS, which the plugin never does and which the
 * shipped build therefore does not need — so the NODEFS surface is declared
 * here rather than on the production contract.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FsOpTable } from "../../../src/git/libgit2/fs-backend";
import type {
	CcallArg,
	CcallArgType,
	NativeFs,
	NativeModule,
	NativeModuleFactory,
} from "../../../src/git/libgit2/native-module";

/**
 * `FS` members the tests read back with but the plugin never calls — it goes
 * through libgit2 and `VaultMirror` rather than driving FS directly, so these
 * stay out of the production contract.
 */
export interface TestNativeFs extends NativeFs {
	readFile(path: string): Uint8Array;
	readdir(path: string): string[];
	rename(oldPath: string, newPath: string): void;
}

/** NODEFS maps a mount point onto a real host directory via `node:fs`. */
export interface TestNativeModule extends Omit<NativeModule, "FS"> {
	FS: TestNativeFs;
	NODEFS?: { node_ops: FsOpTable };
}

export type TestModuleFactory = () => Promise<TestNativeModule>;

/**
 * Loads a compiled module's factory, or null when the artifact isn't built —
 * every suite that uses it is `describe.skipIf`-gated on that null, so a
 * checkout without the compiled binary still runs the rest of the suite.
 *
 * Pass `tether-libgit2.node.js` (the NODEFS-enabled build) for suites that
 * mount a real host directory; `tether-libgit2.js` is the shipped build, which
 * targets the web and has no Node filesystem at all. Both are linked from the
 * same objects and share one `tether-libgit2.wasm` (see build/build.sh).
 *
 * The bytes are handed to the glue through `instantiateWasm`, the same hook
 * `src/git/libgit2/loader.ts` uses in production — without it the shipped glue
 * would try to `fetch()` its wasm, which has nowhere to go under Node. Loading
 * it the way the plugin loads it is also the point: these suites then exercise
 * the artifact users actually run.
 */
export function loadModuleFactory(moduleJsPath: string): TestModuleFactory | null {
	if (!existsSync(moduleJsPath)) return null;
	const wasmPath = join(dirname(moduleJsPath), "tether-libgit2.wasm");
	try {
		const require = createRequire(import.meta.url);
		const mod: unknown = require(moduleJsPath);
		const factory =
			typeof mod === "function"
				? (mod as NativeModuleFactory)
				: (mod as { default?: NativeModuleFactory }).default;
		if (!factory) return null;
		return () =>
			factory({
				instantiateWasm(imports, callback) {
					const bytes = readFileSync(wasmPath);
					WebAssembly.instantiate(bytes, imports)
						.then((result) => callback(result.instance, result.module))
						.catch((err: unknown) => {
							throw err instanceof Error ? err : new Error(String(err));
						});
					return {};
				},
			}) as Promise<TestNativeModule>;
	} catch {
		return null;
	}
}

/** Mirrors `src/git/libgit2/engine.ts`'s `ccallAsync`: every call may suspend
 * (Asyncify), so all of them go through the async path. */
export function ccallAsyncNumber(
	Module: TestNativeModule,
	name: string,
	argTypes: CcallArgType[],
	args: CcallArg[]
): Promise<number> {
	return Module.ccall(name, "number", argTypes, args, { async: true });
}

/** libgit2's thread-local last-error message — read it immediately after the
 * failing call, before any other module call can overwrite it. */
export function lastErrorMessage(Module: TestNativeModule): string {
	const ptr = Module.ccall("git_error_last", "number", [], []);
	if (!ptr) return "(no libgit2 error set)";
	return Module.UTF8ToString(Module.getValue(ptr, "i32"));
}
