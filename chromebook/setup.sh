#!/bin/bash
# Prepares a developer-mode Chromebook for `cb`. Run as root from the VT2 console
# (Ctrl+Alt+→, log in as root), not from crosh: crosh's shell cannot become root.
#
#   - Chrome listens for DevTools on 127.0.0.1:9222 (reachable only through SSH)
#   - Tailscale runs at boot (userspace networking) with Tailscale SSH on
#   - the Chromebook never sleeps on idle or lid close (skip with --keep-sleep)
#
# Usage: setup.sh [--hostname chromebook] [--keep-sleep]
set -euo pipefail

HOSTNAME_ARG=chromebook
KEEP_SLEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) HOSTNAME_ARG="$2"; shift 2 ;;
    --keep-sleep) KEEP_SLEEP=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root from the VT2 console (Ctrl+Alt+→)"
[ "$(crossystem cros_debug 2>/dev/null)" = 1 ] || die "this Chromebook is not in developer mode"

if ! touch /etc/.cb-write-test 2>/dev/null; then
  cat >&2 <<'EOF'
setup: the system partition is read-only. Turn off rootfs verification, reboot, and run this again:

  /usr/libexec/debugd/helpers/dev_features_rootfs_verification
  reboot
EOF
  exit 1
fi
rm -f /etc/.cb-write-test

say "Chrome remote debugging"
if grep -q -- '--remote-debugging-port=' /etc/chrome_dev.conf 2>/dev/null; then
  echo "already set in /etc/chrome_dev.conf"
  RESTART_UI=0
else
  echo '--remote-debugging-port=9222' >> /etc/chrome_dev.conf
  echo "added --remote-debugging-port=9222 to /etc/chrome_dev.conf"
  RESTART_UI=1
fi

say "Tailscale"
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  armv7l|armv8l) ARCH=arm ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
TARBALL=$(curl -fsSL 'https://pkgs.tailscale.com/stable/?mode=json' \
  | grep -o "\"$ARCH\": *\"[^\"]*\.tgz\"" | head -1 | cut -d'"' -f4 || true)
[ -n "$TARBALL" ] || die "could not find a Tailscale build for $ARCH"
echo "installing $TARBALL to /usr/local/tailscale"
rm -rf /usr/local/tailscale.new
mkdir -p /usr/local/tailscale.new
curl -fsSL "https://pkgs.tailscale.com/stable/$TARBALL" | tar xzf - --strip-components=1 -C /usr/local/tailscale.new
rm -rf /usr/local/tailscale
mv /usr/local/tailscale.new /usr/local/tailscale
mkdir -p /usr/local/bin
ln -sf /usr/local/tailscale/tailscale /usr/local/bin/tailscale

cat > /etc/init/tailscaled.conf <<'EOF'
description "Tailscale (userspace networking) for remote Chrome DevTools"
start on started system-services
stop on stopping system-services
respawn
respawn limit 10 60

# Clear out any copy started by hand from the console before this one takes over.
pre-start script
  pkill -x tailscaled || true
  sleep 1
end script

exec /usr/local/tailscale/tailscaled --tun=userspace-networking --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock >>/var/log/tailscaled.log 2>&1
EOF
initctl reload-configuration
stop tailscaled 2>/dev/null || true
start tailscaled
sleep 3

say "Sleep"
if [ "$KEEP_SLEEP" = 1 ]; then
  echo "left alone (--keep-sleep)"
else
  echo 1 > /var/lib/power_manager/disable_idle_suspend
  echo 0 > /var/lib/power_manager/use_lid
  chown power:power /var/lib/power_manager/disable_idle_suspend /var/lib/power_manager/use_lid
  restart powerd >/dev/null
  echo "no suspend on idle or lid close (undo: rm /var/lib/power_manager/{disable_idle_suspend,use_lid}; restart powerd)"
fi

say "Old SSH server"
# The developer-mode SSH helper authorizes a publicly known root test key. Tailscale SSH replaces it.
if status openssh-server 2>/dev/null | grep -q running; then
  echo "warning: openssh-server is running. If the developer SSH helper enabled it, anyone who can reach"
  echo "this Chromebook can log in as root with a public key. Unless you set it up yourself, run:"
  echo "  stop openssh-server; rm /root/.ssh/authorized_keys"
else
  echo "not running"
fi

say "Sign in to Tailscale"
tailscale up --ssh --hostname="$HOSTNAME_ARG"

if [ "$RESTART_UI" = 1 ]; then
  say "Done. Chrome must restart to pick up the debugging flag (this signs you out):"
  echo "  restart ui"
else
  say "Done"
fi
echo "On your Mac: cb status"
