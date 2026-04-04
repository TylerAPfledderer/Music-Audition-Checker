import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// Mock scraper module before importing the module under test
vi.mock("../src/scraper", () => ({
  scrapeUrlRaw: vi.fn(),
  scrapeUrl: vi.fn(),
  contentHash: vi.fn(),
}));

import { scrapeUrlRaw, scrapeUrl, contentHash } from "../src/scraper";
import { extractJobUrlsFromHtml, extractPlaybillJobUrls, processPlaybillUrl } from "../src/playbill-crawler";
import type { PlaybillState } from "../src/playbill-crawler";

// Factory for a fake Anthropic client
function makeClient(createFn = vi.fn()) {
  return { messages: { create: createFn } } as unknown as Anthropic;
}

// Build a Claude response envelope around a JSON string
function claudeResponse(json: string) {
  return Promise.resolve({
    content: [{ type: "text", text: json }],
  });
}

// Build a fresh empty PlaybillState
function emptyState(): PlaybillState {
  return { playbillIndexHash: null, playbillListings: {} };
}

// ─── extractJobUrlsFromHtml ────────────────────────────────────────────────────

describe("extractJobUrlsFromHtml", () => {
  it("extracts absolute playbill.com /job/... URLs", () => {
    const html = '<a href="https://playbill.com/job/principal-trumpet">Trumpet</a>';
    expect(extractJobUrlsFromHtml(html)).toEqual([
      "https://playbill.com/job/principal-trumpet",
    ]);
  });

  it("expands relative /job/... hrefs to absolute URLs", () => {
    const html = '<a href="/job/section-violin-abc123">Violin</a>';
    expect(extractJobUrlsFromHtml(html)).toEqual([
      "https://playbill.com/job/section-violin-abc123",
    ]);
  });

  it("deduplicates repeated URLs", () => {
    const html = `
      <a href="/job/trumpet-123">First link</a>
      <a href="/job/trumpet-123">Second link</a>
    `;
    expect(extractJobUrlsFromHtml(html)).toHaveLength(1);
  });

  it("ignores non-job hrefs", () => {
    const html = `
      <a href="/article/news">Article</a>
      <a href="/show/hamilton">Show</a>
      <a href="https://example.com/other">Other</a>
    `;
    expect(extractJobUrlsFromHtml(html)).toHaveLength(0);
  });

  it("returns empty array for HTML with no job links", () => {
    expect(extractJobUrlsFromHtml("<p>No links here</p>")).toEqual([]);
  });

  it("handles UUID slugs in job URLs", () => {
    const url = "https://playbill.com/job/principal-trumpet-abc123def456";
    const html = `<a href="${url}">Trumpet</a>`;
    expect(extractJobUrlsFromHtml(html)).toEqual([url]);
  });

  it("extracts multiple distinct job URLs", () => {
    const html = `
      <a href="/job/trumpet-abc">Trumpet</a>
      <a href="/job/violin-xyz">Violin</a>
      <a href="/job/piano-def">Piano</a>
    `;
    expect(extractJobUrlsFromHtml(html)).toHaveLength(3);
  });

  it("is case-insensitive for the href attribute name", () => {
    const html = '<a HREF="/job/trumpet-upper">Trumpet</a>';
    expect(extractJobUrlsFromHtml(html)).toEqual([
      "https://playbill.com/job/trumpet-upper",
    ]);
  });
});

// ─── extractPlaybillJobUrls ───────────────────────────────────────────────────

