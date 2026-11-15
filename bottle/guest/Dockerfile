# syntax=docker/dockerfile:1
# The guest image, on Debian slim, in five layers (least-changing first). Latest releases throughout, except the pinned
# Pi extensions. guest/build.sh builds it for the host architecture (linux/amd64 and linux/arm64 share this file) and
# loads it into microsandbox, which runs it as is.
# microsandbox needs socat (vsock doors), sshfs and fuse3 (folders), dtach (attach), openssh-client, git, curl, ca-certificates.
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
      strace lsof iproute2 procps zip unzip xz-utils file tree less rsync vim-tiny \
      fd-find ripgrep

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
    UV_LINK_MODE=hardlink \
    UV_CACHE_DIR=/opt/uv/cache
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

# 4. Toolchain: every other mise tool (mise.toml), then uv's managed CPython as the default python and python3 (there is
# no Debian python3) and the agent's default environment (python/requirements.in, first on PATH). The uv cache stays in the image (/opt/uv/cache, the venv hard-linked to it) so new environments install offline. Add tools here;
# layers 1-3 stay cached.
COPY mise.toml /etc/mise/conf.d/tools.toml
COPY python/requirements.in /tmp/requirements.in
ENV VIRTUAL_ENV=/opt/uv/venv
ENV PATH=/opt/uv/venv/bin:$PATH
RUN --mount=type=cache,target=/root/.cache/mise \
    --mount=type=cache,target=/root/.cache/uv \
    mise install \
 && mise reshim \
 && uv python install --default --preview 3.13 \
 && uv venv --python 3.13 /opt/uv/venv \
 && uv pip install --python /opt/uv/venv --only-binary :all: -r /tmp/requirements.in \
 && git lfs install --system

# 5. Agent: Pi and its extensions in one pnpm project (pi-package.json; their install scripts stay unrun), so the extensions share a single Pi instead of
# each installing their own as a peer dependency. Every dependency that declares a `pi` extension is linked automatically: the
# ALWAYS_ON ones into /opt/pi-extensions (pi-launch loads them in every agent), the rest into /opt/pi-plugins, the paths
# catalog.json names. /opt/pi-plugins.manifest lists what is linked there; `bottle build` copies it to the host, and
# bottle checks every catalog guestPath against it.
ARG ALWAYS_ON="pi-loop-police pi-token-speed"
COPY pi-package.json /opt/pi/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm \
    --mount=type=cache,target=/root/.cache/pnpm \
    cd /opt/pi && pnpm install --config.strictDepBuilds=false \
 && ln -s /opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi \
 && mkdir -p /opt/pi-extensions /opt/pi-plugins \
 && for p in $(jq -r '.dependencies | keys[]' package.json); do \
      dir="/opt/pi/node_modules/$p"; \
      jq -e .pi "$dir/package.json" >/dev/null || continue; \
      case " $ALWAYS_ON " in *" $p "*) to=/opt/pi-extensions ;; *) to=/opt/pi-plugins ;; esac; \
      ln -s "$dir" "$to/${p##*/}"; \
    done \
 && ln -s /opt/pi/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent /opt/pi-plugins/subagent \
 && test -f /opt/pi-plugins/subagent/index.ts \
 && { ls -d /opt/pi-plugins/*; find -L /opt/pi-plugins -maxdepth 2 -name index.ts; } | sort -u > /opt/pi-plugins.manifest

COPY rootfs/ /
