#!/usr/bin/env bash
# One-time: sign the kiosk's Chromium profile into Google so the calendar embed
# renders. Run this on the Pi (with keyboard + mouse on the monitor).
#
#   ./kiosk/google-login.sh
#
# It stops the kiosk, opens a normal Chromium window on the SAME profile the
# kiosk uses, you sign into your Google account, then close the window and the
# kiosk restarts. The session persists across reboots.
set -euo pipefail

PROFILE="$HOME/.commandcenter-chrome"
CHROMIUM="$(command -v chromium-browser || command -v chromium)"

echo "==> Stopping the kiosk"
sudo systemctl stop commandcenter-kiosk 2>/dev/null || true

echo "==> Opening Chromium on the kiosk profile — sign into Google, then CLOSE the window"
cage -- "$CHROMIUM" --user-data-dir="$PROFILE" \
  "https://accounts.google.com/ServiceLogin?continue=https://calendar.google.com/" || true

echo "==> Restarting the kiosk"
sudo systemctl start commandcenter-kiosk
echo "Done. The calendar should now show your events."
