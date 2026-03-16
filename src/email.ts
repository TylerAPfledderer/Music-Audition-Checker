import { google } from "googleapis";

import { PlaybillFinding } from "./playbill-crawler";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface UrlConfig {
  name: string;
  url: string;
  crawlMode?: "playbill";
}

export interface AuditionAnalysis {
  hasRelevantAuditions: boolean;
  summary: string | null;
  futureDates: string[];
  relevantItems: string[];
}

export interface ProbeFailure {
  name: string;
  url: string;
  reason: "fetch-failed" | "not-audition-page";
  detail: string;
}

// ─── Email (Gmail API + OAuth2) ───────────────────────────────────────────────

/**
 * RFC 2047 Base64-encodes a string for use in MIME headers (e.g. Subject).
 * Email headers must be ASCII-only; non-ASCII characters (emojis, em dashes)
 * require encoded-word format: =?charset?encoding?encoded_text?=
 */
export function encodeSubjectRfc2047(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
}

/**
 * Gmail API requires raw MIME messages encoded as base64url. `buildEmailRaw` constructs
 * the MIME envelope so `sendEmail` stays focused on content assembly. The two functions
 * together form a simple Template Method: structure is fixed, content is variable.
 */
export function buildEmailRaw(params: {
  from: string;
  to: string;
  subject: string;
  html: string;
}): string {
  const message = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${encodeSubjectRfc2047(params.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    params.html,
  ].join("\r\n");

  // Gmail API requires base64url encoding
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Looks up a Gmail label by name. If it doesn't exist, creates it and returns the new ID.
 * Uses the Gmail API labels.list + labels.create endpoints.
 */
async function getOrCreateLabel(
  gmail: ReturnType<typeof google.gmail>,
  name: string
): Promise<string> {
  const { data } = await gmail.users.labels.list({ userId: "me" });
  const existing = (data.labels ?? []).find((l) => l.name === name);
  if (existing?.id) return existing.id;

  const { data: created } = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name },
  });
  if (!created.id) throw new Error(`Failed to create Gmail label "${name}"`);
  return created.id;
}

/**
 * Digest email that aggregates all finding types into a single send.
 * Sending one email per run (rather than one per finding) is intentional:
 * it avoids inbox flooding when multiple sources become relevant simultaneously.
 *
 * The two finding types (`findings` for standard sources, `playbillFindings` for
 * the Playbill board) render as distinct sections with different visual treatments,
 * reflecting their different data shapes — standard findings link to an orchestra's
 * audition page while Playbill findings link to specific job listing URLs.
 */
export async function sendEmail(
  findings: Array<{ config: UrlConfig; analysis: AuditionAnalysis }>,
  probeFailures: ProbeFailure[] = [],
  playbillFindings: PlaybillFinding[] = []
): Promise<void> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const gmailUser = process.env.GMAIL_USER;
  const notifyEmail = process.env.NOTIFY_EMAIL || gmailUser;

  if (!clientId || !clientSecret || !refreshToken || !gmailUser) {
    throw new Error(
      "GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, and GMAIL_USER env vars are required"
    );
  }

  // Build OAuth2 client and set credentials
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let html = `
<h2>🎺 Trumpet Audition Alert — ${today}</h2>
<p>The following symphony pages have <strong>new relevant audition opportunities</strong>:</p>
<hr/>
`;

  for (const { config, analysis } of findings) {
    html += `<h3><a href="${config.url}">${config.name}</a></h3>
<p>${analysis.summary}</p>`;
    if (analysis.relevantItems.length > 0) {
      html += `<p><strong>Positions/Auditions:</strong></p><ul>`;
      for (const item of analysis.relevantItems) {
        html += `<li>${item}</li>`;
      }
      html += `</ul>`;
    }
    if (analysis.futureDates.length > 0) {
      html += `<p><strong>Dates:</strong> ${analysis.futureDates.join(", ")}</p>`;
    }
    html += `<p><a href="${config.url}">→ View page</a></p><hr/>`;
  }

  if (playbillFindings.length > 0) {
    html += `<h3 style="margin-top:24px;">🎭 Playbill Job Board</h3>
<p>The following Playbill listings mention trumpet:</p>`;
    for (const f of playbillFindings) {
      html += `<div style="margin-bottom:16px;padding:12px;border-left:4px solid #c0392b;">
<h4 style="margin:0 0 4px;"><a href="${f.listingUrl}">${f.title}</a></h4>
<p style="margin:0 0 4px;color:#555;"><em>${f.organization}</em></p>`;
      if (f.summary) {
        html += `<p style="margin:0 0 8px;">${f.summary}</p>`;
      }
      html += `<p style="margin:0;"><a href="${f.listingUrl}">→ View listing on Playbill</a></p>
</div>`;
    }
    html += `<hr/>`;
  }

  if (probeFailures.length > 0) {
    html += `<hr/><h3 style="color:#c0392b;">⚠️ URL Issues Detected</h3>
<p>The following URLs had problems during this run and were skipped. A GitHub issue has been created.</p><ul>`;
    for (const f of probeFailures) {
      const label = f.reason === "fetch-failed" ? "Could not fetch" : "Not an audition page";
      html += `<li><strong>${f.name}</strong> — ${label}<br/><code>${f.url}</code><br/><em>${f.detail}</em></li>`;
    }
    html += `</ul>`;
  }

  html += `<p style="color:#888;font-size:12px;">Sent by <a href="https://github.com/TylerAPfledderer/Music-Audition-Checker">audition-checker</a></p>`;

  const totalFindings = findings.length + playbillFindings.length;
  const warningTag = probeFailures.length > 0 ? " ⚠️" : "";
  const subject = `🎺 ${totalFindings} new trumpet audition${totalFindings > 1 ? "s" : ""} found — ${today}${warningTag}`;

  const raw = buildEmailRaw({
    from: `Audition Checker <${gmailUser}>`,
    to: notifyEmail!,
    subject,
    html,
  });

  const labelName = process.env.GMAIL_LABEL_NAME;
  if (labelName) {
    const labelId = await getOrCreateLabel(gmail, labelName);
    await gmail.users.messages.insert({
      userId: "me",
      requestBody: { raw, labelIds: [labelId, "INBOX"] },
    });
    console.log(`✉️  Email inserted into mailbox with label "${labelName}" for ${notifyEmail}`);
  } else {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    console.log(`✉️  Email sent to ${notifyEmail}`);
  }
}
