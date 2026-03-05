/**
 * One-time setup script to generate a Gmail OAuth2 refresh token.
 * Run this locally once, then add the printed values as GitHub Secrets.
 *
 * Usage:
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... npx ts-node setup-oauth.ts
 */

import * as http from "http";
import { google } from "googleapis";

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set as environment variables.\n" +
      "See README.md → Gmail OAuth2 Setup for instructions."
  );
  process.exit(1);
}

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  Gmail OAuth2 Setup");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
console.log("1. Open this URL in your browser:\n");
console.log(`   ${authUrl}\n`);
console.log("2. Sign in with your Gmail account and click Allow.");
console.log("3. You will be redirected back automatically.\n");
console.log("Waiting for authorization...\n");

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Authorization failed</h1><p>Error: ${error}</p>`);
    console.error(`\n❌ Authorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>No authorization code received</h1>");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        "<h1>No refresh token returned</h1><p>Go to https://myaccount.google.com/permissions, revoke access for this app, and try again.</p>"
      );
      console.error(
        "\n❌ No refresh token returned. This usually means the account already\n" +
          "   authorized this app without 'prompt: consent'. To fix:\n" +
          "   → Go to https://myaccount.google.com/permissions\n" +
          "   → Revoke access for your app, then re-run this script."
      );
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>Success!</h1><p>You can close this window and return to the terminal.</p>"
    );

    console.log("✅ Success! Add these as GitHub Secrets:\n");
    console.log(`  GMAIL_CLIENT_ID       = ${clientId}`);
    console.log(`  GMAIL_CLIENT_SECRET   = ${clientSecret}`);
    console.log(`  GMAIL_REFRESH_TOKEN   = ${tokens.refresh_token}`);
    console.log(
      "\nThe refresh token does not expire unless you revoke app access."
    );

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h1>Failed to exchange code</h1><p>${err}</p>`);
    console.error("\n❌ Failed to exchange code for tokens:", err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Local server listening on http://localhost:${PORT}`);
});
