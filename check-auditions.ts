/**
 * Module Overview — check-auditions.ts
 *
 * Single-entry-point GitHub Actions cron script that monitors external web pages
 * for trumpet audition opportunities and delivers email digests via Gmail API.
 *
 * Architectural mental model:
 *
 *   PREFLIGHT → STATE LOAD → PER-URL DISPATCH → STATE SAVE → EMAIL
 *
 * The two-phase design (preflight before any state mutation) is intentional:
 * infrastructure failures (bad secrets, unreachable URLs) are caught and reported
 * before the script can corrupt state or send misleading emails.
 *
 * Two crawl paradigms coexist and are dispatched by `crawlMode` on UrlConfig:
 *   - Standard (default): single-page fetch → Claude relevance check → notify on change
 *   - Playbill ("playbill"): index fetch → Claude listing extraction →
 *     per-listing detail fetch → Claude trumpet check → notify per matching listing
 *
 * State is persisted to audition-state.json and committed back to the repo by
 * the Actions workflow, making it the source of truth for "what has been seen
 * and notified." This avoids any external database dependency.
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";

import {
  MIN_CONTENT_LENGTH,
  fetchPage,
  fetchWithPuppeteer,
  stripHtml,
  scrapeUrl,
  contentHash,
} from "./scraper";
import {
  PlaybillListing,
  PlaybillFinding,
  PlaybillState,
  processPlaybillUrl,
} from "./playbill-crawler";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The optional `crawlMode` field is the extension point for non-standard sources.
 * Without it, a URL is treated as a single audition/careers page (the original model).
 * Adding a new crawl strategy only requires: a new literal type here, a new processor
 * function, and a branch in main().
 */
interface UrlConfig {
  name: string;
  url: string;
  crawlMode?: "playbill";
}

/**
 * Tracks the last-known state of a standard single-page source.
 * `contentHash` is the change-detection signal: if it matches the current fetch,
 * Claude is not called and no email is sent — keeping API costs proportional to
 * actual page changes rather than run frequency.
 * `hasRelevantAuditions` persists the previous relevance verdict so the system
 * can distinguish "newly relevant" (notify) from "still relevant" (suppress).
 */
interface PageState {
  url: string;
  name: string;
  lastChecked: string;
  contentHash: string;
  extractedSummary: string | null;
  hasRelevantAuditions: boolean;
}

/**
 * The full persisted state written to audition-state.json after each run.
 * The Playbill fields come from PlaybillState and are additive — `loadState()`
 * populates them with safe defaults so existing state files without these keys
 * continue to work without a migration step.
 */
interface StateFile extends PlaybillState {
  lastRun: string;
  pages: Record<string, PageState>;
}

interface AuditionAnalysis {
  hasRelevantAuditions: boolean;
  summary: string | null;
  futureDates: string[];
  relevantItems: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STATE_FILE = path.join(process.cwd(), "audition-state.json");
const URLS_FILE = path.join(process.cwd(), "urls.json");

// ─── Claude Analysis ──────────────────────────────────────────────────────────

/**
 * LLM-as-classifier for standard single-page sources. Claude is given the full
 * relevance criteria inline so the classification logic lives in the prompt, not
 * in fragile HTML parsing or keyword matching. The structured JSON contract in the
 * prompt ensures the output is machine-readable without a schema validation library.
 * Regex extraction (`/\{[\s\S]*\}/`) is the fallback in case Claude wraps the JSON
 * in prose despite instructions — a known LLM output reliability issue.
 */
async function analyzeWithClaude(
  client: Anthropic,
  pageText: string,
  pageUrl: string,
  pageName: string
): Promise<AuditionAnalysis> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are helping a professional trumpet player monitor symphony orchestra audition pages.

Today's date: ${today}
Page: ${pageName} (${pageUrl})

Analyze the following page content and determine if there are any RELEVANT audition opportunities.

RELEVANT means ALL of the following must be true:
1. The audition/position has a future date (after ${today}) or is currently open with no closing date yet
2. AND at least one of:
   a. It specifically mentions trumpet (any part: principal, associate, section, extra, sub)
   b. It is for a sub list open to any instrument (and trumpet would reasonably qualify)
   c. It is a general orchestral audition where brass/trumpet players would audition

NOT relevant: past auditions, non-orchestral positions (admin, education-only), auditions for instruments that exclude brass.

Return a JSON object with this exact shape:
{
  "hasRelevantAuditions": boolean,
  "summary": string | null,
  "futureDates": string[],
  "relevantItems": string[]
}

- summary: 2-3 sentence plain-English summary of what was found (null if nothing relevant)
- futureDates: list of relevant future date strings found on the page
- relevantItems: list of specific audition/position titles that are relevant

Page content (truncated to first 8000 chars):
${pageText.slice(0, 8000)}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found");
    return JSON.parse(match[0]) as AuditionAnalysis;
  } catch {
    console.warn("  Could not parse Claude response as JSON:", raw.slice(0, 200));
    return {
      hasRelevantAuditions: false,
      summary: null,
      futureDates: [],
      relevantItems: [],
    };
  }
}

