# Reproducible build environment for build.sh — pins the OS/toolchain layer
# so "works on my machine" isn't a variable on top of everything else in
# this build.
#
# STATUS: real, built and used — see BUILD.md for the full real build log
# and every fix. `docker build` against this file, followed by `docker run`,
# is exactly how `build/dist/tether-libgit2.{js,wasm}` (committed to the
# repo) were actually produced.
#
# Usage (see BUILD.md's "How to actually build it" for the full real
# command, including the Windows/Docker Desktop path gotchas — the example
# below is the Linux/macOS-native shape; on Windows, use Windows-style paths
# and a named volume for .build-work, not $(pwd)):
#   docker build -t halyard-sync-libgit2-wasm -f build/Dockerfile .    # context is src/git/libgit2, not build/
#   docker run --rm -v "$(pwd)/build/dist:/work/build/dist" halyard-sync-libgit2-wasm
#
# The emsdk image already contains a matching emcc/clang/node toolchain for
# a given tag, which is why this starts FROM it (pinned to the same version
# as versions.env) rather than installing emsdk on top of a bare distro
# image — one less place for the two version pins to drift apart.

FROM emscripten/emsdk:6.0.3

WORKDIR /work

# CMake + build-essential: emsdk's image ships emcc/clang/node but building
# libgit2 itself still goes through CMake's own configure step before
# `emmake` takes over (emmake wraps `make`, not `cmake`).
RUN apt-get update && \
    apt-get install -y --no-install-recommends cmake build-essential && \
    rm -rf /var/lib/apt/lists/*

COPY . /work

# The emsdk image's emsdk is already activated for the image's own pinned
# version; build.sh's own `emsdk install/activate` calls are then a no-op
# confirming that version matches versions.env, not a second real install.
ENTRYPOINT ["bash", "build/build.sh"]
