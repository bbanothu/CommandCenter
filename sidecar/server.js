// CommandCenter sidecar — turns Google Calendar + a Gmail inbox into small JSON
// payloads that Glance's custom-api widget renders.
//
// Calendar reads through the Google Calendar API with the same OAuth refresh
// token as Gmail (add the calendar.readonly scope when minting it). A legacy
// secret-iCal path still works if GOOGLE_ICAL_URL is set and no OAuth is.
//
// Every endpoint always returns HTTP 200 with a usable shape (falling back to the
// last good cache, then to empty) so a flaky upstream never blanks the dashboard.

import fs from "node:fs";
import http from "node:http";
import express from "express";
import nodeIcal from "node-ical";
import { google } from "googleapis";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TZ = process.env.TZ || "UTC";

// LAN dashboard: let the kiosk browser POST container restarts cross-origin
// (the page is served by Glance on :8080, the sidecar answers on another port).
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── helpers ────────────────────────────────────────────────────────────────
const MIN = 60 * 1000;

const fmtTime = (d) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }).format(d);

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();

function dayLabel(d) {
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: TZ,
  }).format(d);
}

function relTime(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  if (sameDay(d, new Date())) return fmtTime(d);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: TZ }).format(d);
}

function cleanFrom(raw) {
  // "Jane Doe <jane@x.com>"  ->  "Jane Doe"     |     "bob@x.com" -> "bob@x.com"
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  return (m ? m[1] : raw).trim() || raw.trim();
}

// ─── Shared Google OAuth client ─────────────────────────────────────────────
// One refresh token, minted with both gmail.readonly and calendar.readonly,
// serves the Gmail and Calendar calls below.
const OAUTH_READY =
  process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN;

let oauthClient = null;
if (OAUTH_READY) {
  oauthClient = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );
  oauthClient.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
}

// ─── Google Calendar ────────────────────────────────────────────────────────
// Primary path: Calendar API via the shared OAuth client. Legacy fallback: a
// secret-iCal feed (GOOGLE_ICAL_URL) when no OAuth is configured.
const ICAL_URL = process.env.GOOGLE_ICAL_URL || "";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const LOOKAHEAD_DAYS = Number(process.env.GCAL_LOOKAHEAD_DAYS) || 14;

const calApi = OAUTH_READY ? google.calendar({ version: "v3", auth: oauthClient }) : null;

let calCache = { at: 0, data: null };

async function fetchCalendarApi() {
  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000);
  const res = await calApi.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: horizon.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 12,
  });

  const events = (res.data.items || []).map((ev) => {
    const allDay = Boolean(ev.start?.date);
    const start = new Date(ev.start?.dateTime || ev.start?.date);
    return {
      summary: ev.summary || "(no title)",
      start: start.toISOString(),
      startLabel: allDay ? "All day" : fmtTime(start),
      dayLabel: dayLabel(start),
      location: (ev.location || "").split(/[\r\n]/)[0].slice(0, 60),
      allDay,
    };
  });

  const data = { events, generated: new Date().toISOString() };
  calCache = { at: Date.now(), data };
  return data;
}

function expandOccurrences(ev, from, to) {
  if (!ev.rrule) return sameDay(ev.start, from) || ev.start >= from ? [ev.start] : [];
  // rrule.between handles the recurrence; exdate removes cancelled instances.
  // Note: node-ical + rrule has known DST edge cases — fine for a glanceable list.
  const exdates = new Set(Object.keys(ev.exdate || {}).map((k) => k.slice(0, 10)));
  return ev.rrule
    .between(from, to, true)
    .filter((d) => !exdates.has(d.toISOString().slice(0, 10)));
}

async function fetchCalendar() {
  if (calCache.data && Date.now() - calCache.at < 5 * MIN) return calCache.data;
  // Explicit iCal URL wins; otherwise use the Calendar API via OAuth.
  if (!ICAL_URL && calApi) return fetchCalendarApi();
  if (!ICAL_URL) return { events: [], note: "Calendar not configured" };

  const raw = await nodeIcal.async.fromURL(ICAL_URL);
  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000);
  const events = [];

  for (const key of Object.keys(raw)) {
    const ev = raw[key];
    if (ev.type !== "VEVENT") continue;
    const allDay = ev.datetype === "date";

    for (const start of expandOccurrences(ev, now, horizon)) {
      if (start > horizon) continue;
      if (start < now && !sameDay(start, now)) continue;
      events.push({
        summary: ev.summary || "(no title)",
        start: start.toISOString(),
        startLabel: allDay ? "All day" : fmtTime(start),
        dayLabel: dayLabel(start),
        location: (ev.location || "").split(/[\r\n]/)[0].slice(0, 60),
        allDay,
      });
    }
  }

  events.sort((a, b) => new Date(a.start) - new Date(b.start));
  const data = { events: events.slice(0, 12), generated: new Date().toISOString() };
  calCache = { at: Date.now(), data };
  return data;
}

