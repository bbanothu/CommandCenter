# CommandCenter

A full-screen wall dashboard for a Raspberry Pi running CasaOS — Google Calendar,
Gmail, container health, host stats, weather and news in one view.

```
┌──────────────┬────────────────────────────────┬──────────────┐
│  clock       │                                │  inbox       │
│  weather     │   Google Calendar (embed)      │              │
│  containers  │                                │  news        │
│              ├────────────────────────────────┤              │
│              │  pi stats · services · links   │              │
└──────────────┴────────────────────────────────┴──────────────┘
```

**Stack:** [Glance](https://github.com/glanceapp/glance) does the layout and most
widgets. A small Node **sidecar** covers Glance's Gmail gap by exposing unread
mail as JSON for a `custom-api` widget. Both run as containers on the Pi.
Chromium runs full-screen via `cage`.

---

## 1. Configure

```bash
cp .env.example .env
$EDITOR .env
```

Minimum to get a useful screen: `TZ`, `WEATHER_LOCATION`, `CASAOS_URL`,
`GCAL_EMBED_URL`. Everything else is optional.

- **`CASAOS_URL`** — use the Pi's LAN IP (`http://192.168.1.x`), not `localhost`,
  since the kiosk browser reaches it too.
- **`GCAL_EMBED_URL`** — see "Calendar in the iframe" below.
- **`CPU_TEMP_SENSOR`** — `cat /sys/class/thermal/thermal_zone*/type` on the Pi.
  Usually `cpu_thermal`.
- **`GMAIL_*`** — optional, see "Gmail setup".
- `GOOGLE_ICAL_URL` is only used if you re-add an Agenda widget; leave it blank.

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
./kiosk/google-login.sh   # one-time: sign into Google so the calendar shows
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

The center panel is a Google Calendar **embed** (`GCAL_EMBED_URL`), built as:
`https://calendar.google.com/calendar/embed?src=<CAL_ID>&ctz=<TZ>&mode=MONTH`
(`<CAL_ID>` is usually your Gmail address, URL-encoded — `you%40gmail.com`).

A private calendar's embed only renders when the **display's browser is signed
into Google**. The kiosk service uses a persistent Chromium profile
(`~/.commandcenter-chrome`, no `--incognito`) so the login sticks across reboots.
Sign in once, on the Pi with keyboard + mouse:

```bash
./kiosk/google-login.sh
```

That stops the kiosk, opens a normal Chromium window on the kiosk's profile —
sign into your Google account, close the window, and the kiosk restarts with the
calendar populated. If the session ever lapses (rare), run it again.

The embed will **not** show in a logged-out browser, so don't expect it to render
when you're just spot-checking `:8088` from your laptop.

## Gmail setup (optional)

The sidecar reads Gmail with an OAuth **refresh token** (app passwords are being
retired). One-time:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Enable APIs** → enable **Gmail API**.
3. **OAuth consent screen** → *External* → add your own email as a **test user**.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy the
   client ID and secret into `.env`.
   Use client type **Desktop app**.
5. Get a refresh token — run the helper (any machine with Node 18+ and a browser):
   ```bash
   node sidecar/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
   ```
   Open the URL it prints, approve read-only Gmail access, and it prints
   `GMAIL_REFRESH_TOKEN=...` — paste that into `.env` along with the ID/secret.
6. `docker compose up -d` — the **Inbox** widget populates within a few minutes.

   *No refresh token from the OAuth Playground?* Google only issues one on the
   first consent per client. The helper above forces a fresh consent every run,
   so use it instead.

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
docker-compose.yml       glance + sidecar
glance/glance.yml        widgets & layout
glance/assets/           theme.css, fonts
sidecar/server.js        /mail.json (and an unused /calendar.json)
sidecar/get-refresh-token.mjs   one-time Gmail OAuth helper
kiosk/setup.sh           installs the Chromium kiosk service on the Pi
kiosk/kiosk.service      the systemd unit it installs
kiosk/google-login.sh    one-time Google sign-in for the calendar embed
```
