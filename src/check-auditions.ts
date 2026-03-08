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
import Anthropic from "@anthropic-ai/sdk";

import { contentHash } from "./scraper";
import { PlaybillFinding, PlaybillState, processPlaybillUrl } from "./playbill-crawler";
import { UrlConfig, AuditionAnalysis, sendEmail } from "./email";
import { analyzeWithClaude } from "./claude";
import { preflightSecrets, preflightUrls } from "./preflight";
import { createGitHubIssue } from "./github";

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Config ───────────────────────────────────────────────────────────────────

const STATE_FILE = path.join(process.cwd(), "audition-state.json");
const URLS_FILE = path.join(process.cwd(), "urls.json");

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
      const analysis = await analyzeWithClaude(claude, text, urlConfig.url, urlConfig.name);

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

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
