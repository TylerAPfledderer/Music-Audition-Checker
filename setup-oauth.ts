/**
 * One-time setup script to generate a Gmail OAuth2 refresh token.
 * Run this locally once, then add the printed values as GitHub Secrets.
 *
 * Usage:
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... npx ts-node setup-oauth.ts
 */

import * as readline from "readline";
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

// Use OOB redirect for CLI flows (no local server needed)
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent", // Force consent screen to always return a refresh_token
});

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  Gmail OAuth2 Setup");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
console.log("1. Open this URL in your browser:\n");
console.log(`   ${authUrl}\n`);
console.log("2. Sign in with your Gmail account and click Allow.");
console.log('3. Copy the authorization code shown ("Your code is: ...").\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Paste the authorization code here: ", async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());

    if (!tokens.refresh_token) {
      console.error(
        "\n❌ No refresh token returned. This usually means the account already\n" +
          "   authorized this app without 'prompt: consent'. To fix:\n" +
          "   → Go to https://myaccount.google.com/permissions\n" +
          "   → Revoke access for your app, then re-run this script."
      );
      process.exit(1);
    }

    console.log("\n✅ Success! Add these as GitHub Secrets:\n");
    console.log(`  GMAIL_CLIENT_ID       = ${clientId}`);
    console.log(`  GMAIL_CLIENT_SECRET   = ${clientSecret}`);
    console.log(`  GMAIL_REFRESH_TOKEN   = ${tokens.refresh_token}`);
    console.log(
      "\nThe refresh token does not expire unless you revoke app access."
    );
  } catch (err) {
    console.error("\n❌ Failed to exchange code for tokens:", err);
    process.exit(1);
  }
});
