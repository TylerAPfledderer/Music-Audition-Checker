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
 *   - Standard (default): single-page fetch → LLM relevance check → notify on change
 *   - Playbill ("playbill"): index fetch → LLM listing extraction →
 *     per-listing detail fetch → LLM trumpet check → notify per matching listing
 *
 * State is persisted to audition-state.json and committed back to the repo by
 * the Actions workflow, making it the source of truth for "what has been seen
 * and notified." This avoids any external database dependency.
 */

import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createGeminiClient } from "./llm";

import { computePageHash, normalizeForHash, extractAuditionSignals, extractAuditionLinks, scrapeUrl, passesBrassKeywordGate } from "./scraper";
import { PlaybillState, processPlaybillUrl } from "./playbill-crawler";
import { UrlConfig, CrawlResult, sendEmail } from "./email";
import { analyzeWithLlm } from "./llm-classifiers";
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
 * `notifiedRelevantItems` records the specific audition items present when the
 * user was last notified, enabling re-notification when a new item appears while
 * the page remains relevant (e.g. a second trumpet audition is added later).
 */
interface PageState {
  url: string;
  name: string;
  lastChecked: string;
  contentHash: string;
  extractedSummary: string | null;
  hasRelevantAuditions: boolean;
  notifiedRelevantItems: string[];
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
const DEBUG_LOG_FILE = path.join(process.cwd(), "debug.log");

// ─── Debug logger ─────────────────────────────────────────────────────────────

function debugLog(line: string): void {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFileSync(DEBUG_LOG_FILE, entry, "utf-8");
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

// ─── Notification predicate ───────────────────────────────────────────────────

/**
 * Maps a Claude-generated item label to a stable canonical form.
 *
 * LLM output is non-deterministic — "Sub list for all instruments",
 * "Substitute musician positions", and "Section and sub positions for all
 * instruments" are all the same underlying opportunity. This funnel maps
 * semantically equivalent labels to a single canonical string so that
 * wording variation across runs never triggers a spurious re-notification.
 *
 * Rules are ordered most-specific first (trumpet qualifiers before generic
 * "trumpet", so "Principal Trumpet" hits the right bucket). The fallback
 * lowercases and strips parentheticals/dash-suffixes so punctuation noise
 * is eliminated for any label that doesn't match a known category.
 */
export function canonicalizeLabel(label: string): string {
  const l = label
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "") // strip "(contact operations manager)" etc.
    .replace(/\s*-\s+\S.*$/, "") // strip " - general orchestral" etc.
    .trim();

  if (/\b(principal|associate|1st|first)\s+trumpet\b/.test(l)) return "principal trumpet";
  if (/\b(second|2nd|co.?principal)\s+trumpet\b/.test(l)) return "second trumpet";
  if (/\bsection\s+trumpet\b/.test(l)) return "section trumpet";
  if (/\btrumpet\b/.test(l)) return "trumpet";
  if (/\bsub(stitute)?\b/.test(l)) return "substitute list";
  if (/\b(open|annual|general)\s+(position|audition|orch)/.test(l)) return "open positions";

  return l; // fallback: lowercase + stripped
}

/**
 * Determines whether a standard page should trigger a new user notification.
 *
 * Fires on two conditions:
 *   1. Rising edge — page was not relevant before, is now.
 *   2. New relevant item — page was already relevant, but Claude returned at least
 *      one item not present when the user was last notified (e.g. a second trumpet
 *      audition was added). Non-trumpet content changes won't fire because Claude's
 *      `relevantItems` list will be unchanged.
 *
 * `notifiedItems` being empty means no notification was ever sent, which always
 * counts as "new" when the page is relevant.
 *
 * `notifiedItems` are stored in canonical form (via `canonicalizeLabel`). Incoming
 * `currentItems` are canonicalized before comparison so wording variants of the
 * same opportunity are treated as already-seen.
 */
export function shouldNotify(
  isNowRelevant: boolean,
  wasRelevant: boolean,
  currentItems: string[],
  notifiedItems: string[]
): boolean {
  if (!isNowRelevant) return false;
  if (!wasRelevant) return true; // rising edge
  return currentItems.some((item) => !notifiedItems.includes(canonicalizeLabel(item)));
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
  const isDryRun = process.env.DRY_RUN === "true";
  const isDebug = process.env.CHECKER_DEBUG === "true";
  if (isDebug) fs.writeFileSync(DEBUG_LOG_FILE, "", "utf-8"); // clear on each run
  console.log(`🎺 Audition checker starting...${isDryRun ? " (DRY RUN)" : ""}\n`);

  // Load URL list
  if (!fs.existsSync(URLS_FILE)) {
    throw new Error(`urls.json not found at ${URLS_FILE}`);
  }
  const urls: UrlConfig[] = JSON.parse(fs.readFileSync(URLS_FILE, "utf-8"));
  console.log(`Checking ${urls.length} URL(s)\n`);

  // Init clients
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error("GEMINI_API_KEY env var required");
  const llm = createGeminiClient(geminiKey, process.env.GEMINI_MODEL);

  // ── Preflight (runs before any state mutation or email) ──────────────────
  await preflightSecrets();
  const { contentCache: pageContentCache, failures: probeFailures } = await preflightUrls(urls, llm);

  if (probeFailures.length > 0) {
    console.log(`\n⚠️  ${probeFailures.length} URL(s) had preflight issues — creating GitHub issue...`);
    await createGitHubIssue(probeFailures).catch((err) =>
      console.warn("  Could not create GitHub issue:", err.message)
    );
  }

  console.log("\n▶️  Starting main run\n");

  // Load previous state
  const state = loadState();
  const allFindings: CrawlResult[] = [];

  let stateValid = false;
  try {
    for (const urlConfig of urls) {
      console.log(`\n📄 ${urlConfig.name}`);
      try {
        if (urlConfig.crawlMode === "playbill") {
          // Multi-level Playbill crawl — handled separately
          const playbillResults = await processPlaybillUrl(llm, urlConfig, state);
          allFindings.push(...playbillResults);
          continue;
        }

        // Standard single-page flow
        // Reuse content fetched during preflight — no second HTTP request
        const cached = pageContentCache.get(urlConfig.url);
        if (!cached) {
          console.log(`[SKIP][PREFLIGHT] ${urlConfig.name} — Failed Preflight`);
          continue;
        }
        const { text, html: cachedHtml, links: cachedFirecrawlLinks } = cached;
        const hash = computePageHash(text);
        const previousState = state.pages[urlConfig.url];

        // Capture whether the notifiedRelevantItems field existed BEFORE state is
        // overwritten below. undefined means the field was never written (old schema);
        // [] means it was written but empty. We use this to suppress a spurious
        // notification when a page was already known-relevant before item tracking
        // was introduced (schema evolution guard).
        const hadNotifiedItemsField = previousState?.notifiedRelevantItems !== undefined;

        // Skip if content unchanged and we already checked it recently
        if (previousState && previousState.contentHash === hash) {
          console.log(`[SKIP][STATE] ${urlConfig.name} — No Change`);
          continue;
        }

        // Deterministic pre-filter: skip Claude entirely if no brass-relevant keywords
        if (!passesBrassKeywordGate(text)) {
          console.log(`[SKIP][DETERMINISTIC] ${urlConfig.name} — No Brass`);
          state.pages[urlConfig.url] = {
            ...(previousState ?? {}),
            url: urlConfig.url,
            name: urlConfig.name,
            lastChecked: new Date().toISOString(),
            contentHash: hash,
            extractedSummary: null,
            hasRelevantAuditions: false,
            notifiedRelevantItems: previousState?.notifiedRelevantItems ?? [],
          };
          continue;
        }

        if (isDebug && previousState) {
          const signals = extractAuditionSignals(normalizeForHash(text));
          debugLog(`[${urlConfig.name}] hash: ${previousState.contentHash} → ${hash}`);
          debugLog(`[${urlConfig.name}] hash input (${signals.length} chars):\n${signals}`);
        }
        console.log(`  🔍 Content changed — analyzing with LLM...`);

        // Drill into internal audition-detail links to avoid false positives from
        // pages that list auditions as navigable link labels (e.g. "Winds Auditions"
        // → sub-page). Without this, Claude must infer from the label alone, which
        // causes over-notification when the actual instrument list excludes trumpet.
        let analysisText = text;
        const subLinks = extractAuditionLinks(cachedHtml, urlConfig.url, cachedFirecrawlLinks);
        if (subLinks.length > 0) {
          console.log(`  ↳ Found ${subLinks.length} audition sub-page(s) — fetching for context...`);
          const subTexts: string[] = [];
          for (const subUrl of subLinks) {
            try {
              const subText = await scrapeUrl(subUrl);
              subTexts.push(`--- Sub-page: ${subUrl} ---\n${subText.slice(0, 2000)}`);
              console.log(`    ✓ Fetched: ${subUrl}`);
            } catch (err) {
              console.warn(`    ⚠️  Could not fetch sub-page ${subUrl}: ${err}`);
            }
          }
          if (subTexts.length > 0) {
            analysisText = `${text}\n\n${subTexts.join("\n\n")}`;
          }
        }

        const analysis = await analyzeWithLlm(llm, analysisText, urlConfig.url, urlConfig.name);

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
          notifiedRelevantItems: previousState?.notifiedRelevantItems ?? [],
        };

        const wasRelevant = previousState?.hasRelevantAuditions ?? false;
        const notifiedItems = previousState?.notifiedRelevantItems ?? [];

        if (wasRelevant && !hadNotifiedItemsField && analysis.hasRelevantAuditions) {
          // Schema evolution: this page was known-relevant before notifiedRelevantItems
          // was introduced. Silently initialize the field from the current Claude output
          // so the next run has a populated baseline to compare against.
          console.log(`  ℹ️  Initializing item tracking for already-relevant page (no email sent)`);
          state.pages[urlConfig.url].notifiedRelevantItems = [
            ...new Set(analysis.relevantItems.map(canonicalizeLabel)),
          ];
        } else if (shouldNotify(analysis.hasRelevantAuditions, wasRelevant, analysis.relevantItems, notifiedItems)) {
          const instrumentLabel = analysis.instrument.join(", ") || "Relevant";
          console.log(`[NEW][AI-MATCH] ${urlConfig.name} — ${instrumentLabel}`);
          allFindings.push({
            source: "standard",
            name: urlConfig.name,
            url: urlConfig.url,
            summary: analysis.summary,
            relevantItems: analysis.relevantItems,
            futureDates: analysis.futureDates,
          });
          // Canonicalize and merge: store the union of previously-notified canonical
          // labels and the current run's canonical labels. This prevents any future
          // wording variant from being treated as a new item.
          state.pages[urlConfig.url].notifiedRelevantItems = [
            ...new Set([...notifiedItems, ...analysis.relevantItems.map(canonicalizeLabel)]),
          ];
        } else if (analysis.hasRelevantAuditions) {
          // Still relevant, no new items. Absorb canonical labels from this run
          // so the state stays current without triggering a notification.
          state.pages[urlConfig.url].notifiedRelevantItems = [
            ...new Set([...notifiedItems, ...analysis.relevantItems.map(canonicalizeLabel)]),
          ];
          console.log(`[SKIP][STATE] ${urlConfig.name} — No New Items`);
        }
      } catch (err) {
        console.error(`  ❌ Error processing ${urlConfig.url}:`, err);
      }
    }
    stateValid = true;
  } catch (err) {
    console.error("Fatal error in main run loop:", err);
  } finally {
    if (!isDryRun && stateValid) {
      state.lastRun = new Date().toISOString();
      saveState(state);
      console.log(`\n💾 State saved to ${STATE_FILE}`);
    }
  }

