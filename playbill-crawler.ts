import Anthropic from "@anthropic-ai/sdk";
import { scrapeUrl, scrapeUrlRaw, contentHash } from "./scraper";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Persistent record for a single Playbill job listing.
 * Because Playbill is a rolling job board, listings are tracked individually by URL
 * rather than by page hash. `notified` is the canonical "done" flag — it is set only
 * after a successful email send, providing at-least-once delivery semantics if the
 * process crashes between trumpet confirmation and email dispatch.
 * Non-trumpet listings are also marked `notified=true` to prevent rechecking them on
 * every subsequent run once we know they aren't relevant.
 */
export interface PlaybillListing {
  url: string;
  title: string;
  organization: string;
  firstSeen: string;
  lastChecked: string;
  hasTrumpet: boolean;
  notified: boolean;
  summary: string | null;
}

/** Carries confirmed trumpet hits into the email layer, decoupled from the full PlaybillListing state. */
export interface PlaybillFinding {
  listingUrl: string;
  title: string;
  organization: string;
  summary: string | null;
}

/**
 * The Playbill-specific slice of the persisted state. Defined here so `processPlaybillUrl`
 * can accept and mutate it without depending on the full StateFile shape.
 */
export interface PlaybillState {
  playbillIndexHash: string | null;
  playbillListings: Record<string, PlaybillListing>;
}

/** Transient shape returned by Claude during index-page extraction. Never persisted directly. */
interface PlaybillIndexListing {
  title: string;
  url: string;
  organization: string;
}

/** Minimal URL config needed by the Playbill crawler. */
interface PlaybillUrlConfig {
  name: string;
  url: string;
}

// ─── Playbill: extract job URLs from raw HTML ─────────────────────────────────

/** Extracts all unique Playbill job listing hrefs (including UUID slugs) from raw HTML. */
function extractJobUrlsFromHtml(html: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const match of html.matchAll(/href="((?:https?:\/\/(?:www\.)?playbill\.com)?\/job\/[^"?#]+)"/gi)) {
    const raw = match[1];
    const full = raw.startsWith("http") ? raw : `https://playbill.com${raw}`;
    if (!seen.has(full)) {
      seen.add(full);
      results.push(full);
    }
  }
  return results;
}

// ─── Playbill: extract musician listings from index page ──────────────────────

/**
 * Stage 1 of the two-stage Playbill pipeline. Claude acts as a structured data extractor
 * rather than a classifier here: the goal is to pull (title, url, organization) tuples
 * from unstructured HTML-stripped text. Known job URLs extracted from raw HTML are
 * provided to Claude so it matches titles to correct, complete URLs rather than
 * constructing or guessing them.
 *
 * Errors are swallowed and return [] by design — a bad Claude response on the index
 * should not halt the run or suppress notifications from other sources.
 */
async function extractPlaybillListings(
  client: Anthropic,
  indexText: string,
  knownJobUrls: string[]
): Promise<PlaybillIndexListing[]> {
  const urlList = knownJobUrls.map((u, i) => `${i + 1}. ${u}`).join("\n");

  const prompt = `You are helping a professional trumpet player find performing musician job listings.

The page below is pre-filtered to the "Musician" category on Playbill. For each job posting visible
in the page content, match it to one of the known listing URLs provided below (extracted directly
from the page's HTML, so they are correct and complete). Use ONLY URLs from the list — do not
construct or guess URLs.

EXCLUDE any non-performing roles such as: Music Director, Conductor, Director of Music,
Music Administrator, or similar leadership/administrative titles.
Also EXCLUDE any unpaid, volunteer, internship, or stipend-only positions. Only include paid jobs.

Return a JSON array only (no prose):
[{ "title": string, "url": string, "organization": string }]

- url: must be one of the known URLs listed below — copy it exactly
- Return [] if no relevant listings found.

Known listing URLs (extracted from page HTML):
${urlList}

Page content (first 6000 chars):
${indexText.slice(0, 6000)}`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array found");

    const listings = JSON.parse(match[0]) as PlaybillIndexListing[];
    const knownSet = new Set(knownJobUrls);

    // Only keep entries whose URL is in the known set — drop anything Claude hallucinated
    return listings.filter(
      (l) =>
        l &&
        typeof l.title === "string" &&
        typeof l.url === "string" &&
        typeof l.organization === "string" &&
        knownSet.has(l.url)
    );
  } catch (err) {
    console.warn(`  ⚠️  extractPlaybillListings failed: ${err}`);
    return [];
  }
}

// ─── Playbill: check if a listing detail page mentions trumpet ─────────────────

/**
 * Stage 2 of the Playbill pipeline. Claude acts as a binary classifier against a
 * single listing's full description. This is intentionally a separate Claude call from
 * Stage 1 because the index page has only listing metadata (title, org), while
 * instrument requirements are buried in the detail page body. The two-call design
 * avoids fetching every detail page on every run — Stage 1 gates which listings
 * even reach Stage 2 via the `notified` flag in state.
 */
