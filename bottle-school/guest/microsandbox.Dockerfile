# syntax=docker/dockerfile:1
# The microsandbox backend's guest, on Debian slim, in five layers (least-changing first). Latest releases throughout.
# The backend needs socat (vsock doors), sshfs (folders, later), dtach (attach), openssh-client, git, curl, ca-certificates.
FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive

# 1. System: only what mise does not provide (the git client, C libraries and their tools, kernel-facing tools, compilers).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client socat sshfs fuse3 dtach \
      build-essential cmake ninja-build pkg-config sqlite3 universal-ctags parallel \
      ffmpeg imagemagick poppler-utils qpdf tesseract-ocr tesseract-ocr-eng graphviz mediainfo libimage-exiftool-perl \
      fonts-dejavu-core fonts-liberation \
      strace lsof iproute2 procps zip unzip xz-utils file tree less rsync vim-tiny

# 2. Node, via mise (checksum from the release SHASUMS256.txt). Playwright needs it. `mise use -g` writes
# /etc/mise/config.toml; the later layers add their tools as /etc/mise/conf.d/*.toml. Shims are on PATH.
RUN if [ "$(dpkg --print-architecture)" = arm64 ]; then \
      MISE_BIN="mise-v2026.10.25-linux-arm64"; \
      MISE_SHA="bb09e88b13164ca90691a5cc042726d079f0ba26ab55527344cb173c2e83c998"; \
    else \
      MISE_BIN="mise-v2026.10.25-linux-x64"; \
      MISE_SHA="5d362ecc578dc7c146679b841dda949d6472cbf86ff5635db7afdca1b6b3fd87"; \
    fi \
 && curl -fsSL -o /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v2026.10.25/$MISE_BIN" \
 && echo "$MISE_SHA  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise
ENV MISE_DATA_DIR=/opt/mise \
    MISE_GLOBAL_CONFIG_FILE=/etc/mise/config.toml \
    MISE_YES=1 \
    PATH=/usr/local/bin:/opt/mise/shims:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_LINK_MODE=copy
RUN --mount=type=cache,target=/root/.cache/mise \
    mise use -g node@latest && mise reshim

# 3. Browser: Playwright and its Chromium with the system libraries it installs through apt.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.cache/mise \
    --mount=type=cache,target=/root/.npm \
    mise use -g npm:playwright@latest \
 && mise reshim \
 && playwright install --with-deps chromium

# 4. Toolchain: every other mise tool (microsandbox-mise.toml), then uv's managed CPython as the default python and
# python3 (there is no Debian python3). Add tools here; layers 1-3 stay cached.
COPY microsandbox-mise.toml /etc/mise/conf.d/tools.toml
RUN --mount=type=cache,target=/root/.cache/mise \
    --mount=type=cache,target=/root/.cache/uv \
    mise install \
 && mise reshim \
 && uv python install --default --preview 3.13 \
 && git lfs install --system

# 5. Agent: Pi and its extensions. Always-on extensions are linked into /opt/pi-extensions (pi-launch loads them in
# every task); the rest into /opt/pi-plugins, the paths catalog.json names.
COPY microsandbox-pi.toml /etc/mise/conf.d/pi.toml
RUN --mount=type=cache,target=/root/.cache/mise \
    --mount=type=cache,target=/root/.npm \
    AUBE_ALLOWED_UNPOPULAR_PACKAGES=pi-loop-police,pi-token-speed,pi-cc-loop,pi-cc-monitor mise install \
 && mise reshim \
 && link() { dir="$(mise where "npm:$1")/node_modules/$1"; jq -e .pi "$dir/package.json" >/dev/null && ln -s "$dir" "$2/${1##*/}"; } \
 && mkdir -p /opt/pi-extensions /opt/pi-plugins \
 && for p in pi-loop-police pi-token-speed; do link "$p" /opt/pi-extensions || exit 1; done \
 && for p in @juicesharp/rpiv-ask-user-question pi-web-access pi-cc-loop pi-cc-monitor; do link "$p" /opt/pi-plugins || exit 1; done \
 && ln -s "$(mise where npm:@earendil-works/pi-coding-agent)/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent" /opt/pi-plugins/subagent \
 && test -f /opt/pi-plugins/subagent/index.ts

COPY rootfs/ /