describe("extractPlaybillJobUrls", () => {
  it("returns Firecrawl links filtered to playbill.com /job/ paths", () => {
    const firecrawlLinks = [
      "https://playbill.com/job/principal-trumpet-abc",
      "https://playbill.com/job/section-violin-xyz",
      "https://playbill.com/article/news",  // should be excluded
      "https://example.com/job/other",      // should be excluded (wrong domain)
    ];
    const result = extractPlaybillJobUrls("", firecrawlLinks);
    expect(result).toEqual([
      "https://playbill.com/job/principal-trumpet-abc",
      "https://playbill.com/job/section-violin-xyz",
    ]);
  });

  it("falls back to HTML regex when firecrawlLinks is undefined", () => {
    const html = '<a href="/job/trumpet-fallback">Trumpet</a>';
    const result = extractPlaybillJobUrls(html, undefined);
    expect(result).toEqual(["https://playbill.com/job/trumpet-fallback"]);
  });

  it("falls back to HTML regex when firecrawlLinks is empty", () => {
    const html = '<a href="/job/trumpet-fallback">Trumpet</a>';
    const result = extractPlaybillJobUrls(html, []);
    expect(result).toEqual(["https://playbill.com/job/trumpet-fallback"]);
  });

  it("falls back to HTML regex when Firecrawl links contain no /job/ matches", () => {
    const firecrawlLinks = ["https://playbill.com/article/news", "https://playbill.com/shows"];
    const html = '<a href="/job/trumpet-html">Trumpet</a>';
    const result = extractPlaybillJobUrls(html, firecrawlLinks);
    expect(result).toEqual(["https://playbill.com/job/trumpet-html"]);
  });

  it("deduplicates Firecrawl links", () => {
    const firecrawlLinks = [
      "https://playbill.com/job/trumpet-abc",
      "https://playbill.com/job/trumpet-abc",
    ];
    expect(extractPlaybillJobUrls("", firecrawlLinks)).toHaveLength(1);
  });

  it("accepts www.playbill.com variants in Firecrawl links", () => {
    const firecrawlLinks = ["https://www.playbill.com/job/trumpet-www"];
    expect(extractPlaybillJobUrls("", firecrawlLinks)).toEqual([
      "https://www.playbill.com/job/trumpet-www",
    ]);
  });

  it("excludes Firecrawl links with query strings or fragments", () => {
    const firecrawlLinks = [
      "https://playbill.com/job/trumpet?ref=test",   // query string — excluded
      "https://playbill.com/job/trumpet#section",    // fragment — excluded
      "https://playbill.com/job/clean-url",          // clean — included
    ];
    expect(extractPlaybillJobUrls("", firecrawlLinks)).toEqual([
      "https://playbill.com/job/clean-url",
    ]);
  });
});

// ─── processPlaybillUrl — index unchanged, no pending listings ──────────────────

describe("processPlaybillUrl — index unchanged, no pending listings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty array and skips Claude when nothing pending", async () => {
    const indexText = "Musician jobs page";
    const indexHtml = '<a href="/job/trumpet-1">Trumpet</a>';
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: indexText, html: indexHtml });
    vi.mocked(contentHash).mockReturnValue("abc123");

    const state: PlaybillState = {
      playbillIndexHash: "abc123", // matches → index unchanged
      playbillListings: {},
    };
    const client = makeClient();

    const findings = await processPlaybillUrl(client, { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(findings).toEqual([]);
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(scrapeUrl).not.toHaveBeenCalled();
  });

  it("does not update playbillIndexHash when index is unchanged", async () => {
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "content", html: "" });
    vi.mocked(contentHash).mockReturnValue("stable-hash");

    const state: PlaybillState = { playbillIndexHash: "stable-hash", playbillListings: {} };

    await processPlaybillUrl(makeClient(), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(state.playbillIndexHash).toBe("stable-hash");
  });
});

// ─── processPlaybillUrl — index unchanged, pending listings ────────────────────

describe("processPlaybillUrl — index unchanged but pending listings exist", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("processes pending listings even when index hash is unchanged", async () => {
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "index content", html: "" });
    vi.mocked(contentHash).mockReturnValue("same-hash");
    vi.mocked(scrapeUrl).mockResolvedValue("This position requires a Trumpet player.");

    const createFn = vi.fn().mockReturnValue(
      claudeResponse(JSON.stringify({ hasTrumpet: true, summary: "Principal Trumpet opening" }))
    );
    const client = makeClient(createFn);

    const state: PlaybillState = {
      playbillIndexHash: "same-hash",
      playbillListings: {
        "https://playbill.com/job/trumpet-pending": {
          url: "https://playbill.com/job/trumpet-pending",
          title: "Principal Trumpet",
          organization: "Test Orchestra",
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastChecked: "",
          hasTrumpet: false,
          notified: false,
          summary: null,
        },
      },
    };

    const findings = await processPlaybillUrl(client, { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(scrapeUrl).toHaveBeenCalledWith("https://playbill.com/job/trumpet-pending");
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe("Principal Trumpet");
  });
});

// ─── processPlaybillUrl — index changed ──────────────────────────────────────

