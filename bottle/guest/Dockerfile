# syntax=docker/dockerfile:1
# The Linux system inside every agent's VM (not a container to run). `bottle build` (guest/build.sh) builds it and
# loads it into microsandbox; run that again after editing. To add a command-line tool, add a line to
# locally-available-tools.md; to add a Pi extension, pin it in pi-package.json and list it in ../catalog.json.
# The guest image, on Debian slim, in five layers (least-changing first). Latest releases throughout, except the pinned
# Pi extensions. guest/build.sh builds it for the host architecture (linux/amd64 and linux/arm64 share this file) and
# loads it into microsandbox, which runs it as is.
# microsandbox needs socat (vsock doors), sshfs and fuse3 (folders), dtach (attach), openssh-client, git, curl, ca-certificates.
# What gets installed comes from one file, locally-available-tools.md, which the agent also reads: each `(<source> <package>)`
# goes to that source's layer. The lists stage splits it per source; a layer copies only its own list, so editing a
# description or another source's line leaves the layer cached.
FROM debian:trixie-slim AS lists
COPY locally-available-tools.md /tools.md
RUN mkdir /lists && grep '^- ' /tools.md | sed 's/: .*//' > /lists/prefixes \
 && for s in apt base browser mise uv; do grep -o "($s [^)]*)" /lists/prefixes | sed "s/^($s //; s/)\$//" > /lists/$s.txt; done \
 && grep -o '`[^`]*`' /lists/prefixes | tr -d '`' > /lists/commands.txt

FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive

# 1. System: the `apt` lines (the git client, C libraries and their tools, kernel-facing tools, compilers).
COPY --from=lists /lists/apt.txt /tmp/apt.txt
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      $(cat /tmp/apt.txt)

# 2. mise (checksum from the release SHASUMS256.txt) and the `base` lines: Node, which the browser layer needs, and uv. `mise use -g` writes
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
COPY --from=lists /lists/base.txt /tmp/base.txt
RUN --mount=type=cache,target=/root/.cache/mise \
    mise use -g $(sed 's/$/@latest/' /tmp/base.txt) && mise reshim

# 3. Browser: the `browser` lines (Playwright, agent-browser), then Playwright's Chromium with the system libraries it
# installs through apt. agent-browser uses that Chromium (/usr/local/bin/chromium) instead of downloading its own; its
# settings are in /etc/agent-browser.json (rootfs).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    AGENT_BROWSER_CONFIG=/etc/agent-browser.json \
    AGENT_BROWSER_NO_VERSION_CHECK=1
COPY --from=lists /lists/browser.txt /tmp/browser.txt
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.cache/mise \
    --mount=type=cache,target=/root/.npm \
    mise use -g $(sed 's/$/@latest/' /tmp/browser.txt) \
 && mise reshim \
 && playwright install --with-deps chromium \
 && chrome=$(ls /opt/pw-browsers/chromium-*/chrome-linux*/chrome | head -n 1) \
 && test -x "$chrome" && ln -s "$chrome" /usr/local/bin/chromium

# 4. Toolchain: the `mise` lines, then uv's managed CPython as the default python and python3 (there is no Debian
# python3) and the agent's default environment from the `uv` lines (first on PATH). The uv cache stays in the image
# (/opt/uv/cache, the venv hard-linked to it) so new environments install offline. Add most tools as `mise` or `uv`
# lines; only this layer rebuilds.
COPY --from=lists /lists/mise.txt /lists/uv.txt /tmp/
ENV VIRTUAL_ENV=/opt/uv/venv
ENV PATH=/opt/uv/venv/bin:$PATH
RUN --mount=type=cache,target=/root/.cache/mise \
    --mount=type=cache,target=/root/.cache/uv \
    mise use -g $(sed 's/$/@latest/' /tmp/mise.txt) \
 && mise reshim \
 && uv python install --default --preview 3.13 \
 && uv venv --python 3.13 /opt/uv/venv \
 && uv pip install --python /opt/uv/venv --only-binary :all: -r /tmp/uv.txt \
 && git lfs install --system

# 5. Agent: Pi and its extensions in one pnpm project (pi-package.json; their install scripts stay unrun), so the extensions share a single Pi instead of
# each installing their own as a peer dependency. Every dependency that declares a `pi` extension is linked automatically: the
# ALWAYS_ON ones into /opt/pi-extensions (pi-launch loads them in every agent), the rest into /opt/pi-plugins, the paths
# catalog.json names. /opt/pi-plugins.manifest lists what is linked there; `bottle build` copies it to the host, and
# bottle checks every catalog guestPath against it.
ARG ALWAYS_ON="pi-loop-police pi-token-speed proper-base pi-subagents"
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
 && { ls -d /opt/pi-plugins/*; find -L /opt/pi-plugins -maxdepth 2 -name index.ts; } | sort -u > /opt/pi-plugins.manifest

COPY rootfs/ /
# The agent's list of what is installed (its system note points here), and a check that every command it names exists.
COPY locally-available-tools.md /opt/locally-available-tools.md
COPY --from=lists /lists/commands.txt /tmp/commands.txt
RUN for c in $(cat /tmp/commands.txt); do \
      command -v "$c" >/dev/null || { echo "locally-available-tools.md names $c, which is not installed" >&2; exit 1; }; \
    done
