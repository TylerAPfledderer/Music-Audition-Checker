import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";

import { MIN_CONTENT_LENGTH, fetchPage, fetchWithFirecrawl, stripHtml, extractMainContent } from "./scraper";
import { UrlConfig, ProbeFailure } from "./email";
import { probeIsAuditionPage } from "./claude";

// ─── Preflight: secrets ───────────────────────────────────────────────────────

/**
 * Validates not just presence but actual usability of credentials by performing a
 * live OAuth2 token exchange. This catches expired refresh tokens before any page
 * fetching or state mutation occurs, so a credential failure produces a clean error
 * rather than a partially-completed run with no email sent.
 */
export async function preflightSecrets(): Promise<void> {
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
  method: "fetch" | "firecrawl";
  charCount: number;
  isAuditionPage: boolean;
  claudeReason: string;
  text?: string;   // retained for reuse in main run
  html?: string;   // main-content-scoped HTML for sub-link extraction
  links?: string[]; // Firecrawl links array when Firecrawl was used
  error?: string;
}

export interface PreflightUrlsResult {
  contentCache: Map<string, { text: string; html: string; links?: string[] }>;
  failures: ProbeFailure[];
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
export async function preflightUrls(
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
      let usedFirecrawl = false;
      let rawHtml = "";
      let firecrawlLinks: string[] | undefined;

      try {
        rawHtml = await fetchPage(urlConfig.url);
        text = stripHtml(extractMainContent(rawHtml));
        if (text.length < MIN_CONTENT_LENGTH) {
          throw new Error(`Content too short (${text.length} chars)`);
        }
      } catch (fetchErr) {
        console.log(`    ↳ Fetch insufficient, trying Firecrawl...`);
        const fc = await fetchWithFirecrawl(urlConfig.url);
        text = fc.text; // already clean markdown
        rawHtml = fc.html;
        firecrawlLinks = fc.links;
        usedFirecrawl = true;
      }

      result.method = usedFirecrawl ? "firecrawl" : "fetch";
      result.charCount = text.length;
      result.text = text;
      result.html = extractMainContent(rawHtml); // scope to main content for link extraction
      result.links = firecrawlLinks;
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
      results
        .filter((r) => r.ok && r.isAuditionPage)
        .map((r) => [r.url, { text: r.text!, html: r.html!, links: r.links }])
    ),
    failures,
  };
}
