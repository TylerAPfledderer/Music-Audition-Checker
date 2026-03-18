/**
 * Tests for network timeout configuration in scraper.ts.
 * These guard against accidentally reducing timeouts that caused real CI failures
 * (e.g., Playbill's JS-rendered SPA timing out in GitHub Actions).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted ensures these refs are available inside the vi.mock() factories,
// which are hoisted to the top of the file before any imports.
const { mockGoto, mockContent, mockNewPage, mockBrowserClose, mockLaunch } =
  vi.hoisted(() => ({
    mockGoto: vi.fn(),
    mockContent: vi.fn(),
    mockNewPage: vi.fn(),
    mockBrowserClose: vi.fn(),
    mockLaunch: vi.fn(),
  }));

vi.mock("puppeteer", () => ({
  default: { launch: mockLaunch },
}));

vi.mock("https", () => ({
  get: vi.fn(),
}));

import * as https from "https";
import { fetchPage, fetchWithPuppeteer } from "../src/scraper";

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
    mockNewPage.mockResolvedValue({
      setUserAgent: vi.fn().mockResolvedValue(undefined),
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

  it("always closes the browser, even on error", async () => {
    mockGoto.mockRejectedValue(new Error("Navigation timeout"));

    await expect(
      fetchWithPuppeteer("https://example.com")
    ).rejects.toThrow("Navigation timeout");

    expect(mockBrowserClose).toHaveBeenCalled();
  });
});
