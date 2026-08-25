# Third-party notices

Halyard Sync is MIT-licensed (see [LICENSE](LICENSE)). It ships third-party
components whose notices are reproduced below.

## libgit2

The compiled artifacts `src/git/libgit2/build/dist/halyard-libgit2.wasm` and
`halyard-libgit2.js` statically link [libgit2](https://github.com/libgit2/libgit2)
v1.9.6, along with its bundled `zlib`, `pcre2`, `xdiff` and `llhttp`
dependencies.

libgit2 is licensed under **GNU General Public License v2 with a linking
exception**. The exception reads, in libgit2's own `COPYING`:

> In addition to the permissions in the GNU General Public License, the authors
> give you unlimited permission to link the compiled version of this library
> into combinations with other programs, and to distribute those combinations
> without any restriction coming from the use of this file. (The General Public
> License restrictions do apply in other respects; for example, they cover
> modification of the file, and distribution when not linked into a combined
> executable.)

This exception is what permits distributing the combined plugin under the MIT
license.

**Modification disclosure.** The build applies one patch to libgit2's own
source: `src/util/integer.h`'s `__builtin_u{add,mul}*_overflow` selection is
forced to the `unsigned long` branch under `__EMSCRIPTEN__`, because libgit2
does not otherwise compile for wasm32. The patch is applied by
`src/git/libgit2/build/build.sh` and documented in
[`src/git/libgit2/build/BUILD.md`](src/git/libgit2/build/BUILD.md). No other
libgit2 source is modified. The full, reproducible build is in that same
directory.

Full license text: https://github.com/libgit2/libgit2/blob/main/COPYING

## Emscripten

The compiled module is produced by the
[Emscripten SDK](https://github.com/emscripten-core/emsdk) 6.0.3, and the
generated JavaScript glue includes Emscripten runtime code. Emscripten is
licensed under the MIT License and the University of Illinois/NCSA Open Source
License.

Full license text: https://github.com/emscripten-core/emscripten/blob/main/LICENSE

## buffer

[`buffer`](https://github.com/feross/buffer) (Feross Aboukhadijeh and
contributors) is bundled as a mobile polyfill for
`src/git/libgit2/http-transport.ts`'s `basicAuthHeader`. MIT License.

## git-crypt

Halyard Sync interoperates with [git-crypt](https://github.com/AGWA/git-crypt)'s
on-disk format. The implementation in `src/git/gitcrypt.ts` and
`src/git/libgit2/native/filter_shim.c` was **written from scratch against that
format**; no git-crypt source code is used, copied, or derived from, and none of
git-crypt's GPL-3.0 licensing applies to this project. Credit to Andrew Ayer for
designing and documenting the format.
