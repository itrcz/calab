#!/usr/bin/env bash
# Build Calab desktop releases for macOS (arm64 + x64), Linux and Windows from this Mac (docs/06, "Релизы десктопа: сборка").
#
#   apps/desktop/scripts/build-release.sh [mac] [linux] [win]    # default: all three
#
# Env:
#   SRC_REF=HEAD        git ref to build (a clean `git archive` export — uncommitted changes are NOT built);
#                       SRC_REF=WORKTREE builds the working tree as is (local checks only, never publish)
#   VERSION=1.2.3       override apps/desktop/package.json version (applied to the export only)
#   UPDATE_URL=…        electron-updater generic feed baked into app-update.yml / latest*.yml
#                       (default https://releases.calab.ru/ — docs/10-branding.md); also baked into the app
#                       as MAIN_VITE_UPDATE_FEED; MAIN_VITE_UPDATES_SIGNED=1 only for a signed macOS build
#   HOMEPAGE=…          package homepage (deb metadata; default https://calab.ru, the landing)
#   OUT_DIR=…           artifacts dir (default apps/desktop/dist-release)
#   WORK_DIR=…          scratch dir (default $TMPDIR/calaba-release; removed on exit unless KEEP_WORK=1)
#   SIGN=1              macOS: sign with the owner's Developer ID from cert/developerID_full.p12 (password:
#                       APPLE_CERT_PASSWORD in the root .env; never printed). No notarization here — that is CI;
#                       no secure timestamp either unless SIGN_TIMESTAMP=1 (see build_mac).
#   NOTARIZE=1          with SIGN=1: notarize + staple (App Store Connect API key cert/AuthKey_<id>.p8, APPLE_API_KEY_ID /
#                       APPLE_API_ISSUER / APPLE_TEAM_ID from the root .env)
#   MAC_ARCH=arm64|x64  macOS: build only this arch (default: arm64 + x64 from electron-builder.yml)
#   SMOKE=0             skip the Linux smoke start (AppImage under Xvfb, inside the build container)
#   BUILD_DOCKER_HOST=ssh://user@host  x86_64 Linux Docker host for the Linux/Windows builds (recommended on
#                       Apple Silicon: no amd64 emulation; required for Windows — NSIS needs 32-bit wine,
#                       which Docker's qemu cannot run). WIN_DOCKER_HOST: same, Windows only.
#                       REMOTE_CPUS/REMOTE_MEMORY (default 4 / 6g) cap the container on a shared host.
#
# Output: apps/desktop/dist-release/ — versioned installers + latest-mac.yml / latest-linux.yml / latest.yml
# (prerelease versions like 0.1.0-rc.1 get channel feeds instead: rc-mac.yml / rc-linux.yml / rc.yml)
# (+ .blockmap). Publish with infra/docker/sync.sh (copies them to <domain>/download/, never deletes).
#
# Native module: uiohook-napi. Our patch (patches/uiohook-napi@1.5.5.patch) changes only the macOS hook,
# and electron-builder.yml excludes the upstream prebuilds (buildDependenciesFromSource): the module is
# compiled from the patched source for every target — macOS per arch, Linux inside the container.
# Windows cannot be compiled outside Windows: the win build ships the upstream win32-x64 N-API prebuild
# (identical code on Windows — the patch is darwin-only); a native Windows build (CI) compiles it instead.
# Nothing is signed: macOS identity=null, Windows unsigned (see docs/06 for what signing needs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${OUT_DIR:-$ROOT/apps/desktop/dist-release}"
SRC_REF="${SRC_REF:-HEAD}"
UPDATE_URL="${UPDATE_URL:-https://releases.calab.ru/}"
HOMEPAGE="${HOMEPAGE:-https://calab.ru}"
WORK="${WORK_DIR:-${TMPDIR:-/tmp}/calaba-release}"
SRC="$WORK/src"
# The scratch dir (source export, node_modules, per-OS build dirs) is removed on exit; only
# dist-release/ stays. KEEP_WORK=1 keeps it for debugging.
cleanup() { [[ "${KEEP_WORK:-0}" == 1 ]] || rm -rf "${WORK:?}"; }
trap cleanup EXIT
# electronuserland/builder:wine (Ubuntu, Node, wine + mono for NSIS), pinned by digest.
BUILDER_IMAGE="${BUILDER_IMAGE:-electronuserland/builder:wine@sha256:41ae540902461b6cbc988987db79547fcc10cda04d2a6c6367504f59d4b37c64}"
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json")"

