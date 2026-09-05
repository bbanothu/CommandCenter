// One-time helper: get a Gmail refresh token for the Inbox widget.
// Zero dependencies — runs on any machine with Node 18+ and a browser.
//
//   node get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//
// The OAuth client (Google Cloud Console → Credentials) must be type
// "Desktop app"  — that allows the http://localhost redirect below with no
// extra config. (If it's a "Web application" client instead, add
// http://localhost:4599  to its "Authorized redirect URIs" first.)
//
// Why you saw no refresh token before: Google only returns one on the *first*
// consent for a client. This script forces a fresh consent (prompt=consent),
// so it always comes back.

import http from "node:http";
import https from "node:https";

const CLIENT_ID = process.argv[2] || process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.argv[3] || process.env.GMAIL_CLIENT_SECRET;
const PORT = 4599;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Usage: node get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

function exchange(code) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      "https://oauth2.googleapis.com/token",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve(JSON.parse(data)));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) {
    res.end("Error: " + err);
    console.error("\n❌ " + err + "\n");
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.statusCode = 404;
    res.end();
    return;
  }

  res.end("Got it — close this tab and check your terminal.");
  server.close();

  const tok = await exchange(code);
  if (tok.refresh_token) {
    console.log("\n✅ Add this line to your .env:\n");
    console.log("GMAIL_REFRESH_TOKEN=" + tok.refresh_token + "\n");
  } else {
    console.log("\n⚠️  No refresh_token in the response:\n");
    console.log(tok);
    console.log(
      "\nRevoke this app at https://myaccount.google.com/permissions, then run again.\n",
    );
  }
  process.exit(0);
});

server.listen(PORT, () => {
  console.log("\n1. Open this URL in a browser, signed in as the Gmail account:\n");
  console.log("   " + authUrl + "\n");
  console.log('2. "Google hasn\'t verified this app" → Advanced → Go to … (it\'s your own app).');
  console.log("3. Approve read-only Gmail access. You'll be bounced back here and the token prints below.\n");
});
