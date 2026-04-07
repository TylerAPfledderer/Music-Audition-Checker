import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeSubjectRfc2047, buildEmailRaw } from "../src/email";
import { shouldNotify, canonicalizeLabel, processStandardUrl, PageState } from "../src/check-auditions";
import { computePageHash } from "../src/scraper";
import type { LlmClient } from "../src/llm";

// Mock scraper's network functions — keep pure functions (computePageHash etc.) real
vi.mock("../src/scraper", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scraper")>();
  return {
    ...actual,
    scrapeUrl: vi.fn(),
  };
});

// Helper: decode base64url MIME message back to UTF-8 text
function decodeMime(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// Helper: decode a single RFC 2047 encoded-word header value
function decodeRfc2047(encoded: string): string {
  const base64Part = encoded.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
  return Buffer.from(base64Part, "base64").toString("utf-8");
}

const REALISTIC_SUBJECT = "🎺 1 new trumpet audition found — Saturday, March 7, 2026";

describe("encodeSubjectRfc2047", () => {
  it("wraps output in RFC 2047 encoded-word syntax", () => {
    const encoded = encodeSubjectRfc2047("Hello");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
  });

  it("round-trips ASCII text losslessly", () => {
    const text = "Simple ASCII subject";
    expect(decodeRfc2047(encodeSubjectRfc2047(text))).toBe(text);
  });

  it("round-trips trumpet emoji losslessly", () => {
    const encoded = encodeSubjectRfc2047(REALISTIC_SUBJECT);
    expect(decodeRfc2047(encoded)).toContain("🎺");
  });

  it("round-trips em dash losslessly", () => {
    const encoded = encodeSubjectRfc2047(REALISTIC_SUBJECT);
    expect(decodeRfc2047(encoded)).toContain("—");
  });

  it("round-trips a full realistic subject line exactly", () => {
    expect(decodeRfc2047(encodeSubjectRfc2047(REALISTIC_SUBJECT))).toBe(REALISTIC_SUBJECT);
  });

  it("handles an empty string", () => {
    const encoded = encodeSubjectRfc2047("");
    expect(decodeRfc2047(encoded)).toBe("");
  });
});

describe("buildEmailRaw", () => {
  const params = {
    from: "Audition Checker <sender@example.com>",
    to: "notify@example.com",
    subject: REALISTIC_SUBJECT,
    html: "<h2>🎺 Trumpet Audition Alert — Saturday, March 7, 2026</h2><p>Found one.</p>",
  };

  it("produces a base64url-encoded string with no +, /, or trailing =", () => {
    const raw = buildEmailRaw(params);
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    expect(raw).not.toMatch(/=+$/);
  });

  it("MIME text contains the From header", () => {
    const mime = decodeMime(buildEmailRaw(params));
    expect(mime).toContain("From: Audition Checker <sender@example.com>");
  });

  it("MIME text contains the To header", () => {
    const mime = decodeMime(buildEmailRaw(params));
    expect(mime).toContain("To: notify@example.com");
  });

  it("Subject header uses RFC 2047 encoded-word format", () => {
    const mime = decodeMime(buildEmailRaw(params));
    const match = mime.match(/^Subject: (.+)$/m);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
  });

  it("MIME text contains MIME-Version: 1.0", () => {
    const mime = decodeMime(buildEmailRaw(params));
    expect(mime).toContain("MIME-Version: 1.0");
  });

  it("MIME text contains Content-Type: text/html; charset=utf-8", () => {
    const mime = decodeMime(buildEmailRaw(params));
    expect(mime).toContain("Content-Type: text/html; charset=utf-8");
  });

  it("HTML body is preserved verbatim in the MIME text", () => {
    const mime = decodeMime(buildEmailRaw(params));
    expect(mime).toContain(params.html);
  });

  it("emojis in subject survive the full round-trip", () => {
    const mime = decodeMime(buildEmailRaw(params));
    const subjectMatch = mime.match(/^Subject: (.+)$/m);
    const decoded = decodeRfc2047(subjectMatch![1]);
    expect(decoded).toContain("🎺");
  });

  it("em dash in subject survives the full round-trip", () => {
    const mime = decodeMime(buildEmailRaw(params));
    const subjectMatch = mime.match(/^Subject: (.+)$/m);
    const decoded = decodeRfc2047(subjectMatch![1]);
    expect(decoded).toContain("—");
  });

  it("emojis in HTML body are not corrupted", () => {
    const mime = decodeMime(buildEmailRaw(params));
    expect(mime).toContain("🎺 Trumpet Audition Alert — Saturday, March 7, 2026");
  });
});

describe("shouldNotify", () => {
  it("returns false when page is not relevant", () => {
    expect(shouldNotify(false, false, [], [])).toBe(false);
    expect(shouldNotify(false, true, ["Principal Trumpet"], ["Principal Trumpet"])).toBe(false);
  });

  it("returns true on rising edge (false → true)", () => {
    expect(shouldNotify(true, false, ["Principal Trumpet"], [])).toBe(true);
  });

  it("returns false when still relevant with same items (suppress re-notification)", () => {
    // notifiedItems holds canonical form as written by canonicalizeLabel at store time
    expect(shouldNotify(true, true, ["Principal Trumpet"], ["principal trumpet"])).toBe(false);
  });

  it("returns true when still relevant and a new trumpet item was added (bug fix case)", () => {
    expect(
      shouldNotify(true, true, ["Principal Trumpet", "Second Trumpet"], ["principal trumpet"])
    ).toBe(true);
  });

  it("returns false when still relevant but only non-trumpet content changed (same relevant items)", () => {
    // Claude re-analyzed after a non-trumpet audition was added, but relevantItems is unchanged
    expect(shouldNotify(true, true, ["Principal Trumpet"], ["principal trumpet"])).toBe(false);
  });

  it("returns true when still relevant but notifiedItems is empty (never notified before)", () => {
    expect(shouldNotify(true, true, ["Principal Trumpet"], [])).toBe(true);
  });

  it("returns true on rising edge when notifiedItems is empty (new page, first notification)", () => {
    expect(shouldNotify(true, false, ["Principal Trumpet"], [])).toBe(true);
  });

  // Canonical label matching: all wording variants of the same opportunity share
  // one canonical string, so no wording change can trigger a spurious re-notification.
  it("does not re-notify when Claude uses a different phrasing for the same sub-list opportunity", () => {
    // Stored canonical: "substitute list" (written by canonicalizeLabel on first notify)
    // Claude returns a wording variant on the next run — all should canonicalize to "substitute list"
    const storedCanonical = ["substitute list"];
    expect(shouldNotify(true, true, ["Sub list for all instruments"], storedCanonical)).toBe(false);
    expect(shouldNotify(true, true, ["Substitute musician positions"], storedCanonical)).toBe(false);
    expect(
      shouldNotify(
        true,
        true,
        ["Sub list for all instruments (contact operations manager)"],
        storedCanonical
      )
    ).toBe(false);
    expect(
      shouldNotify(
        true,
        true,
        ["Substitute musician positions - general orchestral"],
        storedCanonical
      )
    ).toBe(false);
  });

  it("still notifies when a genuinely new item appears alongside an already-notified canonical", () => {
    // Sub list was previously notified; a new Principal Trumpet position just appeared.
    expect(
      shouldNotify(true, true, ["Substitute musician positions", "Principal Trumpet"], [
        "substitute list",
      ])
    ).toBe(true);
  });

  it("still notifies for a genuinely different canonical category", () => {
    expect(shouldNotify(true, true, ["Principal Trumpet"], ["substitute list"])).toBe(true);
  });
});

// ─── processStandardUrl ─────────────────────────────────────────────────────

function makeClient(generateFn: LlmClient["generate"] = vi.fn()): LlmClient {
  return { generate: generateFn };
}

const TEST_URL = { name: "Test Orchestra", url: "https://example.com/auditions" };
const BRASS_PAGE_TEXT = "Auditions open for trumpet players. Apply by June 2026.";

describe("processStandardUrl", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips LLM call when content hash is unchanged", async () => {
    const hash = computePageHash(BRASS_PAGE_TEXT);
    const previousState: PageState = {
      url: TEST_URL.url,
      name: TEST_URL.name,
      lastChecked: "2026-04-01",
      contentHash: hash,
      extractedSummary: null,
      hasRelevantAuditions: false,
      notifiedRelevantItems: [],
    };

    const client = makeClient();
    const result = await processStandardUrl({
      llm: client,
      urlConfig: TEST_URL,
      text: BRASS_PAGE_TEXT,
      html: "",
      previousState,
    });

    expect(result.action).toBe("skip-unchanged");
    expect(client.generate).not.toHaveBeenCalled();
  });

  it("calls LLM when content hash has changed", async () => {
    const previousState: PageState = {
      url: TEST_URL.url,
      name: TEST_URL.name,
      lastChecked: "2026-04-01",
      contentHash: "old-hash-that-wont-match",
      extractedSummary: null,
      hasRelevantAuditions: false,
      notifiedRelevantItems: [],
    };

    const client = makeClient(vi.fn().mockResolvedValue(JSON.stringify({
      isRelevant: false,
      instrument: [],
      deadline: null,
      location: "",
      confidenceScore: 0.9,
      summary: null,
      futureDates: [],
      relevantItems: [],
    })));

    const result = await processStandardUrl({
      llm: client,
      urlConfig: TEST_URL,
      text: BRASS_PAGE_TEXT,
      html: "",
      previousState,
    });

    expect(result.action).toBe("analyzed");
    expect(client.generate).toHaveBeenCalledOnce();
  });

  it("calls LLM on first run (no previous state)", async () => {
    const client = makeClient(vi.fn().mockResolvedValue(JSON.stringify({
      isRelevant: true,
      instrument: ["Principal Trumpet"],
      deadline: "2026-06-01",
      location: "Raleigh, NC",
      confidenceScore: 0.95,
      summary: "Trumpet audition",
      futureDates: ["2026-06-01"],
      relevantItems: ["Principal Trumpet"],
    })));

    const result = await processStandardUrl({
      llm: client,
      urlConfig: TEST_URL,
      text: BRASS_PAGE_TEXT,
      html: "",
      previousState: undefined,
    });

    expect(result.action).toBe("analyzed");
    expect(client.generate).toHaveBeenCalledOnce();
    if (result.action === "analyzed") {
      expect(result.finding).not.toBeNull();
      expect(result.finding!.name).toBe("Test Orchestra");
    }
  });

  it("skips LLM when page has no brass keywords", async () => {
    const noBrassText = "We are hiring a new marketing director and office manager.";
    const client = makeClient();

    const result = await processStandardUrl({
      llm: client,
      urlConfig: TEST_URL,
      text: noBrassText,
      html: "",
      previousState: undefined,
    });

    expect(result.action).toBe("skip-no-brass");
    expect(client.generate).not.toHaveBeenCalled();
  });
});

