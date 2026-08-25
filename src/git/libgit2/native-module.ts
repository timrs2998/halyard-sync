/**
 * The compiled Emscripten module's JS surface, as TypeScript.
 *
 * `build/build.sh` decides exactly what the compiled artifact exposes:
 * `-sEXPORTED_RUNTIME_METHODS` names the runtime helpers, `-sEXPORTED_FUNCTIONS`
 * the C entry points, and `-sMODULARIZE`/`-sEXPORT_NAME` the factory that
 * returns the module object. Emscripten ships no types for any of it, so this
 * file is the hand-maintained contract: everything the plugin touches on a
 * compiled module is declared here, and nothing else may be reached for.
 *
 * Keep this in sync with `build/build.sh` — a member added here that the build
 * does not export is a runtime `undefined`, which no type check can catch.
 *
 * The `__`-prefixed members are NOT Emscripten's: they are the JS halves of
 * this project's own `native/*_shim.c` seams (`EM_ASYNC_JS`/`EM_JS`), which
 * call out to whatever the module object carries under those names. See
 * `native/transport_shim.c` and `native/filter_shim.c`.
 */

import type { FsNode } from "./fs-backend";

/** What `ccall` accepts as an argument type, per Emscripten's `ccall` docs. */
export type CcallArgType = "number" | "string" | "array" | "boolean";

/** The argument values those types accept. */
export type CcallArg = number | string | boolean | Uint8Array | null;

/** Emscripten's `setValue`/`getValue` LLVM type names, narrowed to those used here. */
export type HeapValueType = "i8" | "i16" | "i32" | "float" | "double" | "*";

/**
 * The `FS` (classic filesystem) subset this plugin uses. `VaultMirror`'s
 * backend is mounted through `mount`; the rest is either mount plumbing or
 * the probe `deriveErrnoCodes` runs to learn this runtime's errno numbers.
 */
export interface NativeFs {
	ErrnoError: new (errno: number) => Error & { errno: number };
	createNode(parent: FsNode | null, name: string, mode: number, dev: number): FsNode;
	isDir(mode: number): boolean;
	mkdir(path: string, mode?: number): void;
	mount(type: unknown, opts: Record<string, unknown>, mountpoint: string): unknown;
	writeFile(path: string, data: string): void;
	rmdir(path: string): void;
	unlink(path: string): void;
	stat(path: string): unknown;
	readlink(path: string): unknown;
}

/** What `native/transport_shim.c` expects back from a dispatched request. */
export interface NativeHttpResponse {
	status: number;
	body: Uint8Array;
}

export interface NativeModule {
	/**
	 * Calls an exported C function. The `{ async: true }` overload is the one
	 * this binding uses for anything that can suspend (see `engine.ts`'s
	 * `ccallAsync`); Asyncify makes even a nominally synchronous libgit2 call
	 * suspend when it reaches this project's JS-backed FS or transport.
	 */
	ccall(name: string, returnType: "number", argTypes: CcallArgType[], args: CcallArg[]): number;
	ccall(name: string, returnType: "string", argTypes: CcallArgType[], args: CcallArg[]): string;
	ccall(name: string, returnType: null, argTypes: CcallArgType[], args: CcallArg[]): void;
	ccall(
		name: string,
		returnType: "number",
		argTypes: CcallArgType[],
		args: CcallArg[],
		opts: { async: true }
	): Promise<number>;
	ccall(
		name: string,
		returnType: "string",
		argTypes: CcallArgType[],
		args: CcallArg[],
		opts: { async: true }
	): Promise<string>;
	ccall(
		name: string,
		returnType: null,
		argTypes: CcallArgType[],
		args: CcallArg[],
		opts: { async: true }
	): Promise<void>;

	getValue(ptr: number, type: HeapValueType): number;
	setValue(ptr: number, value: number, type: HeapValueType): void;
	UTF8ToString(ptr: number, maxBytesToRead?: number): string;
	stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
	lengthBytesUTF8(str: string): number;
	/** Allocates with `malloc` and writes the string — caller frees. */
	stringToNewUTF8(str: string): number;

	_malloc(size: number): number;
	_free(ptr: number): void;

	/** The wasm linear memory as bytes. Re-read after any allocation:
	 * `-sALLOW_MEMORY_GROWTH=1` detaches and replaces the view on growth. */
	readonly HEAPU8: Uint8Array;
	readonly HEAP32: Int32Array;
	readonly HEAPU32: Uint32Array;

	FS: NativeFs;
	/** Emscripten's musl-derived errno table — see `fs-backend.ts`'s
	 * `deriveErrnoCodes` for why the numbers are probed rather than assumed. */
	ERRNO_CODES?: Record<string, number>;

	/** Installed by `installHttpDispatch`; read by `native/transport_shim.c`. */
	__httpDispatch?: (
		url: string,
		method: string,
		contentType: string | null,
		body: Uint8Array
	) => Promise<NativeHttpResponse>;
	/** Installed by `registerGitCryptFilter`; read by `native/filter_shim.c`. */
	__gitcryptEncrypt?: (keyName: string, plaintext: Uint8Array) => Promise<Uint8Array>;
	__gitcryptDecrypt?: (keyName: string, ciphertext: Uint8Array) => Promise<Uint8Array>;
}

/**
 * The factory `-sMODULARIZE=1 -sEXPORT_NAME=HalyardLibgit2` produces. The
 * `instantiateWasm` override is how `loader.ts` feeds in bytes it read itself
 * rather than letting the glue fetch a sibling `.wasm` file.
 */
export type NativeModuleFactory = (options?: {
	instantiateWasm?: (
		imports: WebAssembly.Imports,
		callback: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void
	) => unknown;
	locateFile?: (path: string, scriptDirectory: string) => string;
}) => Promise<NativeModule>;
