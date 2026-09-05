#!/usr/bin/env bash
# CommandCenter kiosk installer for Raspberry Pi OS (Bookworm) Lite.
# Runs Chromium full-screen via `cage` (a minimal Wayland kiosk compositor) on tty1,
# no desktop environment. Idempotent — safe to re-run.
set -euo pipefail

DASH_URL="${DASH_URL:-http://localhost:8080}"
KIOSK_USER="${KIOSK_USER:-$USER}"
UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/kiosk.service"

echo "==> Installing packages (cage, seatd, chromium)"
sudo apt-get update
sudo apt-get install -y cage seatd curl
# Package name differs across releases; try both.
sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium

CHROMIUM_BIN="$(command -v chromium-browser || command -v chromium)"
echo "==> Chromium: $CHROMIUM_BIN"

echo "==> Enabling seatd and adding '$KIOSK_USER' to seat/video/input/render groups"
sudo systemctl enable --now seatd
sudo usermod -aG seat,video,input,render,tty "$KIOSK_USER"

echo "==> Disabling console blanking (adds consoleblank=0 to the kernel cmdline)"
CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
if [ -f "$CMDLINE" ] && ! grep -q 'consoleblank=0' "$CMDLINE"; then
  sudo sed -i 's/$/ consoleblank=0/' "$CMDLINE"
  echo "    (reboot required for this to take effect)"
fi

echo "==> Installing systemd unit -> /etc/systemd/system/commandcenter-kiosk.service"
sudo install -m 644 "$UNIT_SRC" /etc/systemd/system/commandcenter-kiosk.service
sudo sed -i \
  -e "s|__USER__|$KIOSK_USER|g" \
  -e "s|__CHROMIUM__|$CHROMIUM_BIN|g" \
  -e "s|__URL__|$DASH_URL|g" \
  /etc/systemd/system/commandcenter-kiosk.service

sudo systemctl daemon-reload
sudo systemctl enable commandcenter-kiosk.service

echo
echo "Done. Start now with:  sudo systemctl start commandcenter-kiosk"
echo "It will also autostart on boot. Logs:  journalctl -u commandcenter-kiosk -f"