// ─── State helpers ────────────────────────────────────────────────────────────

/**
 * Defensive defaults on load enable backwards-compatible schema evolution:
 * new fields can be added to StateFile without requiring a migration script —
 * old state files simply omit the keys and get initialized to empty on first read.
 */
function loadState(): StateFile {
  if (fs.existsSync(STATE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Partial<StateFile>;
    return {
      lastRun: raw.lastRun ?? "",
      pages: raw.pages ?? {},
      playbillIndexHash: raw.playbillIndexHash ?? null,
      playbillListings: raw.playbillListings ?? {},
    };
  }
  return { lastRun: "", pages: {}, playbillIndexHash: null, playbillListings: {} };
}

function saveState(state: StateFile): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ─── Email (Gmail API + OAuth2) ───────────────────────────────────────────────

/**
 * Gmail API requires raw MIME messages encoded as base64url. `buildEmailRaw` constructs
 * the MIME envelope so `sendEmail` stays focused on content assembly. The two functions
 * together form a simple Template Method: structure is fixed, content is variable.
 */
function buildEmailRaw(params: {
  from: string;
  to: string;
  subject: string;
  html: string;
}): string {
  const message = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
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
 * Digest email that aggregates all finding types into a single send.
 * Sending one email per run (rather than one per finding) is intentional:
 * it avoids inbox flooding when multiple sources become relevant simultaneously.
 *
 * The two finding types (`findings` for standard sources, `playbillFindings` for
 * the Playbill board) render as distinct sections with different visual treatments,
 * reflecting their different data shapes — standard findings link to an orchestra's
 * audition page while Playbill findings link to specific job listing URLs.
 */
async function sendEmail(
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

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  console.log(`✉️  Email sent to ${notifyEmail}`);
}

// ─── Preflight: secrets ───────────────────────────────────────────────────────

/**
 * Validates not just presence but actual usability of credentials by performing a
 * live OAuth2 token exchange. This catches expired refresh tokens before any page
 * fetching or state mutation occurs, so a credential failure produces a clean error
 * rather than a partially-completed run with no email sent.
 */
async function preflightSecrets(): Promise<void> {
  console.log("🔐 Preflight: checking secrets...");

  const required: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN,
    GMAIL_USER: process.env.GMAIL_USER,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  console.log("  ✓ All required env vars present");

  // Verify OAuth2 token exchange actually works
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

  try {
    const { token } = await oauth2Client.getAccessToken();
    if (!token) throw new Error("Empty access token returned");
    console.log("  ✓ Gmail OAuth2 token exchange successful");
  } catch (err) {
    throw new Error(`Gmail OAuth2 token exchange failed: ${err}`);
  }
}

// ─── Preflight: URL probing ───────────────────────────────────────────────────

interface ProbeResult {
  name: string;
  url: string;
  ok: boolean;
  method: "fetch" | "puppeteer";
  charCount: number;
  isAuditionPage: boolean;
  claudeReason: string;
  text?: string; // retained for reuse in main run
  error?: string;
}

interface ProbeFailure {
  name: string;
  url: string;
  reason: "fetch-failed" | "not-audition-page";
  detail: string;
}

interface PreflightUrlsResult {
  contentCache: Map<string, string>; // url → text for passing URLs
  failures: ProbeFailure[];
}

async function probeIsAuditionPage(
  client: Anthropic,
  pageText: string,
  url: string,
  name: string
): Promise<{ isAuditionPage: boolean; reason: string }> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `Does this page appear to be an orchestra/symphony audition or employment/careers page?
Answer with JSON only: { "isAuditionPage": boolean, "reason": string }
Reason should be one sentence.

URL: ${url}
Page name: ${name}
Content sample (first 2000 chars):
${pageText.slice(0, 2000)}`,
      },
    ],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found");
    return JSON.parse(match[0]);
  } catch {
    return { isAuditionPage: false, reason: "Could not parse Claude response" };
  }
}

