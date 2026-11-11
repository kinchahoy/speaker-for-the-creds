#!/bin/sh
# Guest rootfs /init (guest/build.json init.rootfsInit). Gondolin 0.13.0's built-in ROOTFS_INIT_SCRIPT
# (dist/src/alpine/init-scripts.js) verbatim except the blocks marked "bottle-school:", which only remove boot latency.
# Re-derive it from the new built-in script when upgrading Gondolin. Gondolin appends its image-env block before the
# final exec of sandboxd.
set -eu

CONSOLE="/dev/console"
if [ ! -c "${CONSOLE}" ]; then
  if [ -c /dev/ttyAMA0 ]; then
    CONSOLE="/dev/ttyAMA0"
  elif [ -c /dev/ttyS0 ]; then
    CONSOLE="/dev/ttyS0"
  else
    CONSOLE=""
  fi
fi

log() {
  if [ -n "${CONSOLE}" ]; then
    printf "%s\n" "$*" > "${CONSOLE}" 2>/dev/null || printf "%s\n" "$*"
  else
    printf "%s\n" "$*"
  fi
}

log_cmd() {
  if [ -n "${CONSOLE}" ]; then
    "$@" > "${CONSOLE}" 2>&1 || "$@" || true
  else
    "$@" || true
  fi
}

# bottle-school: upstream's loop forks basename/cat/tr ~8 times per port (~60-100ms per call on a cold guest). This
# version uses shell builtins and skips ports the initramfs already linked (devtmpfs keeps its nodes across switch_root).
setup_virtio_ports() {
  if [ ! -d /sys/class/virtio-ports ]; then
    return
  fi

  [ -d /dev/virtio-ports ] || mkdir -p /dev/virtio-ports

  for port_path in /sys/class/virtio-ports/vport*; do
    if [ ! -e "${port_path}" ]; then
      continue
    fi

    port_device="${port_path##*/}"
    dev_node="/dev/${port_device}"

    if [ ! -c "${dev_node}" ] && [ -r "${port_path}/dev" ]; then
      dev_nums=""
      read -r dev_nums < "${port_path}/dev" || true
      major="${dev_nums%%:*}"
      minor="${dev_nums##*:}"
      if [ -n "${major}" ] && [ -n "${minor}" ]; then
        mknod "${dev_node}" c "${major}" "${minor}" 2>/dev/null || true
        chmod 600 "${dev_node}" 2>/dev/null || true
      fi
    fi

    if [ -r "${port_path}/name" ]; then
      port_name=""
      read -r port_name < "${port_path}/name" || true
      if [ -n "${port_name}" ] && [ ! -c "/dev/virtio-ports/${port_name}" ]; then
        ln -sf "../${port_device}" "/dev/virtio-ports/${port_name}" 2>/dev/null || true
      fi
    fi
  done
}

resolve_virtio_port_path() {
  expected="$1"

  if [ -c "/dev/virtio-ports/${expected}" ]; then
    printf "%s
" "/dev/virtio-ports/${expected}"
    return
  fi

  for port_path in /sys/class/virtio-ports/vport*; do
    if [ ! -e "${port_path}" ] || [ ! -r "${port_path}/name" ]; then
      continue
    fi

    port_name="$(cat "${port_path}/name" 2>/dev/null || true)"
    port_name="$(printf "%s" "${port_name}" | tr -d '\r\n')"
    if [ "${port_name}" = "${expected}" ]; then
      port_device="$(basename "${port_path}")"
      printf "%s
" "/dev/${port_device}"
      return
    fi
  done

  printf "%s
" "/dev/virtio-ports/${expected}"
}

