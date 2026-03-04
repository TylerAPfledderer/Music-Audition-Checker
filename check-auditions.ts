import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UrlConfig {
  name: string;
  url: string;
}

interface PageState {
  url: string;
  name: string;
  lastChecked: string;
  contentHash: string;
  extractedSummary: string | null;
  hasRelevantAuditions: boolean;
}

interface StateFile {
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
const MIN_CONTENT_LENGTH = 500; // chars threshold to consider fetch "empty"

// ─── HTTP Fetch (no deps) ─────────────────────────────────────────────────────

function fetchPage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; AuditionChecker/1.0; +https://github.com)",
          Accept: "text/html,application/xhtml+xml",
        },
      },
      (res) => {
        // Handle redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          fetchPage(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

// ─── Puppeteer fallback ───────────────────────────────────────────────────────

async function fetchWithPuppeteer(url: string): Promise<string> {
  // Dynamically import so the script still runs if puppeteer isn't installed
  let puppeteer: typeof import("puppeteer");
  try {
    puppeteer = await import("puppeteer");
  } catch {
    throw new Error(
      "Puppeteer not installed. Run: npm install puppeteer  (or add to package.json)"
    );
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (compatible; AuditionChecker/1.0; +https://github.com)"
    );
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // Wait a bit more for lazy-loaded content
    await new Promise((r) => setTimeout(r, 2000));
    return await page.content();
  } finally {
    await browser.close();
  }
}

// ─── HTML stripper ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Scrape with fallback ─────────────────────────────────────────────────────

async function scrapeUrl(url: string): Promise<string> {
  console.log(`  Fetching: ${url}`);
  let html: string;
  try {
    html = await fetchPage(url);
  } catch (err) {
    console.log(`  Fetch failed (${err}), trying Puppeteer...`);
    html = await fetchWithPuppeteer(url);
  }

  if (html.length < MIN_CONTENT_LENGTH) {
    console.log(
      `  Content too short (${html.length} chars), falling back to Puppeteer...`
    );
    html = await fetchWithPuppeteer(url);
  }

  return stripHtml(html);
}

// ─── Claude Analysis ──────────────────────────────────────────────────────────

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
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned) as AuditionAnalysis;
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

function loadState(): StateFile {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as StateFile;
  }
  return { lastRun: "", pages: {} };
}

function saveState(state: StateFile): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ─── Email (Gmail API + OAuth2) ───────────────────────────────────────────────

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

async function sendEmail(
  findings: Array<{ config: UrlConfig; analysis: AuditionAnalysis }>,
  probeFailures: ProbeFailure[] = []
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

  if (probeFailures.length > 0) {
    html += `<hr/><h3 style="color:#c0392b;">⚠️ URL Issues Detected</h3>
<p>The following URLs had problems during this run and were skipped. A GitHub issue has been created.</p><ul>`;
    for (const f of probeFailures) {
      const label = f.reason === "fetch-failed" ? "Could not fetch" : "Not an audition page";
      html += `<li><strong>${f.name}</strong> — ${label}<br/><code>${f.url}</code><br/><em>${f.detail}</em></li>`;
    }
    html += `</ul>`;
  }

  html += `<p style="color:#888;font-size:12px;">Sent by audition-checker</p>`;

  const warningTag = probeFailures.length > 0 ? " ⚠️" : "";
  const subject = `🎺 ${findings.length} new trumpet audition${findings.length > 1 ? "s" : ""} found — ${today}${warningTag}`;

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
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { isAuditionPage: false, reason: "Could not parse Claude response" };
  }
}

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
    await createGitHubIssue(probeFailures);
  }

  console.log("\n▶️  Starting main run\n");

  // Load previous state
  const state = loadState();
  const newFindings: Array<{ config: UrlConfig; analysis: AuditionAnalysis }> =
    [];

  for (const urlConfig of urls) {
    console.log(`\n📄 ${urlConfig.name}`);
    try {
      // Reuse content fetched during preflight — no second HTTP request
      const text = pageContentCache.get(urlConfig.url)!;
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

      // Only notify if newly relevant (wasn't relevant before, or no prior state)
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

  // Persist updated state
  state.lastRun = new Date().toISOString();
  saveState(state);
  console.log(`\n💾 State saved to ${STATE_FILE}`);

  // Send email if there are new findings OR probe failures to report
  if (newFindings.length > 0 || probeFailures.length > 0) {
    const reason = [
      newFindings.length > 0 ? `${newFindings.length} new finding(s)` : "",
      probeFailures.length > 0 ? `${probeFailures.length} URL issue(s)` : "",
    ].filter(Boolean).join(" + ");
    console.log(`\n📬 Sending email (${reason})...`);
    await sendEmail(newFindings, probeFailures);
  } else {
    console.log("\n✅ No new relevant auditions found. No email sent.");
  }

  console.log("\n🏁 Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