  const hasFindings = allFindings.length > 0 || probeFailures.length > 0;

  if (isDryRun) {
    console.log("\n🧪 DRY RUN — state not saved, email not sent.\n");
    if (hasFindings) {
      const standardFindings = allFindings.filter((f) => f.source === "standard");
      const playbillFindings = allFindings.filter((f) => f.source === "playbill");
      if (standardFindings.length > 0) {
        console.log("── Orchestra findings ──");
        for (const f of standardFindings) {
          console.log(`  ${f.name}: ${f.summary ?? "(no summary)"}`);
          if (f.relevantItems.length > 0) console.log(`    Items: ${f.relevantItems.join(", ")}`);
        }
      }
      if (playbillFindings.length > 0) {
        console.log("── Playbill findings ──");
        for (const f of playbillFindings) console.log(`  ${f.name} — ${f.url}`);
      }
      if (probeFailures.length > 0) {
        console.log("── Probe failures ──");
        for (const f of probeFailures) console.log(`  ${f.name}: ${f.detail}`);
      }
    } else {
      console.log("✅ No new relevant auditions found.");
    }
  } else if (hasFindings) {
    const reason = [
      allFindings.filter((f) => f.source === "standard").length > 0
        ? `${allFindings.filter((f) => f.source === "standard").length} orchestra finding(s)`
        : "",
      allFindings.filter((f) => f.source === "playbill").length > 0
        ? `${allFindings.filter((f) => f.source === "playbill").length} Playbill finding(s)`
        : "",
      probeFailures.length > 0 ? `${probeFailures.length} URL issue(s)` : "",
    ].filter(Boolean).join(" + ");
    console.log(`\n📬 Sending email (${reason})...`);
    try {
      await sendEmail(allFindings, probeFailures);
      // Mark Playbill findings as notified only after successful email send
      for (const finding of allFindings.filter((f) => f.source === "playbill")) {
        if (state.playbillListings[finding.url]) {
          state.playbillListings[finding.url].notified = true;
        }
      }
      // Save state again with updated notified flags
      saveState(state);
    } catch (emailErr) {
      console.error("Notification Failure:", emailErr);
      // State is already saved — do not re-throw so the Action build succeeds
    }
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
