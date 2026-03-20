import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";

export const MIN_CONTENT_LENGTH = 500; // chars threshold to consider fetch "empty"

// ─── HTTP Fetch (no deps) ─────────────────────────────────────────────────────

/**
 * Intentionally uses only Node's built-in http/https modules (no axios, node-fetch, etc.)
 * to keep the dependency surface minimal for a script that runs in CI with no build step.
 */
export function fetchPage(url: string): Promise<string> {
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

// ─── Firecrawl fallback ───────────────────────────────────────────────────────

/**
 * Firecrawl fallback for JS-rendered and bot-protected pages. Handles JS rendering,
 * bot detection bypass, and proxy rotation. The dynamic import keeps this optional:
 * the script starts and runs standard URLs even without the package or API key,
 * only engaging Firecrawl when FIRECRAWL_API_KEY is set and plain HTTP falls short.
 *
 * Returns markdown (already LLM-ready, no stripHtml needed), rendered HTML,
 * and an extracted links array for downstream URL discovery.
 */
export async function fetchWithFirecrawl(
  url: string
): Promise<{ text: string; html: string; links: string[] }> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set — Firecrawl unavailable");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let FirecrawlModule: any;
  try {
    FirecrawlModule = await import("@mendable/firecrawl-js");
  } catch {
    throw new Error(
      "@mendable/firecrawl-js not installed. Run: npm install @mendable/firecrawl-js"
    );
  }

  // Default export is `Firecrawl` (v2 client); fall back to named `FirecrawlAppV1` for older installs
  const FirecrawlClass = FirecrawlModule.default ?? FirecrawlModule.FirecrawlClient;
  const app = new FirecrawlClass({ apiKey });
  const result = await app.scrape(url, {
    formats: ["markdown", "html", "links"],
  });

  return {
    text: result.markdown ?? "",
    html: result.html ?? "",
    links: result.links ?? [],
  };
}

// ─── HTML stripper ────────────────────────────────────────────────────────────

export function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
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

/**
 * Strips common dynamic text patterns (timestamps, calendar dates) from stripped
 * text before hashing. Used only for hash computation — Claude still receives
 * the full stripped text.
 */
export function normalizeForHash(text: string): string {
  return text
    // Relative timestamps: "3 hours ago", "2 days ago", "just now", etc.
    .replace(/\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/gi, "")
    .replace(/\bjust now\b/gi, "")
    .replace(/\byesterday\b/gi, "")
    // "Last updated: ..." / "Last modified: ..." lines
    .replace(/\blast\s+(updated|modified|checked)[^\n.]*/gi, "")
    // WordPress post meta: "admin 2026-02-11T21:24:08+00:00" (author + ISO timestamp)
    .replace(/\b\w+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, "")
    // Collapse any newly created whitespace gaps
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Filters normalized text down to sentences that contain audition-relevant signals,
 * plus short phrases (likely headings). Used as the final step before hashing so
 * that rotating non-audition content (featured musician bios, news, event listings)
 * does not cause spurious hash churn and unnecessary Claude re-analysis.
 *
 * Claude always receives the full stripped text — this function only affects the
 * hash input.
 */
export function extractAuditionSignals(text: string): string {
  // Keyword set is intentionally narrow: only terms that are specific to audition
  // and employment content. Broad orchestral terms like "orchestra", "symphony",
  // "musician", "ensemble", "section", and "associate" have been excluded because
  // they appear throughout orchestra websites in news articles, bios, and event
  // listings, causing those rotating sentences to pollute the hash input and
  // produce spurious hash changes when audition content is unchanged.
  const AUDITION_SIGNALS =
    /\b(audition|auditions|vacancy|vacancies|position|opening|application|applications|apply|deadline|excerpt|substitute|employment|hiring|compensation|pay|trumpet|brass|horn|trombone|tuba|percussion|strings|woodwind|principal|resume)\b/i;

  // Split on sentence-ending punctuation followed by a capital letter (new sentence)
  const sentences = text.split(/(?<=[.!?;])\s+(?=[A-Z])/);

  return sentences
    .filter((s) => AUDITION_SIGNALS.test(s))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Extracts the primary content area from raw HTML to exclude navigation, headers,
 * and footers before stripping. Tries semantic elements in priority order and falls
 * back to the full HTML if none are found.
 */
export function extractMainContent(html: string): string {
  const candidates = [
    /<main[\s\S]*?>([\s\S]*?)<\/main>/i,
    /<article[\s\S]*?>([\s\S]*?)<\/article>/i,
    /<div[^>]+\bid=["'](?:main|content|page-content|main-content|primary)["'][^>]*>([\s\S]*)<\/div>/i,
    /<div[^>]+\bclass=["'][^"']*\b(?:main-content|page-content|entry-content|post-content|site-content)\b[^"']*["'][^>]*>([\s\S]*)<\/div>/i,
    /<div[^>]+\bclass=["']content["'][^>]*>([\s\S]*)<\/div>/i,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return html;
}

// ─── Scrape with fallback ─────────────────────────────────────────────────────

/**
 * Chain of Responsibility: plain HTTP → Firecrawl (when FIRECRAWL_API_KEY is set),
 * with a content-length gate as the Firecrawl trigger. Returns both the text content
 * and raw HTML so callers that need href extraction can get it without a second fetch.
 * When Firecrawl is used, also returns a `links` array of extracted URLs.
 */
export async function scrapeUrlRaw(
  url: string
): Promise<{ text: string; html: string; links?: string[] }> {
  console.log(`  Fetching: ${url}`);
  let html = "";

  // Tier 1: native HTTP
  try {
    html = await fetchPage(url);
  } catch (err) {
    console.log(`  Fetch failed (${err}), trying Firecrawl...`);
  }

  // Tier 2: Firecrawl — on fetch failure OR content too short
  if (html.length < MIN_CONTENT_LENGTH && process.env.FIRECRAWL_API_KEY) {
    if (html.length > 0) {
      console.log(`  Content too short (${html.length} chars), falling back to Firecrawl...`);
    }
    try {
      const fc = await fetchWithFirecrawl(url);
      console.log(`  Firecrawl succeeded`);
      // Firecrawl markdown is already clean — skip stripHtml
      return { text: fc.text, html: fc.html, links: fc.links };
    } catch (fcErr) {
      console.warn(`  Firecrawl failed: ${fcErr}`);
      // Fall through — return whatever plain HTTP gave us
    }
  }

  return { text: stripHtml(html), html };
}

export async function scrapeUrl(url: string): Promise<string> {
  return (await scrapeUrlRaw(url)).text;
}

// ─── Content hash ─────────────────────────────────────────────────────────────

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Full hash pipeline: normalize → extract signals → SHA256. */
export function computePageHash(text: string): string {
  return contentHash(extractAuditionSignals(normalizeForHash(text)));
}