describe("processPlaybillUrl — index changed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("updates playbillIndexHash in state when index changes", async () => {
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "new content", html: "" });
    vi.mocked(contentHash).mockReturnValue("new-hash");
    vi.mocked(scrapeUrl).mockResolvedValue("No trumpet mentioned.");

    const createFn = vi.fn()
      .mockReturnValueOnce(claudeResponse("[]")) // extractPlaybillListings
      .mockReturnValue(claudeResponse(JSON.stringify({ hasTrumpet: false, summary: null })));

    const state = emptyState();
    state.playbillIndexHash = "old-hash";

    await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(state.playbillIndexHash).toBe("new-hash");
  });

  it("registers new listings discovered on the index page", async () => {
    const jobUrl = "https://playbill.com/job/section-horn-xyz";
    const indexHtml = `<a href="${jobUrl}">Horn</a>`;
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "Musicians page content", html: indexHtml });
    vi.mocked(contentHash).mockReturnValue("changed-hash");
    vi.mocked(scrapeUrl).mockResolvedValue("Looking for a French Horn player.");

    const extractedListings = [{ title: "Section Horn", url: jobUrl, organization: "City Orchestra" }];
    const createFn = vi.fn()
      .mockReturnValueOnce(claudeResponse(JSON.stringify(extractedListings)))
      .mockReturnValue(claudeResponse(JSON.stringify({ hasTrumpet: false, summary: null })));

    const state = emptyState();

    await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(state.playbillListings[jobUrl]).toBeDefined();
    expect(state.playbillListings[jobUrl].title).toBe("Section Horn");
    expect(state.playbillListings[jobUrl].organization).toBe("City Orchestra");
  });

  it("uses Firecrawl links from scrapeUrlRaw when available instead of HTML regex", async () => {
    const firecrawlJobUrl = "https://playbill.com/job/firecrawl-only-url";
    // The HTML has a different URL than the Firecrawl links array
    const indexHtml = '<a href="/job/html-only-url">HTML Job</a>';
    vi.mocked(scrapeUrlRaw).mockResolvedValue({
      text: "Musicians page content",
      html: indexHtml,
      links: [firecrawlJobUrl, "https://playbill.com/article/news"],
    });
    vi.mocked(contentHash).mockReturnValue("changed-hash");
    vi.mocked(scrapeUrl).mockResolvedValue("No trumpet mentioned.");

    const extractedListings = [{ title: "Firecrawl Job", url: firecrawlJobUrl, organization: "Firecrawl Orchestra" }];
    const createFn = vi.fn()
      .mockReturnValueOnce(claudeResponse(JSON.stringify(extractedListings)))
      .mockReturnValue(claudeResponse(JSON.stringify({ hasTrumpet: false, summary: null })));

    const state = emptyState();
    await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    // The listing from Firecrawl links should be registered; the HTML-only URL should not
    expect(state.playbillListings[firecrawlJobUrl]).toBeDefined();
    expect(state.playbillListings["https://playbill.com/job/html-only-url"]).toBeUndefined();
  });

  it("does not overwrite an existing listing entry when re-encountered", async () => {
    const jobUrl = "https://playbill.com/job/trumpet-existing";
    const indexHtml = `<a href="${jobUrl}">Trumpet</a>`;
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "page", html: indexHtml });
    vi.mocked(contentHash).mockReturnValue("new-hash");
    vi.mocked(scrapeUrl).mockResolvedValue("Trumpet player needed.");

    const extractedListings = [{ title: "Principal Trumpet", url: jobUrl, organization: "Symphony" }];
    const createFn = vi.fn()
      .mockReturnValueOnce(claudeResponse(JSON.stringify(extractedListings)))
      .mockReturnValue(claudeResponse(JSON.stringify({ hasTrumpet: true, summary: "Trumpet" })));

    const existingFirstSeen = "2025-12-01T00:00:00.000Z";
    const state: PlaybillState = {
      playbillIndexHash: "old-hash",
      playbillListings: {
        [jobUrl]: {
          url: jobUrl,
          title: "Principal Trumpet",
          organization: "Symphony",
          firstSeen: existingFirstSeen,
          lastChecked: "",
          hasTrumpet: false,
          notified: false,
          summary: null,
        },
      },
    };

    await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    // firstSeen must not be overwritten
    expect(state.playbillListings[jobUrl].firstSeen).toBe(existingFirstSeen);
  });
});

// ─── processPlaybillUrl — trumpet-confirmed pending listing (email retry) ──────

describe("processPlaybillUrl — trumpet-confirmed listing pending notification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("collects trumpet-confirmed listing without re-fetching the detail page", async () => {
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "index", html: "" });
    vi.mocked(contentHash).mockReturnValue("hash");

    const jobUrl = "https://playbill.com/job/confirmed-trumpet";
    const state: PlaybillState = {
      playbillIndexHash: "hash", // index unchanged
      playbillListings: {
        [jobUrl]: {
          url: jobUrl,
          title: "Principal Trumpet",
          organization: "Grand Symphony",
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastChecked: "2026-01-02T00:00:00.000Z",
          hasTrumpet: true,   // already confirmed
          notified: false,    // email not yet sent
          summary: "Seeking a Principal Trumpet.",
        },
      },
    };

    const createFn = vi.fn();
    const findings = await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(scrapeUrl).not.toHaveBeenCalled();
    expect(createFn).not.toHaveBeenCalled();
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe("Principal Trumpet");
    expect(findings[0].summary).toBe("Seeking a Principal Trumpet.");
  });
});

