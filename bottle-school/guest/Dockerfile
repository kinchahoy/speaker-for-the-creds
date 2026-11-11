# syntax=docker/dockerfile:1
# Guest base for the v5 image. Gondolin imports this filesystem as its rootfs (see build.json).
# BuildKit cache mounts keep apt, mise, npm, and uv downloads on the build host, so a rebuild
# after a tool change reuses earlier downloads. The caches never enter the image.
FROM ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944

# Tool choices live in three files: apt-packages.txt (Ubuntu), mise-config.toml (binaries and npm),
# and python/requirements.in (the default uv environment). Builds take the latest versions;
# guest/build.sh passes the date as REFRESH so the first build each day refreshes every layer.
ARG REFRESH
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=bind,source=apt-packages.txt,target=/tmp/apt-packages.txt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && sed 's/#.*//' /tmp/apt-packages.txt | xargs apt-get install -y --no-install-recommends \
 # Gondolin's init runs udhcpc with this script path; it writes the route and resolv.conf.
 && mkdir -p /usr/share/udhcpc && ln -sf /etc/udhcpc/default.script /usr/share/udhcpc/default.script

ARG TARGETARCH

# mise 2026.10.15 (checksum from the release SHASUMS256.txt)
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      MISE_BIN="mise-v2026.10.15-linux-arm64"; \
      MISE_SHA="3abbaac305a465ef038eb4ea07b961c037a8b639108005e43f8e2c00a8f67c11"; \
    else \
      MISE_BIN="mise-v2026.10.15-linux-x64"; \
      MISE_SHA="e3b186d4c70627f27037be615becaf4acfb30e41fb6a1819486717dc94e4e2a9"; \
    fi \
 && curl -fsSL -o /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v2026.10.15/$MISE_BIN" \
 && echo "$MISE_SHA  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise

COPY mise-config.toml /etc/mise/config.toml
ENV MISE_DATA_DIR=/opt/mise \
    MISE_GLOBAL_CONFIG_FILE=/etc/mise/config.toml \
    MISE_YES=1
# Symlink every installed tool binary into /usr/local/bin so the guest runs without mise on PATH.
# Always-on Pi extensions are linked into /opt/pi-extensions; pi-launch loads each one in every task.
# Every other Pi package is linked to /opt/pi-plugins/<name>, the stable path a catalog.json `extensions` entry
# names; a task loads it only through an approved `extension` lease (or attended mode, for ask-user-question).
# The owner exempted these low-download Pi extensions (a few hundred to ~1.6k weekly downloads when pinned) from
# aube's reputation checks; OSV malware checks still apply.
RUN --mount=type=cache,target=/root/.cache/mise \
    --mount=type=cache,target=/root/.npm \
    AUBE_ALLOWED_UNPOPULAR_PACKAGES=pi-loop-police,pi-token-speed,pi-cc-loop,pi-cc-monitor mise install \
 && for d in $(mise bin-paths); do \
      find "$d" -maxdepth 1 \( -type f -o -type l \) -perm -u+x -exec ln -sf {} /usr/local/bin/ \; ; \
    done \
 && link() { dir="$(mise where "npm:$1")/node_modules/$1"; jq -e .pi "$dir/package.json" >/dev/null && ln -s "$dir" "$2/${1##*/}"; } \
 && mkdir -p /opt/pi-extensions /opt/pi-plugins \
 && for p in pi-loop-police pi-token-speed; do link "$p" /opt/pi-extensions || exit 1; done \
 && for p in @juicesharp/rpiv-ask-user-question pi-web-access pi-cc-loop pi-cc-monitor; do link "$p" /opt/pi-plugins || exit 1; done \
 && mise ls --current > /opt/pi-v2-tool-versions.txt

# uv-managed CPython 3.13 and the default agent environment (glibc lock)
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_PYTHON_DOWNLOADS=automatic \
    UV_LINK_MODE=copy
COPY python/requirements.in /opt/uv/requirements.in
RUN --mount=type=cache,target=/root/.cache/uv \
    uv python install 3.13 \
 && uv venv --python 3.13 /opt/uv/venv \
 && uv pip install --python /opt/uv/venv --only-binary :all: -r /opt/uv/requirements.in \
 && rm /opt/uv/requirements.in
ENV UV_PYTHON_DOWNLOADS=never

# Optional browser automation (guest/build.sh with PI_GUEST_BROWSER=1): Python Playwright and its Chromium.
ARG BROWSER=0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    if [ "$BROWSER" = 1 ]; then \
      uv pip install --python /opt/uv/venv --only-binary :all: playwright \
   && ln -s /opt/uv/venv/bin/playwright /usr/local/bin/playwright \
   && playwright install --with-deps --only-shell chromium; \
    fi

# Trusted host scripts and config (Pi launchers)
COPY rootfs/ /