// ─── Gmail ──────────────────────────────────────────────────────────────────
const GMAIL_READY = OAUTH_READY;
const GMAIL_QUERY = process.env.GMAIL_QUERY || "is:unread in:inbox";

const gmailClient = GMAIL_READY ? google.gmail({ version: "v1", auth: oauthClient }) : null;

let mailCache = { at: 0, data: null };

async function fetchMail() {
  if (!GMAIL_READY) return { unread: 0, messages: [], note: "Gmail not configured" };
  if (mailCache.data && Date.now() - mailCache.at < 3 * MIN) return mailCache.data;

  const list = await gmailClient.users.messages.list({
    userId: "me",
    q: GMAIL_QUERY,
    maxResults: 8,
  });
  const ids = (list.data.messages || []).map((m) => m.id);

  const messages = [];
  for (const id of ids) {
    const msg = await gmailClient.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const h = Object.fromEntries((msg.data.payload?.headers || []).map((x) => [x.name, x.value]));
    messages.push({
      from: cleanFrom(h.From || ""),
      subject: h.Subject || "(no subject)",
      date: relTime(h.Date),
    });
  }

  const data = {
    unread: list.data.resultSizeEstimate ?? messages.length,
    messages,
    generated: new Date().toISOString(),
  };
  mailCache = { at: Date.now(), data };
  return data;
}

// ─── Docker (container list + restart) ──────────────────────────────────────
// Talks to the Docker Engine API over the mounted unix socket. Powers the
// custom-api "Containers" widget, which can restart ("rerun") a container.
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const DOCKER_ENABLED = (() => {
  try {
    return fs.statSync(DOCKER_SOCKET).isSocket();
  } catch {
    return false;
  }
})();

function dockerRequest(method, path, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, method, path, timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body ? JSON.parse(body) : null);
        } else {
          reject(new Error(`docker ${method} ${path} → ${res.statusCode} ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("docker socket timeout")));
    req.on("error", reject);
    req.end();
  });
}

let containersCache = { at: 0, data: null };

async function fetchContainers() {
  if (!DOCKER_ENABLED) return { containers: [], note: "Docker socket not mounted" };
  if (containersCache.data && Date.now() - containersCache.at < 5 * 1000) return containersCache.data;

  const raw = await dockerRequest("GET", "/containers/json?all=1");
  const containers = (raw || [])
    .map((c) => {
      const name = (c.Names?.[0] || c.Id).replace(/^\//, "");
      const health = (/\((healthy|unhealthy|health: starting)\)/.exec(c.Status || "") || [])[1] || "";
      return {
        id: c.Id.slice(0, 12),
        name,
        image: (c.Image || "").replace(/@sha256:.*/, ""),
        state: c.State, // running | exited | paused | restarting | created | dead
        status: c.Status || c.State, // "Up 3 hours (healthy)"
        health,
        running: c.State === "running",
      };
    })
    .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));

  const data = { containers, generated: new Date().toISOString() };
  containersCache = { at: Date.now(), data };
  return data;
}

// ─── routes ─────────────────────────────────────────────────────────────────
app.get("/calendar.json", async (_req, res) => {
  try {
    res.json(await fetchCalendar());
  } catch (err) {
    console.error("calendar:", err.message);
    res.json(calCache.data ?? { events: [], note: "calendar upstream error" });
  }
});

app.get("/mail.json", async (_req, res) => {
  try {
    res.json(await fetchMail());
  } catch (err) {
    console.error("mail:", err.message);
    res.json(mailCache.data ?? { unread: 0, messages: [], note: "gmail upstream error" });
  }
});

app.get("/containers.json", async (_req, res) => {
  try {
    res.json(await fetchContainers());
  } catch (err) {
    console.error("containers:", err.message);
    res.json(containersCache.data ?? { containers: [], note: "docker upstream error" });
  }
});

// Restart a single container by id or name. Only names/ids from the current
// list are accepted — no arbitrary Docker calls.
app.post("/containers/:id/restart", async (req, res) => {
  if (!DOCKER_ENABLED) return res.status(503).json({ ok: false, error: "Docker socket not mounted" });
  const id = String(req.params.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) {
    return res.status(400).json({ ok: false, error: "bad container id" });
  }
  try {
    const { containers } = await fetchContainers();
    if (!containers.some((c) => c.id === id || c.name === id)) {
      return res.status(404).json({ ok: false, error: "unknown container" });
    }
    await dockerRequest("POST", `/containers/${encodeURIComponent(id)}/restart?t=5`);
    containersCache = { at: 0, data: null };
    res.json({ ok: true });
  } catch (err) {
    console.error("restart:", err.message);
    res.status(502).json({ ok: false, error: "restart failed" });
  }
});

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.listen(PORT, () => {
  const cal = ICAL_URL ? "ical" : calApi ? `api(${CALENDAR_ID})` : "off";
  console.log(
    `sidecar :${PORT}  tz=${TZ}  calendar=${cal}  gmail=${GMAIL_READY ? "on" : "off"}  docker=${DOCKER_ENABLED ? "on" : "off"}`,
  );
});
