/**
 * Tests for network timeout configuration and Firecrawl fallback in scraper.ts.
 * These guard against accidentally breaking the HTTP timeout and the Firecrawl
 * API key gate.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("https", () => ({
  get: vi.fn(),
}));

import * as https from "https";
import { fetchPage } from "../src/scraper";

// ─── fetchPage ────────────────────────────────────────────────────────────────

describe("fetchPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects with 'Request timed out' when the request stalls", async () => {
    let capturedTimeoutMs: number | undefined;
    const mockReq = {
      on: vi.fn(),
      destroy: vi.fn(),
      setTimeout: vi.fn().mockImplementation((ms: number, cb: () => void) => {
        capturedTimeoutMs = ms;
        cb(); // trigger immediately to simulate a stalled request
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(https.get).mockImplementation(() => mockReq as any);

    await expect(fetchPage("https://example.com")).rejects.toThrow(
      "Request timed out"
    );
    expect(mockReq.destroy).toHaveBeenCalled();
    expect(capturedTimeoutMs).toBe(15000);
  });
});

// ─── fetchWithFirecrawl ───────────────────────────────────────────────────────

describe("fetchWithFirecrawl", () => {
  const savedKey = process.env.FIRECRAWL_API_KEY;

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env.FIRECRAWL_API_KEY;
    } else {
      process.env.FIRECRAWL_API_KEY = savedKey;
    }
    vi.resetModules();
  });

  it("throws immediately when FIRECRAWL_API_KEY is not set", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const { fetchWithFirecrawl } = await import("../src/scraper.ts");
    await expect(fetchWithFirecrawl("https://example.com")).rejects.toThrow(
      "FIRECRAWL_API_KEY is not set"
    );
  });

  it("calls scrape() with markdown, html, and links formats", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key";

    const mockScrape = vi.fn().mockResolvedValue({
      markdown: "# Audition page",
      html: "<h1>Audition page</h1>",
      links: ["https://playbill.com/job/trumpet-abc"],
    });
    vi.doMock("@mendable/firecrawl-js", () => ({
      default: class MockFirecrawl {
        scrape = mockScrape;
      },
    }));

    const { fetchWithFirecrawl } = await import("../src/scraper.ts");
    const result = await fetchWithFirecrawl("https://example.com");

    expect(mockScrape).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ formats: expect.arrayContaining(["markdown", "html", "links"]) })
    );
    expect(result.text).toBe("# Audition page");
    expect(result.html).toBe("<h1>Audition page</h1>");
    expect(result.links).toEqual(["https://playbill.com/job/trumpet-abc"]);
  });

  it("propagates errors thrown by the Firecrawl client", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key";

    vi.doMock("@mendable/firecrawl-js", () => ({
      default: class MockFirecrawl {
        scrape = vi.fn().mockRejectedValue(new Error("Page blocked by anti-bot"));
      },
    }));

    const { fetchWithFirecrawl } = await import("../src/scraper.ts");
    await expect(fetchWithFirecrawl("https://example.com")).rejects.toThrow(
      "Page blocked by anti-bot"
    );
  });
});