platforms=("$@"); [[ ${#platforms[@]} -eq 0 ]] && platforms=(mac linux win)
log() { printf '\n==> %s\n' "$*"; }
TIMES=""   # "platform=seconds" pairs (macOS ships bash 3.2: no associative arrays)

# Common electron-builder overrides: file names without spaces, always with the version
# (/download/ caches installers as immutable), and a generic publish feed so latest*.yml is written.
EB_COMMON=(
  --publish never
  -c.publish.provider=generic "-c.publish.url=$UPDATE_URL"
  "-c.mac.artifactName=Calab-\${version}-\${arch}.\${ext}"
  "-c.nsis.artifactName=Calab-Setup-\${version}-\${arch}.\${ext}"
  "-c.appImage.artifactName=Calab-\${version}-\${arch}.\${ext}"
  "-c.deb.artifactName=calab_\${version}_\${arch}.\${ext}"
  # The npm name "@calaba/desktop" is not a valid Linux binary / dpkg package name.
  -c.linux.executableName=calab -c.deb.packageName=calab
  "-c.extraMetadata.homepage=$HOMEPAGE"   # required by the deb target
)

# --- 1. clean source export -----------------------------------------------------------------------
log "export $SRC_REF → $SRC"
rm -rf "$SRC"; mkdir -p "$SRC" "$OUT"
if [[ "$SRC_REF" == WORKTREE ]]; then
  # local checks only (e.g. SIGN=1 verification): tracked + untracked files, .gitignore respected; never publish
  (cd "$ROOT" && git ls-files -z -co --exclude-standard | xargs -0 tar -cf - 2>/dev/null) | tar -x -C "$SRC"
  COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)-worktree"
else
  git -C "$ROOT" archive "$SRC_REF" | tar -x -C "$SRC"
  COMMIT="$(git -C "$ROOT" rev-parse --short "$SRC_REF")"
fi
if [[ -n "${VERSION:-}" ]]; then
  (cd "$SRC/apps/desktop" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
fi
APP_VERSION="$(node -p "require('$SRC/apps/desktop/package.json').version")"
log "version $APP_VERSION (commit $COMMIT)"

# --- 2. macOS (native, arm64 + x64) --------------------------------------------------------------
build_mac() {
  local t0=$SECONDS
  log "macOS: pnpm install (compiles patched uiohook-napi for the host arch)"
  (cd "$SRC" && pnpm install --frozen-lockfile)
  # MAIN_VITE_* are baked in by electron-vite: the feed, and "updates may auto-install" only when signed
  (cd "$SRC/apps/desktop" && MAIN_VITE_UPDATE_FEED="$UPDATE_URL" MAIN_VITE_UPDATES_SIGNED="${SIGN:+1}" pnpm build:app)   # + build/.gen/THIRD-PARTY-NOTICES.txt (extraResources)
  [[ -s "$SRC/apps/desktop/build/.gen/THIRD-PARTY-NOTICES.txt" ]] || { echo "THIRD-PARTY-NOTICES.txt not generated" >&2; exit 1; }
  # The patched module is compiled per arch into build/Release by electron-builder (node-gyp-build loads
  # that first). Drop the postinstall copy in bin/ (host arch only — it would land in the x64 app too)
  # and the unpatched upstream prebuilds.
  grep -q VC_CAPS_LOCK_STATE "$SRC/node_modules/uiohook-napi/libuiohook/include/uiohook.h" \
    || { echo "uiohook-napi patch is NOT applied" >&2; exit 1; }
  rm -rf "$SRC/node_modules/uiohook-napi/bin" "$SRC/node_modules/uiohook-napi/prebuilds"
  local sign_env=(CSC_IDENTITY_AUTO_DISCOVERY=false) mac_args=(--mac)
  env_value() { grep -E "^[[:space:]]*$1=" "$ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }
  # targets named on the CLI replace the yml ones (whose arch lists would otherwise win over --<arch>)
  [[ -n "${MAC_ARCH:-}" ]] && mac_args=(--mac dmg zip "--$MAC_ARCH")
  if [[ -n "${SIGN:-}" ]]; then
    local p12="$ROOT/cert/developerID_full.p12" pw
    pw="$(grep -E '^[[:space:]]*APPLE_CERT_PASSWORD=' "$ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
    [[ -f "$p12" && -n "$pw" ]] || { echo "SIGN=1: need cert/developerID_full.p12 and APPLE_CERT_PASSWORD in .env" >&2; exit 1; }
    # electron-builder.yml keeps builds unsigned (identity: null) — drop it in this build copy only
    sed -i '' '/^  identity: null/d' "$SRC/apps/desktop/electron-builder.yml"
    # Prefer the identity already in the login keychain (electron-builder's temporary keychain for
    # CSC_LINK fails on recent macOS: `security set-key-partition-list` cannot unlock it); CI imports the .p12.
    local ident
    ident="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
    if [[ -n "$ident" ]]; then
      sign_env=(CSC_IDENTITY_AUTO_DISCOVERY=true "CSC_NAME=${ident#Developer ID Application: }")
      echo "signing identity from the login keychain: $ident"
    else
      sign_env=(CSC_IDENTITY_AUTO_DISCOVERY=true "CSC_LINK=$p12" "CSC_KEY_PASSWORD=$pw")
    fi
    if [[ -n "${NOTARIZE:-}" ]]; then
      # notarytool via the App Store Connect API key (cert/AuthKey_<id>.p8 + ids from the root .env);
      # electron-builder staples the ticket. Notarization requires the secure timestamp.
      local kid iss team key
      kid="$(env_value APPLE_API_KEY_ID)"; iss="$(env_value APPLE_API_ISSUER)"; team="$(env_value APPLE_TEAM_ID)"
      key="$ROOT/cert/AuthKey_$kid.p8"
      [[ -n "$kid" && -n "$iss" && -f "$key" ]] || { echo "NOTARIZE=1: need APPLE_API_KEY_ID, APPLE_API_ISSUER in .env and cert/AuthKey_<id>.p8" >&2; exit 1; }
      sign_env+=("APPLE_API_KEY=$key" "APPLE_API_KEY_ID=$kid" "APPLE_API_ISSUER=$iss")
      [[ -n "$team" ]] && sign_env+=("APPLE_TEAM_ID=$team")
      mac_args+=(-c.mac.notarize=true)
      log "macOS: + NOTARIZATION (App Store Connect API key $kid)"
    else
      mac_args+=(-c.mac.notarize=false)
      # Apple's timestamp server fails intermittently under hundreds of requests from behind local VPNs,
      # and one miss aborts codesign. A local verification build doesn't need it (notarization does):
      # SIGN_TIMESTAMP=1 keeps the secure timestamp.
      [[ -n "${SIGN_TIMESTAMP:-}" ]] || mac_args+=(-c.mac.timestamp=none)
    fi
    log "macOS: SIGNED with cert/developerID_full.p12 (no notarization)"
  fi
  log "macOS: electron-builder ${mac_args[*]} (uiohook compiled from source per arch)"
  (cd "$SRC/apps/desktop" && env "${sign_env[@]}" pnpm exec electron-builder "${mac_args[@]}" \
    "${EB_COMMON[@]}" -c.directories.output=dist-release-mac)
  # each app must carry the patched module compiled for its own arch
  local app arch want
  for app in "$SRC"/apps/desktop/dist-release-mac/mac*/Calab.app; do
    case "$app" in *mac-arm64*) want=arm64 ;; *) want=x86_64 ;; esac
    arch="$(lipo -archs "$(find "$app" -name uiohook_napi.node | head -1)" 2>/dev/null || echo missing)"
    echo "uiohook native in $(basename "$(dirname "$app")"): $arch"
    [[ "$arch" == "$want" ]] || { echo "wrong/missing uiohook_napi.node in $app (want $want)" >&2; exit 1; }
  done
  # update feed: latest-mac.yml, or <channel>-mac.yml for prerelease versions (e.g. rc-mac.yml)
  cp "$SRC/apps/desktop/dist-release-mac"/{*.dmg,*.zip,*.blockmap} "$SRC/apps/desktop/dist-release-mac"/*-mac.yml "$OUT"/
  TIMES+="mac=$((SECONDS - t0)) "
}

# --- 3. Linux + Windows in Docker (local, or a remote x86_64 host) ------------------------------------
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30)
retry() { local n; for n in 1 2 3; do "$@" && return 0; echo "retry $n/3: $*" >&2; sleep $((n * 5)); done; return 1; }

# The in-container build script (runs as `bash -euo pipefail -s` with PLATFORM/EB_ARGS/... from an env file).
write_container_script() {
  cat > "$WORK/container.sh" <<'CONTAINER'
      export DEBIAN_FRONTEND=noninteractive
      # work on the container filesystem (bind mounts from macOS are slow for node_modules)
      mkdir -p /build && tar -C /src --exclude=node_modules --exclude="dist-release*" --exclude=out --exclude=dist -cf - . | tar -C /build -xf - && cd /build
      corepack enable >/dev/null 2>&1 || npm i -g corepack >/dev/null
      corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null
      # --ignore-scripts: no electron postinstall download (electron-builder fetches the Electron dist
      # itself); esbuild uses its optional platform package; uiohook is compiled by electron-builder.
      pnpm install --frozen-lockfile --ignore-scripts
      grep -q VC_CAPS_LOCK_STATE node_modules/uiohook-napi/libuiohook/include/uiohook.h || { echo "uiohook patch NOT applied"; exit 1; }
      cd apps/desktop && pnpm build:app && test -s build/.gen/THIRD-PARTY-NOTICES.txt
      # electron-builder.yml ships only our patched uiohook build (upstream prebuilds excluded,
      # buildDependenciesFromSource). Linux: compile it here (X11 headers). Windows: node-gyp cannot
      # cross-compile for win32, so there is no module — the check below fails the build.
      rebuild=false
      if [[ "$PLATFORM" == win ]] && ! grep -q "prebuilds/win32-x64" electron-builder.yml; then
        echo "electron-builder.yml has no win32-x64 prebuild FileSet (older commit): using a generated override"
        EB_ARGS="$EB_ARGS --config electron-builder.win.yml"
        cat > electron-builder.win.yml <<'YML'
extends: ./electron-builder.yml
win:
  files:
    - from: .
      filter:
        # the directory itself too: the global `prebuilds/**` exclusion also matches it
        - "**/node_modules/uiohook-napi/prebuilds"
        - "**/node_modules/uiohook-napi/prebuilds/win32-x64/**"
YML
      fi
      if [[ "$PLATFORM" == linux ]]; then
        apt-get update -qq >/dev/null
        apt-get install -y -qq libx11-dev libxtst-dev libxt-dev libxinerama-dev libx11-xcb-dev \
          libxkbcommon-dev libxkbcommon-x11-dev libxkbfile-dev libxrandr-dev >/dev/null
        rebuild=true
      fi
      eval "pnpm exec electron-builder $EB_ARGS --x64 -c.npmRebuild=$rebuild -c.directories.output=/build/rel"
      # a missing native module crashes main at startup (static import in ptt.ts): never ship that
      n=$(find /build/rel/*-unpacked -path "*uiohook*" -name "*.node" | head -1)
      if [[ -z "$n" ]]; then echo "ERROR: no uiohook .node in the $PLATFORM package — not publishing it" >&2; exit 3; fi
      echo "packaged native: ${n#/build/rel/} ($(od -An -tx1 -N5 "$n" | tr -d ' \n'))"
      if [[ "$PLATFORM" == linux && "$SMOKE" != 0 ]]; then
        echo "--- smoke: AppImage under Xvfb"
        apt-get install -y -qq xvfb x11-utils squashfs-tools libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libnotify4 libsecret-1-0 >/dev/null
        cd /tmp && app=$(ls /build/rel/*.AppImage | head -1)
        # extract the embedded squashfs (portable: also works where the AppImage runtime cannot exec,
        # e.g. under Rosetta/qemu on Apple Silicon, which reject its marked ELF header)
        off=$(python3 -c "import struct;h=open('$app','rb').read(64);o,=struct.unpack_from('<Q',h,40);e,c=struct.unpack_from('<HH',h,58);print(o+e*c)")
        unsquashfs -q -o "$off" -d sq "$app" >/dev/null
        export DISPLAY=:99; Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 & sleep 2
        ./sq/calab --no-sandbox --disable-gpu > run.log 2>&1 & pid=$!
        sleep 20
        kill -0 $pid 2>/dev/null && echo "smoke: process alive after 20 s" || { echo "smoke: process EXITED"; tail -20 run.log; exit 4; }
        w=$(xwininfo -root -tree | grep -c '"Calab"' || true); echo "smoke: X windows titled Calab: $w"
        grep -iE "uiohook|error" ~/.config/Calaba/logs/main.log 2>/dev/null | head -5 || true
        kill $pid 2>/dev/null || true; [[ "$w" -ge 1 ]] || exit 4
      fi
      cd /build/rel
      cp -v *.AppImage *.deb ./*-linux.yml /out/ 2>/dev/null || true   # latest-linux.yml or <channel>-linux.yml
      cp -v *.exe *.exe.blockmap /out/ 2>/dev/null || true
      for y in latest.yml alpha.yml beta.yml rc.yml; do if [[ -f "$y" ]]; then cp -v "$y" /out/; fi; done
CONTAINER
}

build_docker() { # $1 = linux | win
  local t0=$SECONDS platform="$1" args host rc=0 limits=()
  case "$platform" in
    linux) args="--linux AppImage deb"; host="${BUILD_DOCKER_HOST:-}" ;;
    # Windows (decision 2026-09-26, option b): node-gyp cannot compile for win32 outside Windows, so the
    # upstream N-API prebuild prebuilds/win32-x64 is re-included for the win target only. Our patch touches
    # only libuiohook's darwin code (+ a define used there), so on Windows it is the same module.
    # macOS/Linux keep the strict "patched build from source" policy of electron-builder.yml.
    # electron-builder.yml carries this as a `win.files` FileSet (client, 2026-09-26). For commits made
    # before that, the container generates the same override (electron-builder.win.yml) — see below.
    win)   args="--win nsis"
           host="${WIN_DOCKER_HOST:-${BUILD_DOCKER_HOST:-}}" ;;
  esac
  write_container_script
  # env-file values are taken literally; EB_ARGS is re-parsed by `eval` inside the container
  printf '%s\n' "PNPM_VERSION=$PNPM_VERSION" CI=true "PLATFORM=$platform" "SMOKE=${SMOKE:-1}" \
    "EB_ARGS=$args $(printf '%q ' "${EB_COMMON[@]}")" "MAIN_VITE_UPDATE_FEED=$UPDATE_URL" > "$WORK/container.env"
  local run=(docker run --rm -i --platform linux/amd64 --env-file ENVFILE
    -v SRC:/src:ro -v OUT:/out
    -v calaba-release-pnpm-store:/root/.local/share/pnpm/store -v calaba-release-electron-cache:/root/.cache)
  if [[ -n "$host" ]]; then
    # One plain ssh session per step (DOCKER_HOST=ssh:// opens many and trips sshd's MaxStartups).
    local r="${host#ssh://}" rdir="/tmp/calaba-release-$$-$platform"
    log "Docker ($platform) on $r"
    retry ssh "${SSH_OPTS[@]}" "$r" "rm -rf $rdir && mkdir -p $rdir/src $rdir/out" || return 1
    retry rsync -az --exclude node_modules --exclude 'dist*' --exclude out -e "ssh ${SSH_OPTS[*]}" "$SRC/" "$r:$rdir/src/" || return 1
    retry rsync -az -e "ssh ${SSH_OPTS[*]}" "$WORK/container.sh" "$WORK/container.env" "$r:$rdir/" || return 1
    # shared host: hard caps + lowest CPU/IO priority (docker equivalents of nice/ionice)
    limits=(--cpus "${REMOTE_CPUS:-4}" --memory "${REMOTE_MEMORY:-6g}" --cpu-shares 128 --blkio-weight 10)
    local cmd="${run[*]} ${limits[*]} $BUILDER_IMAGE bash -euo pipefail -s < $rdir/container.sh"
    cmd="${cmd//ENVFILE/$rdir/container.env}"; cmd="${cmd//SRC:/$rdir/src:}"; cmd="${cmd//OUT:/$rdir/out:}"
    ssh "${SSH_OPTS[@]}" "$r" "$cmd" || rc=$?
    [[ $rc -eq 0 ]] && { retry rsync -az -e "ssh ${SSH_OPTS[*]}" "$r:$rdir/out/" "$OUT/" || rc=$?; }
    retry ssh "${SSH_OPTS[@]}" "$r" "rm -rf $rdir" || echo "WARNING: could not remove $r:$rdir" >&2
  else
    log "Docker ($platform, local): $BUILDER_IMAGE"
    run=("${run[@]/ENVFILE/$WORK/container.env}"); run=("${run[@]/#SRC:/$SRC:}"); run=("${run[@]/#OUT:/$OUT:}")
    "${run[@]}" "$BUILDER_IMAGE" bash -euo pipefail -s < "$WORK/container.sh" || rc=$?
  fi
  TIMES+="$platform=$((SECONDS - t0)) "
  return $rc
}

FAILED=""
for p in "${platforms[@]}"; do [[ "$p" == mac ]] && build_mac; done
for p in "${platforms[@]}"; do
  case "$p" in
    linux) build_docker linux || FAILED+="linux " ;;
    win)
      if [[ "$(uname -m)" == arm64 && -z "${WIN_DOCKER_HOST:-${BUILD_DOCKER_HOST:-}}" ]]; then
        echo "WARNING: Windows NSIS cannot be built on Apple Silicon Docker (32-bit wine under qemu crashes);" >&2
        echo "         set BUILD_DOCKER_HOST=ssh://user@x86_64-linux-host." >&2
        FAILED+="win "
      else
        build_docker win || FAILED+="win "
      fi ;;
  esac
done

log "artifacts in $OUT"
ls -lh "$OUT" | awk 'NR>1 {print $5, $9}'
for kv in $TIMES; do t=${kv#*=}; echo "time[${kv%%=*}]: $((t / 60))m$((t % 60))s"; done
[[ -z "$FAILED" ]] || { echo "FAILED: $FAILED" >&2; exit 2; }
