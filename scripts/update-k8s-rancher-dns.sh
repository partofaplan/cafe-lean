#!/usr/bin/env bash
# Dynamically map k8s.rancher.private -> your current host IP via dnsmasq on macOS.
# - Requires Homebrew and dnsmasq (`brew install dnsmasq`)
# - Creates/updates /etc/resolver/k8s.rancher.private to use 127.0.0.1
# - Writes dnsmasq config snippet with your current IP and reloads the service

set -euo pipefail

DOMAIN="k8s.rancher.private"

brew_bin="$(command -v brew || true)"
if [[ -z "${brew_bin}" ]]; then
  echo "Homebrew not found. Install from https://brew.sh first." >&2
  exit 1
fi

if ! "${brew_bin}" list dnsmasq >/dev/null 2>&1; then
  echo "Installing dnsmasq via Homebrew..."
  "${brew_bin}" install dnsmasq
fi

# Determine brew prefix and dnsmasq conf dir (Apple Silicon vs Intel)
BREW_PREFIX="$(${brew_bin} --prefix)"
DNSMASQ_ETC="${BREW_PREFIX}/etc"
DNSMASQ_SNIPPETS_DIR="${DNSMASQ_ETC}/dnsmasq.d"
sudo mkdir -p "${DNSMASQ_SNIPPETS_DIR}"

# Detect primary IP (prefers route src, falls back to en0/en1)
IP="$(route -n get 1.1.1.1 2>/dev/null | awk '/src:/{print $2}')"
if [[ -z "${IP}" ]]; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
fi
if [[ -z "${IP}" ]]; then
  IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
if [[ -z "${IP}" ]]; then
  echo "Could not determine local IP. Are you connected to a network?" >&2
  exit 2
fi

CONF_FILE="${DNSMASQ_SNIPPETS_DIR}/k8s-rancher.conf"
echo "address=/${DOMAIN}/${IP}" | sudo tee "${CONF_FILE}" >/dev/null
echo "Wrote ${CONF_FILE} with ${IP}"

# Ensure macOS routes the domain to dnsmasq via resolver
sudo mkdir -p /etc/resolver
echo "nameserver 127.0.0.1" | sudo tee /etc/resolver/${DOMAIN} >/dev/null
echo "Updated /etc/resolver/${DOMAIN} to use 127.0.0.1"

# Start or reload dnsmasq
if ! sudo "${brew_bin}" services list | awk 'NR>1{print $1,$2}' | grep -q "^dnsmasq "; then
  echo "Starting dnsmasq via brew services..."
  sudo "${brew_bin}" services start dnsmasq
else
  echo "Reloading dnsmasq via brew services..."
  sudo "${brew_bin}" services reload dnsmasq || sudo "${brew_bin}" services restart dnsmasq
fi

echo "✅ ${DOMAIN} should now resolve to ${IP}. Test: ping -c1 ${DOMAIN}"