/**
 * Dual-purpose preflight: validates URL reachability AND warms a content cache that
 * the main loop consumes, eliminating the need to re-fetch pages. Only URLs that pass
 * both checks (fetchable + confirmed audition page) are included in `contentCache`,
 * meaning the main loop implicitly skips failing URLs without additional branching.
 *
 * Playbill URLs bypass the `probeIsAuditionPage` Claude check because that check is
 * calibrated for single orchestra pages — a general job board would likely fail it
 * as a false negative. The `crawlMode` discriminator makes this exception explicit.
 *
 * Failures are collected and returned rather than thrown, so the run continues for
 * all healthy URLs and produces a single aggregated failure report.
 */
async function preflightUrls(
  urls: UrlConfig[],
  claude: Anthropic
): Promise<PreflightUrlsResult> {
  console.log(`\n🔍 Preflight: probing ${urls.length} URL(s)...\n`);

  const results: ProbeResult[] = [];

  for (const urlConfig of urls) {
    console.log(`  Probing: ${urlConfig.name}`);
    const result: ProbeResult = {
      name: urlConfig.name,
      url: urlConfig.url,
      ok: false,
      method: "fetch",
      charCount: 0,
      isAuditionPage: false,
      claudeReason: "",
    };

    try {
      let text: string;
      let usedPuppeteer = false;

      try {
        const html = await fetchPage(urlConfig.url);
        text = stripHtml(html);
        if (text.length < MIN_CONTENT_LENGTH) {
          throw new Error(`Content too short (${text.length} chars)`);
        }
      } catch (fetchErr) {
        console.log(`    ↳ Fetch insufficient, trying Puppeteer...`);
        const html = await fetchWithPuppeteer(urlConfig.url);
        text = stripHtml(html);
        usedPuppeteer = true;
      }

      result.method = usedPuppeteer ? "puppeteer" : "fetch";
      result.charCount = text.length;
      result.text = text; // retain for main run
      result.ok = true;

      if (urlConfig.crawlMode === "playbill") {
        // Playbill is a job board, not a single audition page — skip the Claude check
        result.isAuditionPage = true;
        result.claudeReason = "Playbill job board — audition page check skipped";
        console.log(`    ✅ ${result.charCount.toLocaleString()} chars via ${result.method} — Playbill job board (check skipped)`);
      } else {
        const { isAuditionPage, reason } = await probeIsAuditionPage(
          claude,
          text,
          urlConfig.url,
          urlConfig.name
        );
        result.isAuditionPage = isAuditionPage;
        result.claudeReason = reason;

        const icon = isAuditionPage ? "✅" : "⚠️ ";
        console.log(
          `    ${icon} ${result.charCount.toLocaleString()} chars via ${result.method} — ${reason}`
        );
      }
    } catch (err) {
      result.error = String(err);
      console.log(`    ❌ Failed: ${result.error}`);
    }

    results.push(result);
  }

  // Build failures list — do NOT throw; let main run continue with passing URLs
  const failures: ProbeFailure[] = [
    ...results
      .filter((r) => !r.ok)
      .map((r) => ({
        name: r.name,
        url: r.url,
        reason: "fetch-failed" as const,
        detail: r.error ?? "Unknown fetch error",
      })),
    ...results
      .filter((r) => r.ok && !r.isAuditionPage)
      .map((r) => ({
        name: r.name,
        url: r.url,
        reason: "not-audition-page" as const,
        detail: r.claudeReason,
      })),
  ];

  console.log("\n  ─── Preflight URL Summary ───────────────────────");
  for (const r of results) {
    if (!r.ok) {
      console.log(`  ❌ FETCH FAILED   ${r.name}`);
      console.log(`                    ${r.error}`);
    } else if (!r.isAuditionPage) {
      console.log(`  ⚠️  NOT AUDITION   ${r.name}`);
      console.log(`                    ${r.claudeReason}`);
    } else {
      console.log(`  ✅ OK              ${r.name}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n  ⚠️  ${failures.length} URL(s) had issues — will report via email + GitHub issue`);
  }
  console.log(`  ✓ ${results.filter((r) => r.ok && r.isAuditionPage).length}/${results.length} URLs passed preflight\n`);

  return {
    contentCache: new Map(
      results.filter((r) => r.ok && r.isAuditionPage).map((r) => [r.url, r.text!])
    ),
    failures,
  };
}

// ─── GitHub Issue ─────────────────────────────────────────────────────────────

async function createGitHubIssue(failures: ProbeFailure[]): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // set automatically by Actions: "owner/repo"

  if (!token || !repo) {
    console.warn("  ⚠️  GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping issue creation");
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const title = `[Audition Checker] URL issue(s) detected on ${today}`;

  const rows = failures
    .map((f) => {
      const label = f.reason === "fetch-failed" ? "❌ Could not fetch" : "⚠️ Not an audition page";
      return `| ${f.name} | ${f.url} | ${label} | ${f.detail} |`;
    })
    .join("\n");

  const body = `## Audition Checker — Preflight URL Failures

The weekly audition checker ran on **${today}** and encountered issues with the following URL(s):

| Name | URL | Issue | Detail |
|------|-----|-------|--------|
${rows}

### What to do
- **Could not fetch**: The page may be down, moved, or blocking automated requests. Verify the URL is correct and accessible.
- **Not an audition page**: The URL may have changed to a different section of the site. Update \`urls.json\` with the correct audition/careers page URL.

_This issue was created automatically by the [audition-checker workflow](../../actions)._`;

  const payload = JSON.stringify({ title, body, labels: ["audition-checker", "bug"] });

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${repo}/issues`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "audition-checker",
          "Accept": "application/vnd.github+json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 201) {
            const issue = JSON.parse(data);
            console.log(`  ✓ GitHub issue created: ${issue.html_url}`);
            resolve();
          } else {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Orchestrates the two-phase run:
 *
 *   Phase 1 — PREFLIGHT: validate credentials and probe all URLs before touching state.
 *   Any infrastructure issue surfaces here as a hard failure or a collected warning,
 *   never as silent data corruption.
 *
 *   Phase 2 — MAIN RUN: dispatch each URL by `crawlMode`, accumulate findings, persist
 *   state, and send a single digest email. The `crawlMode` branch is the seam where new
 *   source types plug in without touching the standard-page code path.
 *
 * Notification idempotency for Playbill: `notified` flags are written to state only
 * after `sendEmail` resolves successfully. A crash between email send and flag write
 * causes a duplicate email on the next run — an acceptable tradeoff vs. the alternative
 * of silently dropping a confirmed finding.
 */
async function main(): Promise<void> {
  console.log("🎺 Audition checker starting...\n");

  // Load URL list
  if (!fs.existsSync(URLS_FILE)) {
    throw new Error(`urls.json not found at ${URLS_FILE}`);
  }
  const urls: UrlConfig[] = JSON.parse(fs.readFileSync(URLS_FILE, "utf-8"));
  console.log(`Checking ${urls.length} URL(s)\n`);

  // Init clients
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY env var required");
  const claude = new Anthropic({ apiKey: anthropicKey });

  // ── Preflight (runs before any state mutation or email) ──────────────────
  await preflightSecrets();
  const { contentCache: pageContentCache, failures: probeFailures } = await preflightUrls(urls, claude);

  if (probeFailures.length > 0) {
    console.log(`\n⚠️  ${probeFailures.length} URL(s) had preflight issues — creating GitHub issue...`);
    await createGitHubIssue(probeFailures).catch((err) =>
      console.warn("  Could not create GitHub issue:", err.message)
    );
  }

  console.log("\n▶️  Starting main run\n");

  // Load previous state
  const state = loadState();
  const newFindings: Array<{ config: UrlConfig; analysis: AuditionAnalysis }> = [];
  const newPlaybillFindings: PlaybillFinding[] = [];

  for (const urlConfig of urls) {
    console.log(`\n📄 ${urlConfig.name}`);
    try {
      if (urlConfig.crawlMode === "playbill") {
        // Multi-level Playbill crawl — handled separately
        const playbillResults = await processPlaybillUrl(claude, urlConfig, state);
        newPlaybillFindings.push(...playbillResults);
        continue;
      }

      // Standard single-page flow
      // Reuse content fetched during preflight — no second HTTP request
      const text = pageContentCache.get(urlConfig.url);
      if (!text) {
        console.log(`  ⏭️  Skipping (failed preflight)`);
        continue;
      }
      const hash = contentHash(text);
      const previousState = state.pages[urlConfig.url];

      // Skip if content unchanged and we already checked it recently
      if (previousState && previousState.contentHash === hash) {
        console.log(`  ✓ No content change since last check`);
        continue;
      }

      console.log(`  🔍 Content changed — analyzing with Claude...`);
      const analysis = await analyzeWithClaude(
        claude,
        text,
        urlConfig.url,
        urlConfig.name
      );

      console.log(
        `  → Relevant: ${analysis.hasRelevantAuditions} | Items: ${analysis.relevantItems.length}`
      );

      // Update state
      state.pages[urlConfig.url] = {
        url: urlConfig.url,
        name: urlConfig.name,
        lastChecked: new Date().toISOString(),
        contentHash: hash,
        extractedSummary: analysis.summary,
        hasRelevantAuditions: analysis.hasRelevantAuditions,
      };

      // Rising-edge notification: only alert on the transition from not-relevant → relevant.
      // This prevents re-alerting on every subsequent run while a listing remains posted.
      const wasRelevant = previousState?.hasRelevantAuditions ?? false;
      if (analysis.hasRelevantAuditions && !wasRelevant) {
        console.log(`  🎺 NEW relevant audition found!`);
        newFindings.push({ config: urlConfig, analysis });
      } else if (analysis.hasRelevantAuditions && wasRelevant) {
        console.log(`  ℹ️  Still relevant (already notified previously)`);
      }
    } catch (err) {
      console.error(`  ❌ Error processing ${urlConfig.url}:`, err);
    }
  }

  // Persist updated state (including Playbill listing state)
  state.lastRun = new Date().toISOString();
  saveState(state);
  console.log(`\n💾 State saved to ${STATE_FILE}`);

  // Send email if there are new findings OR probe failures to report
  if (newFindings.length > 0 || newPlaybillFindings.length > 0 || probeFailures.length > 0) {
    const reason = [
      newFindings.length > 0 ? `${newFindings.length} orchestra finding(s)` : "",
      newPlaybillFindings.length > 0 ? `${newPlaybillFindings.length} Playbill finding(s)` : "",
      probeFailures.length > 0 ? `${probeFailures.length} URL issue(s)` : "",
    ].filter(Boolean).join(" + ");
    console.log(`\n📬 Sending email (${reason})...`);
    await sendEmail(newFindings, probeFailures, newPlaybillFindings);

    // Mark Playbill findings as notified only after successful email send
    for (const finding of newPlaybillFindings) {
      if (state.playbillListings[finding.listingUrl]) {
        state.playbillListings[finding.listingUrl].notified = true;
      }
    }
    // Save state again with updated notified flags
    saveState(state);
  } else {
    console.log("\n✅ No new relevant auditions found. No email sent.");
  }

  console.log("\n🏁 Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