# Ubuntu's update-ca-certificates re-reads every system CA with several forks each and rehashes the directory:
# ~1.8s of a ~3.5s cold boot. The image's /etc/ssl/certs already holds exactly the system CAs, so adding one local CA
# directly gives the state update-ca-certificates would leave: its .pem link, its OpenSSL subject-hash link, and the
# cert appended to the bundle. Every boot starts from the pristine image (rootfs.mode=cow).
trust_local_ca() {
  certs=/etc/ssl/certs
  pem="${1##*/}"
  pem="${pem%.crt}.pem"
  hash="$(openssl x509 -hash -noout -in "$1")" || return 1
  n=0
  while [ -e "${certs}/${hash}.${n}" ]; do n=$((n + 1)); done
  ln -sf "$1" "${certs}/${pem}" &&
    ln -sf "${pem}" "${certs}/${hash}.${n}" &&
    cat "${certs}/ca-certificates.crt" "$1" > "${certs}/ca-certificates.crt.new" &&
    chmod 0644 "${certs}/ca-certificates.crt.new" &&
    mv -f "${certs}/ca-certificates.crt.new" "${certs}/ca-certificates.crt"
}

setup_mitm_ca() {
  system_ca_bundle=""
  for candidate in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do
    if [ -r "${candidate}" ]; then
      system_ca_bundle="${candidate}"
      break
    fi
  done

  mitm_ca_cert="/etc/gondolin/mitm/ca.crt"
  if [ ! -r "${mitm_ca_cert}" ]; then
    if [ -n "${system_ca_bundle}" ]; then
      export SSL_CERT_FILE="${system_ca_bundle}"
    fi
    return
  fi

  mitm_ca_install="/usr/local/share/ca-certificates/gondolin-mitm-ca.crt"
  if mkdir -p /usr/local/share/ca-certificates 2>/dev/null; then
    if cp "${mitm_ca_cert}" "${mitm_ca_install}" 2>/dev/null; then
      # bottle-school: trust_local_ca replaces update-ca-certificates (see its comment).
      if trust_local_ca "${mitm_ca_install}"; then
        system_ca_bundle="/etc/ssl/certs/ca-certificates.crt"
      else
        log "[init] trusting the MITM CA in /etc/ssl/certs failed"
      fi
    fi
  fi

  runtime_ca_bundle="/run/gondolin/ca-certificates.crt"
  mkdir -p /run/gondolin
  : > "${runtime_ca_bundle}"

  if [ -n "${system_ca_bundle}" ] && [ -r "${system_ca_bundle}" ]; then
    cat "${system_ca_bundle}" >> "${runtime_ca_bundle}" 2>/dev/null || true
  fi

  printf "\n" >> "${runtime_ca_bundle}"
  cat "${mitm_ca_cert}" >> "${runtime_ca_bundle}" 2>/dev/null || true

  export SSL_CERT_FILE="${runtime_ca_bundle}"
  export CURL_CA_BUNDLE="${runtime_ca_bundle}"
  export REQUESTS_CA_BUNDLE="${runtime_ca_bundle}"
  export NODE_EXTRA_CA_CERTS="${mitm_ca_cert}"
}

mount -t proc proc /proc || log "[init] mount proc failed"
mount -t sysfs sysfs /sys || log "[init] mount sysfs failed"
mount -t devtmpfs devtmpfs /dev || log "[init] mount devtmpfs failed"

mkdir -p /dev/pts /dev/shm /run
mount -t devpts devpts /dev/pts || log "[init] mount devpts failed"
mount -t tmpfs tmpfs /run || log "[init] mount tmpfs failed"

# Standard /dev symlinks (needed for bash process substitution, /dev/stdin, ...)
for dev_link in fd:/proc/self/fd stdin:/proc/self/fd/0 stdout:/proc/self/fd/1 stderr:/proc/self/fd/2; do
  dev_name="/dev/${dev_link%%:*}"
  if [ ! -e "${dev_name}" ] && [ ! -L "${dev_name}" ]; then
    ln -s "${dev_link#*:}" "${dev_name}" 2>/dev/null || log "[init] symlink ${dev_name} failed"
  fi
done

export PATH=/usr/sbin:/usr/bin:/sbin:/bin

