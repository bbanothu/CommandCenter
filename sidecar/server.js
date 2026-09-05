// CommandCenter sidecar — turns a Google secret-iCal feed and a Gmail inbox into
// small JSON payloads that Glance's custom-api widget renders.
//
// Every endpoint always returns HTTP 200 with a usable shape (falling back to the
// last good cache, then to empty) so a flaky upstream never blanks the dashboard.

import express from "express";
import nodeIcal from "node-ical";
import { google } from "googleapis";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TZ = process.env.TZ || "UTC";

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

// ─── Google Calendar (secret iCal URL) ──────────────────────────────────────
const ICAL_URL = process.env.GOOGLE_ICAL_URL || "";
const LOOKAHEAD_DAYS = Number(process.env.GCAL_LOOKAHEAD_DAYS) || 14;

let calCache = { at: 0, data: null };

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
  if (!ICAL_URL) return { events: [], note: "GOOGLE_ICAL_URL not set" };
  if (calCache.data && Date.now() - calCache.at < 5 * MIN) return calCache.data;

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
const GMAIL_READY =
  process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_QUERY = process.env.GMAIL_QUERY || "is:unread in:inbox";

let gmailClient = null;
if (GMAIL_READY) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  gmailClient = google.gmail({ version: "v1", auth: oauth2 });
}

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

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.listen(PORT, () => {
  console.log(`sidecar :${PORT}  tz=${TZ}  calendar=${ICAL_URL ? "on" : "off"}  gmail=${GMAIL_READY ? "on" : "off"}`);
});