// ─── processPlaybillUrl — notification flag logic ─────────────────────────────

describe("processPlaybillUrl — notification flag logic", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets notified=true for non-trumpet listings to prevent recheck", async () => {
    const jobUrl = "https://playbill.com/job/horn-player";
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "index", html: "" });
    vi.mocked(contentHash).mockReturnValue("hash");
    vi.mocked(scrapeUrl).mockResolvedValue("Looking for a French Horn player.");

    const createFn = vi.fn().mockReturnValue(
      claudeResponse(JSON.stringify({ hasTrumpet: false, summary: null }))
    );

    const state: PlaybillState = {
      playbillIndexHash: "hash",
      playbillListings: {
        [jobUrl]: {
          url: jobUrl,
          title: "Section Horn",
          organization: "City Orchestra",
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastChecked: "",
          hasTrumpet: false,
          notified: false,
          summary: null,
        },
      },
    };

    const findings = await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(findings).toHaveLength(0);
    expect(state.playbillListings[jobUrl].notified).toBe(true);
  });

  it("does NOT set notified=true for trumpet listings (caller handles after email send)", async () => {
    const jobUrl = "https://playbill.com/job/trumpet-found";
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "index", html: "" });
    vi.mocked(contentHash).mockReturnValue("hash");
    vi.mocked(scrapeUrl).mockResolvedValue("This position requires a Trumpet player.");

    const createFn = vi.fn().mockReturnValue(
      claudeResponse(JSON.stringify({ hasTrumpet: true, summary: "Principal Trumpet opening." }))
    );

    const state: PlaybillState = {
      playbillIndexHash: "hash",
      playbillListings: {
        [jobUrl]: {
          url: jobUrl,
          title: "Principal Trumpet",
          organization: "Test Symphony",
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastChecked: "",
          hasTrumpet: false,
          notified: false,
          summary: null,
        },
      },
    };

    await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(state.playbillListings[jobUrl].notified).toBe(false);
    expect(state.playbillListings[jobUrl].hasTrumpet).toBe(true);
  });
});

// ─── processPlaybillUrl — error handling ─────────────────────────────────────

describe("processPlaybillUrl — error handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty findings and does not throw if fetching the index fails", async () => {
    vi.mocked(scrapeUrlRaw).mockRejectedValue(new Error("Network error"));

    const state = emptyState();
    const findings = await processPlaybillUrl(makeClient(), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(findings).toEqual([]);
  });

  it("returns empty array from index extraction when Claude returns malformed JSON", async () => {
    const jobUrl = "https://playbill.com/job/some-job";
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "page", html: `<a href="${jobUrl}">Job</a>` });
    vi.mocked(contentHash).mockReturnValue("new-hash");

    // Claude returns non-JSON garbage
    const createFn = vi.fn().mockReturnValue(claudeResponse("not valid JSON at all"));
    const state = emptyState();

    // Should not throw — extractPlaybillListings swallows errors
    const findings = await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(findings).toEqual([]);
    expect(Object.keys(state.playbillListings)).toHaveLength(0);
  });

  it("returns hasTrumpet=false when checkListingForTrumpet receives malformed JSON", async () => {
    const jobUrl = "https://playbill.com/job/bad-response";
    vi.mocked(scrapeUrlRaw).mockResolvedValue({ text: "index", html: "" });
    vi.mocked(contentHash).mockReturnValue("hash");
    vi.mocked(scrapeUrl).mockResolvedValue("Some listing text.");

    // Claude returns malformed JSON on the detail check
    const createFn = vi.fn().mockReturnValue(claudeResponse("not json"));

    const state: PlaybillState = {
      playbillIndexHash: "hash",
      playbillListings: {
        [jobUrl]: {
          url: jobUrl,
          title: "Some Job",
          organization: "Org",
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastChecked: "",
          hasTrumpet: false,
          notified: false,
          summary: null,
        },
      },
    };

    const findings = await processPlaybillUrl(makeClient(createFn), { name: "Playbill", url: "https://playbill.com/jobs" }, state);

    expect(findings).toHaveLength(0);
    expect(state.playbillListings[jobUrl].hasTrumpet).toBe(false);
  });
});