sandboxfs_mount="/data"
sandboxfs_binds=""
# scratch tmpfs mounts: "/path[:opt=value...][,/path...]" or "none"
gondolin_tmpfs="/root:mode=0700,/tmp,/var/cache,/var/log,/var/tmp"

if [ -r /proc/cmdline ]; then
  for arg in $(cat /proc/cmdline); do
    case "${arg}" in
      sandboxfs.mount=*)
        sandboxfs_mount="${arg#sandboxfs.mount=}"
        ;;
      sandboxfs.bind=*)
        sandboxfs_binds="${arg#sandboxfs.bind=}"
        ;;
      gondolin.tmpfs=*)
        gondolin_tmpfs="${arg#gondolin.tmpfs=}"
        ;;
    esac
  done
fi

mount_tmpfs_entry() {
  tmpfs_path="${1%%:*}"
  tmpfs_opts=""
  if [ "${tmpfs_path}" != "$1" ]; then
    tmpfs_opts="$(printf "%s" "${1#*:}" | tr ':' ',')"
  fi
  case "${tmpfs_path}" in
    /?*) ;;
    *)
      log "[init] ignoring invalid tmpfs entry $1"
      return 0
      ;;
  esac
  mkdir -p "${tmpfs_path}" 2>/dev/null || true
  if [ -n "${tmpfs_opts}" ]; then
    mount -t tmpfs -o "${tmpfs_opts}" tmpfs "${tmpfs_path}" || log "[init] mount tmpfs ${tmpfs_path} failed"
  else
    mount -t tmpfs tmpfs "${tmpfs_path}" || log "[init] mount tmpfs ${tmpfs_path} failed"
  fi
}

mkdir -p /tmp /home 2>/dev/null || true
if [ "${gondolin_tmpfs}" != "none" ]; then
  for tmpfs_entry in $(printf "%s" "${gondolin_tmpfs}" | tr ',' ' '); do
    mount_tmpfs_entry "${tmpfs_entry}"
  done
fi

export HOME=/root
export TMPDIR=/tmp
export UV_SYSTEM_CERTS=true

# bottle-school: upstream lists /dev, /dev/virtio-ports, and /sys/class/virtio-ports here. Every console byte is a
# trapped serial-port write, so those ~200 debug lines cost ~0.25s per boot; they are dropped.

if modprobe virtio_console > /dev/null 2>&1; then
  log "[init] loaded virtio_console"
fi
setup_virtio_ports
if modprobe virtio_rng > /dev/null 2>&1; then
  log "[init] loaded virtio_rng"
fi
if [ -e /dev/hwrng ]; then
  log "[init] starting rngd"
  rngd -r /dev/hwrng -o /dev/random > /dev/null 2>&1 &
else
  log "[init] /dev/hwrng missing"
fi

if modprobe virtio_net > /dev/null 2>&1; then
  log "[init] loaded virtio_net"
fi

if command -v ip > /dev/null 2>&1; then
  ip link set lo up || true
  ip link set eth0 up || true
elif command -v ifconfig > /dev/null 2>&1; then
  ifconfig lo up || true
  ifconfig eth0 up || true
else
  log "[init] no network link tool (ip/ifconfig)"
fi

# bottle-school: the initramfs already ran DHCP; the address and route survive switch_root and it copied resolv.conf.
# A second lease here only repeats that (~60-200ms), so it runs only when the initramfs did not configure eth0.
if [ -s /etc/resolv.conf ] && [ -n "$(ip -4 -o addr show dev eth0 scope global 2>/dev/null)" ]; then
  log "[init] eth0 configured by the initramfs"
