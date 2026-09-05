# CommandCenter

A full-screen wall dashboard for a Raspberry Pi running CasaOS — Google Calendar,
Gmail, container health, host stats, weather, tasks and news in one view.

```
┌──────────────┬────────────────────────────────┬──────────────┐
│  clock       │      CasaOS  (live iframe)      │  inbox       │
│  weather     ├───────────────┬────────────────┤  tasks       │
│  agenda      │  containers   │  pi stats      │  news        │
│              ├───────────────┴────────────────┤              │
│              │      services up / down        │              │
└──────────────┴────────────────────────────────┴──────────────┘
```

**Stack:** [Glance](https://github.com/glanceapp/glance) does the layout and most
widgets. A ~200-line Node **sidecar** covers Glance's two gaps — Google Calendar
*events* and Gmail — by exposing them as JSON that Glance's `custom-api` widget
renders. Both run as containers on the Pi. Chromium runs full-screen via `cage`.

---

## 1. Configure

```bash
cp .env.example .env
$EDITOR .env
```

Minimum to get a useful screen: `TZ`, `WEATHER_LOCATION`, `CASAOS_URL`,
`GOOGLE_ICAL_URL`. Everything else is optional.

- **`CASAOS_URL`** — use the Pi's LAN IP (`http://192.168.1.x`), not `localhost`,
  since the kiosk browser loads that iframe too.
- **`GOOGLE_ICAL_URL`** — Google Calendar → *Settings* → pick the calendar →
  *Integrate calendar* → **Secret address in iCal format**. Read-only, no OAuth.
- **`CPU_TEMP_SENSOR`** — `cat /sys/class/thermal/thermal_zone*/type` on the Pi.
  Usually `cpu_thermal`.

## 2. Run the dashboard

```bash
docker compose up -d --build
```

Open `http://<pi-ip>:8080` from any browser to check it before going full-screen.
Edit `glance/glance.yml` and it hot-reloads; edit `.env` and re-run
`docker compose up -d`.

Add your real services to the **Services** monitor block and the **News** feeds in
`glance/glance.yml`.

## 3. Kiosk mode on the Pi

On the Pi itself (Raspberry Pi OS Bookworm Lite, which is what CasaOS installs on):

```bash
cd CommandCenter
DASH_URL=http://localhost:8080 ./kiosk/setup.sh
sudo reboot          # for the console-blanking change
```

After reboot the monitor boots straight into the dashboard. Useful commands:

```bash
journalctl -u commandcenter-kiosk -f      # logs
sudo systemctl restart commandcenter-kiosk
sudo systemctl disable --now commandcenter-kiosk   # back to a normal console
```

The service waits for `:8080` to answer, runs Chromium under `cage` on tty1, and
restarts on crash.

---

## Calendar in the iframe

The big center panel is a Google Calendar **embed** (`GCAL_EMBED_URL`). Get the URL
from Calendar → *Settings* → your calendar → *Integrate calendar* → **Embed code**
(copy the `src="..."` value), or build it:
`https://calendar.google.com/calendar/embed?src=<CAL_ID>&ctz=<TZ>&mode=MONTH`.

A Google Calendar embed only renders if **one** of these is true:

1. **The calendar is public** — Calendar settings → *Access permissions* → "Make
   available to public". Simplest for a wall display; a dedicated "Home" calendar
   you share to the family keeps your work calendar out of it.
2. **The kiosk browser is signed into Google** — log the Pi's Chromium into the
   account once. Private calendars then render, but the session can lapse.
3. **Skip the embed** — the left-column **Agenda** panel already lists your next
   events from the private secret-iCal feed (no Google login, fully private). If
   that's enough, point `GCAL_EMBED_URL` at anything (or ask to swap the iframe
   for a bigger agenda / a self-hosted month grid).

The **Agenda** panel (`GOOGLE_ICAL_URL`) is independent of all this and always
uses the private feed.

## Gmail setup (optional)

The sidecar reads Gmail with an OAuth **refresh token** (app passwords are being
retired). One-time:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Enable APIs** → enable **Gmail API**.
3. **OAuth consent screen** → *External* → add your own email as a **test user**.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy the
   client ID and secret into `.env`.
5. Get a refresh token: [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
   → gear icon → *Use your own OAuth credentials* → paste ID/secret → in the left
   list authorize scope `https://www.googleapis.com/auth/gmail.readonly` →
   *Exchange authorization code for tokens* → copy the **refresh token** into
   `GMAIL_REFRESH_TOKEN`.
6. `docker compose up -d` — the **Inbox** widget populates within a few minutes.

Tune what counts with `GMAIL_QUERY` (any Gmail search, e.g.
`is:unread in:inbox -category:promotions`).

---

## Customizing the look

`glance/assets/theme.css` is the skin — phosphor-amber on black, mono font,
scanlines. Colors also live in the `theme:` block of `glance/glance.yml`, and
Glance has an on-screen picker (top right) for live tweaking; paste the result
back into the config. Delete the `body::after` block in `theme.css` to drop the
CRT scanlines.

## Notes / gotchas

- **CasaOS in an iframe** — if the center panel is blank, CasaOS is sending
  `X-Frame-Options`. Either allow framing in its reverse proxy, or swap the
  `iframe` widget for a `bookmarks` tile and lean on the native container widget.
- **Host stats** — `server-stats` reads real host CPU/RAM/disk via the `pid: host`
  + `/:/host:ro` mount in `docker-compose.yml`. If disk shows the container's
  view, add `mountpoints:` filters under the widget (see Glance docs).
- **Pi 3 or older** — drop the iframe and scanlines; Chromium compositing is the
  bottleneck.

## Layout

```
docker-compose.yml     glance + sidecar
glance/glance.yml      widgets & layout
glance/assets/         theme.css, fonts
sidecar/server.js      /calendar.json, /mail.json
kiosk/setup.sh         installs the Chromium kiosk service on the Pi
kiosk/kiosk.service    the systemd unit it installs
```
