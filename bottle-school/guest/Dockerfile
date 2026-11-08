# syntax=docker/dockerfile:1
# Guest base for the v5 image. Gondolin imports this filesystem as its rootfs (see build.json).
# BuildKit cache mounts keep apt, mise, npm, and uv downloads on the build host, so a rebuild
# after a tool change reuses earlier downloads. The caches never enter the image.
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c

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

# mise 2026.10.25 (checksum from the release SHASUMS256.txt)
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      MISE_BIN="mise-v2026.10.25-linux-arm64"; \
      MISE_SHA="bb09e88b13164ca90691a5cc042726d079f0ba26ab55527344cb173c2e83c998"; \
    else \
      MISE_BIN="mise-v2026.10.25-linux-x64"; \
      MISE_SHA="5d362ecc578dc7c146679b841dda949d6472cbf86ff5635db7afdca1b6b3fd87"; \
    fi \
 && curl -fsSL -o /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v2026.10.25/$MISE_BIN" \
 && echo "$MISE_SHA  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise

COPY mise-config.toml /etc/mise/config.toml
ENV MISE_DATA_DIR=/opt/mise \
    MISE_GLOBAL_CONFIG_FILE=/etc/mise/config.toml \
    MISE_YES=1
# Symlink every installed tool binary into /usr/local/bin so the guest runs without mise on PATH.
# Link every npm package with a `pi` manifest into /opt/pi-extensions; pi-launch loads each one.
# The owner exempted these low-download Pi extensions from aube's reputation checks; OSV malware checks still apply.
RUN --mount=type=cache,target=/root/.cache/mise \
    --mount=type=cache,target=/root/.npm \
    AUBE_ALLOWED_UNPOPULAR_PACKAGES=pi-loop-police,pi-token-speed mise install \
 && for d in $(mise bin-paths); do \
      find "$d" -maxdepth 1 \( -type f -o -type l \) -perm -u+x -exec ln -sf {} /usr/local/bin/ \; ; \
    done \
 && mkdir -p /opt/pi-extensions \
 && for p in /opt/mise/installs/npm-*/*/node_modules/*/package.json; do \
      if jq -e .pi "$p" >/dev/null; then ln -s "$(dirname "$p")" /opt/pi-extensions/; fi; \
    done \
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