elif command -v udhcpc > /dev/null 2>&1; then
  UDHCPC_SCRIPT="/usr/share/udhcpc/default.script"
  if [ ! -x "${UDHCPC_SCRIPT}" ]; then
    UDHCPC_SCRIPT="/sbin/udhcpc.script"
  fi
  if [ -x "${UDHCPC_SCRIPT}" ]; then
    udhcpc -i eth0 -q -n -s "${UDHCPC_SCRIPT}" || log "[init] udhcpc failed"
  else
    udhcpc -i eth0 -q -n || log "[init] udhcpc failed"
  fi
fi

if modprobe fuse > /dev/null 2>&1; then
  log "[init] loaded fuse"
fi

wait_for_sandboxfs() {
  # bottle-school: poll every 10ms (upstream: 100ms) with the same 30s limit; the mount usually takes ~20-60ms.
  for i in $(seq 1 3000); do
    if grep -q " ${sandboxfs_mount} fuse.sandboxfs " /proc/mounts; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

mkdir -p "${sandboxfs_mount}"

sandboxfs_ready=0
sandboxfs_error="sandboxfs mount not ready"

setup_virtio_ports

if [ -x /usr/bin/sandboxfs ]; then
  log "[init] starting sandboxfs at ${sandboxfs_mount}"
  SANDBOXFS_LOG="${CONSOLE:-/dev/null}"
  if [ -z "${SANDBOXFS_LOG}" ]; then
    SANDBOXFS_LOG="/dev/null"
  fi
  sandboxfs_rpc_path="$(resolve_virtio_port_path virtio-fs)"
  log "[init] sandboxfs rpc path ${sandboxfs_rpc_path}"
  sandboxfs_binds_file="/run/sandboxfs.binds"
  rm -f "${sandboxfs_binds_file}"
  /usr/bin/sandboxfs --mount "${sandboxfs_mount}" --rpc-path "${sandboxfs_rpc_path}" --binds-file "${sandboxfs_binds_file}" > "${SANDBOXFS_LOG}" 2>&1 &

  if wait_for_sandboxfs; then
    sandboxfs_ready=1
    # sandboxfs writes the bind list (fetched from the host) before mounting.
    # Older hosts only provide it via the kernel cmdline, which is limited in
    # size, so only fall back to that if the file is missing.
    if [ ! -f "${sandboxfs_binds_file}" ] && [ -n "${sandboxfs_binds}" ]; then
      printf "%s\n" "${sandboxfs_binds}" | tr ',' '\n' > "${sandboxfs_binds_file}"
    fi
    if [ -f "${sandboxfs_binds_file}" ]; then
      while IFS= read -r bind; do
        if [ -z "${bind}" ]; then
          continue
        fi
        mkdir -p "${bind}"
        if [ "${sandboxfs_mount}" = "/" ]; then
          bind_source="${bind}"
        else
          bind_source="${sandboxfs_mount}${bind}"
        fi
        log "[init] binding sandboxfs ${bind_source} -> ${bind}"
        log_cmd mount --bind "${bind_source}" "${bind}"
      done < "${sandboxfs_binds_file}"
    fi
  else
    log "[init] sandboxfs mount not ready"
  fi
else
  log "[init] /usr/bin/sandboxfs missing"
  sandboxfs_error="sandboxfs binary missing"
fi

if [ "${sandboxfs_ready}" -eq 1 ]; then
  printf "ok\n" > /run/sandboxfs.ready
else
  printf "%s\n" "${sandboxfs_error}" > /run/sandboxfs.failed
fi

setup_mitm_ca

if [ -x /usr/bin/sandboxssh ]; then
  log "[init] starting sandboxssh"
  /usr/bin/sandboxssh > "${CONSOLE:-/dev/null}" 2>&1 &
else
  log "[init] /usr/bin/sandboxssh missing"
fi

if [ -x /usr/bin/sandboxingress ]; then
  log "[init] starting sandboxingress"
  /usr/bin/sandboxingress > "${CONSOLE:-/dev/null}" 2>&1 &
else
  log "[init] /usr/bin/sandboxingress missing"
fi

log "[init] starting sandboxd"

exec /usr/bin/sandboxd
