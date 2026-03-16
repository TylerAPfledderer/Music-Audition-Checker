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

// ─── Puppeteer fallback ───────────────────────────────────────────────────────

/**
 * JS-rendered pages (SPAs, lazy-loaded content) return near-empty HTML via plain HTTP.
 * Puppeteer is the escape hatch for those cases. The dynamic import keeps this optional:
 * the script starts and runs standard URLs even if puppeteer isn't installed, only
 * failing at the point a JS-rendered page is actually needed.
 */
export async function fetchWithPuppeteer(url: string): Promise<string> {
  // Dynamically import so the script still runs if puppeteer isn't installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let puppeteer: any;
  try {
    puppeteer = await import("puppeteer");
  } catch {
    throw new Error(
      "Puppeteer not installed. Run: npm install puppeteer  (or add to package.json)"
    );
  }

  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (compatible; AuditionChecker/1.0; +https://github.com)"
    );
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait a bit more for lazy-loaded content
    await new Promise((r) => setTimeout(r, 2000));
    return await page.content();
  } finally {
    await browser.close();
  }
}

// ─── HTML stripper ────────────────────────────────────────────────────────────

export function stripHtml(html: string): string {
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

/**
 * Chain of Responsibility: plain HTTP → Puppeteer, with a content-length gate as
 * the second fallback trigger. Returns both raw HTML and stripped text so callers
 * that need href extraction can get it without a second fetch.
 */
export async function scrapeUrlRaw(url: string): Promise<{ text: string; html: string }> {
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

  return { text: stripHtml(html), html };
}

export async function scrapeUrl(url: string): Promise<string> {
  return (await scrapeUrlRaw(url)).text;
}

// ─── Content hash ─────────────────────────────────────────────────────────────

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}