async function checkListingForTrumpet(
  client: Anthropic,
  listingText: string,
  listingUrl: string
): Promise<{ hasTrumpet: boolean; summary: string | null }> {
  const prompt = `You are checking a job listing to see if it specifically needs a trumpet player.

Does this listing mention TRUMPET as an instrument sought? This includes:
- Principal/Second/Section/Associate Trumpet
- Trumpet substitute, extra, or sub
- Brass auditions that explicitly include trumpet
- General orchestral auditions where brass/trumpet players would audition

Do NOT return true for: general musician listings with no instrument specification,
listings only mentioning other brass (trombone, horn, tuba), or purely administrative roles.

Return JSON only: { "hasTrumpet": boolean, "summary": string | null }
- summary: 1-2 sentences describing the position (null if hasTrumpet is false)

Listing URL: ${listingUrl}
Content (first 4000 chars):
${listingText.slice(0, 4000)}`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found");
    return JSON.parse(match[0]) as { hasTrumpet: boolean; summary: string | null };
  } catch (err) {
    console.warn(`  ⚠️  checkListingForTrumpet failed: ${err}`);
    return { hasTrumpet: false, summary: null };
  }
}

// ─── Playbill: orchestrate two-level crawl ────────────────────────────────────

/**
 * Coordinator for the Playbill multi-level crawl. Mutates `state` directly (passed
 * by reference) so that intermediate listing discoveries and trumpet verdicts are
 * captured even if the function is interrupted before returning — the caller saves
 * state to disk after this returns, but partial progress is preserved in the object.
 *
 * Two-tier cache strategy:
 *   1. Index page hash — if unchanged, skip re-extraction entirely (no Claude call).
 *      New listings can only appear if the index changes.
 *   2. `notified` flag per listing — drives which detail pages get fetched each run,
 *      regardless of the index hash. This handles the case where a prior run confirmed
 *      trumpet but the email send failed before `notified` was written.
 *
 * Non-trumpet listings are marked `notified=true` immediately to prevent redundant
 * detail-page fetches on future runs. Only trumpet-positive listings stay pending
 * until a successful email delivery is confirmed by the caller.
 */
export async function processPlaybillUrl(
  client: Anthropic,
  urlConfig: PlaybillUrlConfig,
  state: PlaybillState
): Promise<PlaybillFinding[]> {
  console.log(`\n📋 Playbill Job Board`);
  const findings: PlaybillFinding[] = [];
  const now = new Date().toISOString();

  // 1. Fetch and hash the index page
  let indexText: string;
  let indexHtml: string;
  try {
    ({ text: indexText, html: indexHtml } = await scrapeUrlRaw(urlConfig.url));
  } catch (err) {
    console.error(`  ❌ Failed to fetch Playbill index: ${err}`);
    return findings;
  }

  const indexHash = contentHash(indexText);
  const indexChanged = indexHash !== state.playbillIndexHash;

  if (indexChanged) {
    console.log(`  🔍 Index page changed — extracting musician listings...`);
    state.playbillIndexHash = indexHash;

    // 2. Extract job URLs from raw HTML (preserves full slugs including UUID hashes)
    const jobUrls = extractJobUrlsFromHtml(indexHtml);
    console.log(`  → Found ${jobUrls.length} job URL(s) in page HTML`);

    // 3. Extract musician listings from the index
    const extracted = await extractPlaybillListings(client, indexText, jobUrls);
    console.log(`  → Found ${extracted.length} musician listing(s) on index`);

    // 4. Register any new listings in state (don't overwrite existing entries)
    for (const item of extracted) {
      if (!state.playbillListings[item.url]) {
        console.log(`    ✨ New listing: "${item.title}" — ${item.organization}`);
        state.playbillListings[item.url] = {
          url: item.url,
          title: item.title,
          organization: item.organization,
          firstSeen: now,
          lastChecked: "",
          hasTrumpet: false,
          notified: false,
          summary: null,
        };
      }
    }
  } else {
    console.log(`  ✓ Index page unchanged — checking any pending listings`);
  }

  // 5. Process all unnotified listings (regardless of index change)
  const pending = Object.values(state.playbillListings).filter((l) => !l.notified);
  console.log(`  → ${pending.length} unnotified listing(s) to process`);

  for (const listing of pending) {
    // Already confirmed trumpet on a prior run but email failed — collect without re-fetching
    if (listing.hasTrumpet) {
      console.log(`    🎺 "${listing.title}" — trumpet confirmed (pending notification)`);
      findings.push({
        listingUrl: listing.url,
        title: listing.title,
        organization: listing.organization,
        summary: listing.summary,
      });
      continue;
    }

    // Fetch detail page and check for trumpet
    console.log(`    Checking: "${listing.title}"`);
    try {
      const detailText = await scrapeUrl(listing.url);
      const { hasTrumpet, summary } = await checkListingForTrumpet(client, detailText, listing.url);

      listing.lastChecked = now;
      listing.hasTrumpet = hasTrumpet;
      listing.summary = summary;

      if (hasTrumpet) {
        console.log(`    🎺 Trumpet found! "${listing.title}"`);
        findings.push({
          listingUrl: listing.url,
          title: listing.title,
          organization: listing.organization,
          summary,
        });
      } else {
        console.log(`    ✗ No trumpet mention`);
        // Mark notified=true to avoid rechecking non-trumpet listings every run
        listing.notified = true;
      }
    } catch (err) {
      console.warn(`    ⚠️  Could not process listing "${listing.title}": ${err}`);
    }
  }

  return findings;
}