describe("canonicalizeLabel", () => {
  // Trumpet positions — most-specific first
  it("maps principal/associate/1st/first trumpet variants to 'principal trumpet'", () => {
    expect(canonicalizeLabel("Principal Trumpet")).toBe("principal trumpet");
    expect(canonicalizeLabel("Associate Principal Trumpet")).toBe("principal trumpet");
    expect(canonicalizeLabel("1st Trumpet")).toBe("principal trumpet");
  });

  it("maps second/2nd trumpet variants to 'second trumpet'", () => {
    expect(canonicalizeLabel("Second Trumpet")).toBe("second trumpet");
    expect(canonicalizeLabel("2nd Trumpet")).toBe("second trumpet");
  });

  it("maps section trumpet to 'section trumpet'", () => {
    expect(canonicalizeLabel("Section Trumpet")).toBe("section trumpet");
  });

  it("maps generic trumpet mention to 'trumpet'", () => {
    expect(canonicalizeLabel("Trumpet (extra)")).toBe("trumpet");
  });

  // Substitute list — covers all real-world label variants seen in production
  it("maps sub/substitute list variants to 'substitute list'", () => {
    expect(canonicalizeLabel("Sub list for all instruments")).toBe("substitute list");
    expect(canonicalizeLabel("Sub list for all instruments (contact operations manager)")).toBe(
      "substitute list"
    );
    expect(canonicalizeLabel("Substitute musician positions")).toBe("substitute list");
    expect(canonicalizeLabel("Substitute musician positions - general orchestral")).toBe(
      "substitute list"
    );
    expect(canonicalizeLabel("Section and sub positions for all instruments")).toBe(
      "substitute list"
    );
    expect(canonicalizeLabel("substitute positions on all instruments")).toBe("substitute list");
  });

  // Open/annual positions
  it("maps open/annual/general audition variants to 'open positions'", () => {
    expect(canonicalizeLabel("open positions annually in late summer")).toBe("open positions");
    expect(canonicalizeLabel("General orchestral audition")).toBe("open positions");
    expect(canonicalizeLabel("Annual auditions")).toBe("open positions");
  });

  // Fallback
  it("returns lowercased, stripped fallback for unknown labels", () => {
    expect(canonicalizeLabel("Some Unique Label (extra info) - detail")).toBe("some unique label");
    expect(canonicalizeLabel("Resume file")).toBe("resume file");
  });
});
