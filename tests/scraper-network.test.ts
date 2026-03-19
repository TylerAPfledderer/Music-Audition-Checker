/**
 * Tests for network timeout configuration in scraper.ts.
 * These guard against accidentally reducing timeouts that caused real CI failures
 * (e.g., Playbill's JS-rendered SPA timing out in GitHub Actions).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted ensures these refs are available inside the vi.mock() factories,
// which are hoisted to the top of the file before any imports.
const { mockGoto, mockContent, mockNewPage, mockBrowserClose, mockLaunch, mockEvaluateOnNewDocument } =
  vi.hoisted(() => ({
    mockGoto: vi.fn(),
    mockContent: vi.fn(),
    mockNewPage: vi.fn(),
    mockBrowserClose: vi.fn(),
    mockLaunch: vi.fn(),
    mockEvaluateOnNewDocument: vi.fn(),
  }));

vi.mock("puppeteer", () => ({
  default: { launch: mockLaunch },
}));

vi.mock("https", () => ({
  get: vi.fn(),
}));

import * as https from "https";
import { fetchPage, fetchWithPuppeteer, scrapeUrlRaw } from "../src/scraper";

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

// ─── fetchWithPuppeteer ───────────────────────────────────────────────────────

describe("fetchWithPuppeteer", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGoto.mockResolvedValue(undefined);
    mockContent.mockResolvedValue("<html><body>loaded page content</body></html>");
    mockEvaluateOnNewDocument.mockResolvedValue(undefined);
    mockNewPage.mockResolvedValue({
      setUserAgent: vi.fn().mockResolvedValue(undefined),
      evaluateOnNewDocument: mockEvaluateOnNewDocument,
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      goto: mockGoto,
      content: mockContent,
    });
    mockBrowserClose.mockResolvedValue(undefined);
    mockLaunch.mockResolvedValue({
      newPage: mockNewPage,
      close: mockBrowserClose,
    });
  });

  it("uses a 60-second navigation timeout", async () => {
    await fetchWithPuppeteer("https://playbill.com/jobs");

    expect(mockGoto).toHaveBeenCalledWith(
      "https://playbill.com/jobs",
      expect.objectContaining({ timeout: 60000 })
    );
  });

  it("removes navigator.webdriver before navigation (anti-bot)", async () => {
    await fetchWithPuppeteer("https://playbill.com/jobs");
    expect(mockEvaluateOnNewDocument).toHaveBeenCalled();
    // evaluateOnNewDocument must be called before goto
    const evalOrder = mockEvaluateOnNewDocument.mock.invocationCallOrder[0];
    const gotoOrder = mockGoto.mock.invocationCallOrder[0];
    expect(evalOrder).toBeLessThan(gotoOrder);
  });

  it("always closes the browser, even on error", async () => {
    mockGoto.mockRejectedValue(new Error("Navigation timeout"));

    await expect(
      fetchWithPuppeteer("https://example.com")
    ).rejects.toThrow("Navigation timeout");

    expect(mockBrowserClose).toHaveBeenCalled();
  });
});

// ─── scrapeUrlRaw graceful fallback ──────────────────────────────────────────

describe("scrapeUrlRaw — Puppeteer graceful fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves with short HTTP content when Puppeteer fails (bot-detection scenario)", async () => {
    // Simulate: HTTP fetch returns short content (< MIN_CONTENT_LENGTH),
    // then Puppeteer navigation hangs/times out.
    const shortHtml = "<html><body>No auditions</body></html>"; // < 500 chars

    const mockRes = {
      statusCode: 200,
      headers: {},
      on: vi.fn().mockImplementation(function (this: any, event: string, cb: (...args: any[]) => void) {
        if (event === "data") cb(shortHtml);
        if (event === "end") cb();
        return this;
      }),
    };
    const mockReq = { on: vi.fn(), setTimeout: vi.fn() };
    vi.mocked(https.get).mockImplementation((_u: any, _o: any, cb?: any) => {
      if (typeof cb === "function") cb(mockRes);
      return mockReq as any;
    });

    // Puppeteer times out
    mockGoto.mockRejectedValue(new Error("Navigation timeout of 60000 ms exceeded"));

    // Should resolve (not throw) and return stripped text from the short HTML
    const result = await scrapeUrlRaw("https://example.com");
    expect(result.text).toContain("No auditions");
  });
});
