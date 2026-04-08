import { describe, it, expect, vi, afterEach } from "vitest";
import { stripHtml, contentHash, normalizeForHash, extractAuditionSignals, extractAuditionLinks, MIN_CONTENT_LENGTH, passesBrassKeywordGate } from "../src/scraper";

describe("MIN_CONTENT_LENGTH", () => {
  it("is 500", () => {
    expect(MIN_CONTENT_LENGTH).toBe(500);
  });
});

describe("stripHtml", () => {
  it("removes script tags and their content", () => {
    const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    expect(stripHtml(html)).toBe("Hello World");
  });

  it("removes style tags and their content", () => {
    const html = "<p>Hello</p><style>body { color: red; }</style><p>World</p>";
    expect(stripHtml(html)).toBe("Hello World");
  });

  it("removes generic HTML tags leaving text content", () => {
    const html = "<h1>Title</h1><p>Paragraph <strong>bold</strong> text.</p>";
    expect(stripHtml(html)).toBe("Title Paragraph bold text.");
  });

  it("decodes &amp; entity", () => {
    expect(stripHtml("<p>Bread &amp; Butter</p>")).toBe("Bread & Butter");
  });

  it("decodes &lt; and &gt; entities", () => {
    expect(stripHtml("<p>1 &lt; 2 &gt; 0</p>")).toBe("1 < 2 > 0");
  });

  it("decodes &nbsp; as a regular space", () => {
    expect(stripHtml("<p>Hello&nbsp;World</p>")).toBe("Hello World");
  });

  it("collapses multiple whitespace into a single space", () => {
    expect(stripHtml("<p>too   many    spaces</p>")).toBe("too many spaces");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripHtml("  <p>Hello</p>  ")).toBe("Hello");
  });

  it("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });

  it("returns empty string for input that is only tags", () => {
    expect(stripHtml("<div><span></span></div>")).toBe("");
  });

  it("removes multiline script blocks", () => {
    const html = "<p>Before</p><script>\nvar x = 1;\nconsole.log(x);\n</script><p>After</p>";
    expect(stripHtml(html)).toBe("Before After");
  });
});

describe("contentHash", () => {
  it("returns a 16-character string", () => {
    expect(contentHash("hello")).toHaveLength(16);
  });

  it("returns only hex characters", () => {
    expect(contentHash("test input")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns the same hash for identical input", () => {
    const input = "symphony orchestra auditions";
    expect(contentHash(input)).toBe(contentHash(input));
  });

  it("returns different hashes for different input", () => {
    expect(contentHash("page A content")).not.toBe(contentHash("page B content"));
  });

  it("is deterministic across multiple calls", () => {
    const hash1 = contentHash("deterministic test");
    const hash2 = contentHash("deterministic test");
    const hash3 = contentHash("deterministic test");
    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it("handles empty string input", () => {
    const hash = contentHash("");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("extractAuditionSignals", () => {
  it("returns empty string for navigation/footer-only text with no audition keywords", () => {
    const navText = "Home About Concerts Season Support Contact Donate Login";
    expect(extractAuditionSignals(navText)).toBe("");
  });

  it("retains a sentence containing the word 'substitute'", () => {
    const text = "We are accepting musicians for our substitute list.";
    expect(extractAuditionSignals(text)).toBe(text);
  });

  it("retains a sentence containing the word 'audition'", () => {
    const text = "Auditions are now open for all positions.";
    expect(extractAuditionSignals(text)).toBe(text);
  });

  it("retains a sentence containing the expanded keyword 'trumpet'", () => {
    const text = "The orchestra seeks a principal trumpet player.";
    expect(extractAuditionSignals(text)).toBe(text);
  });

  it("retains a sentence containing the expanded keyword 'principal'", () => {
    const text = "Applications for the principal chair close May 1.";
    expect(extractAuditionSignals(text)).toBe(text);
  });

  it("retains a sentence containing the keyword 'hiring'", () => {
    const text = "The orchestra is hiring for the upcoming season.";
    expect(extractAuditionSignals(text)).toBe(text);
  });

  it("filters out orchestra/symphony/musician sentences that don't contain audition keywords", () => {
    // These broad orchestral terms were removed from AUDITION_SIGNALS because they
    // appear in news, bios, and event listings — causing hash churn on rotating content.
    expect(extractAuditionSignals("The Fayetteville Symphony performed Beethoven's 9th.")).toBe("");
    expect(extractAuditionSignals("Featured musician: Jane Doe, violin.")).toBe("");
    expect(extractAuditionSignals("The orchestra announced its 2026-27 season.")).toBe("");
  });

  it("filters out short non-audition phrases that previously caused hash churn", () => {
    // These are the kinds of nav/UI fragments that the old <120 char fallback
    // was inadvertently including, causing spurious hash changes.
    const noiseText = "View all events Follow us Copyright 2026";
    expect(extractAuditionSignals(noiseText)).toBe("");
  });

  it("keeps only audition sentences from mixed page content", () => {
    // Sentence split happens on '. ' followed by capital
    const mixed =
      "Welcome to our website. We are thrilled to announce our 2026 season. " +
      "Auditions for trumpet are open through May 15. Tickets are on sale now. " +
      "We accept substitute musicians on a rolling basis.";
    const result = extractAuditionSignals(mixed);
    expect(result).toContain("Auditions for trumpet");
    expect(result).toContain("substitute musicians");
    expect(result).not.toContain("thrilled to announce");
    expect(result).not.toContain("Tickets are on sale");
  });

  it("returns empty string for empty input", () => {
    expect(extractAuditionSignals("")).toBe("");
  });

  it("produces a stable hash for content with only non-audition text changing", () => {
    const auditContent = "Submit your resume to apply for the trumpet position.";
    const withNoise1 = auditContent + " Home About Donate";
    const withNoise2 = auditContent + " Home About Donate Join Us";
    // Both should produce the same signals output (noise filtered out)
    expect(extractAuditionSignals(withNoise1)).toBe(extractAuditionSignals(withNoise2));
  });
});

describe("normalizeForHash", () => {
  it("strips relative timestamps", () => {
    expect(normalizeForHash("Posted 3 hours ago on our site")).toBe("Posted on our site");
    expect(normalizeForHash("Updated 2 days ago")).toBe("Updated");
    expect(normalizeForHash("Submitted 1 minute ago")).toBe("Submitted");
  });

  it("strips 'just now' and 'yesterday'", () => {
    expect(normalizeForHash("Posted just now")).toBe("Posted");
    expect(normalizeForHash("Last seen yesterday")).toBe("Last seen");
  });

  it("strips 'last updated/modified/checked' lines", () => {
    expect(normalizeForHash("Last updated: Monday March 9")).toBe("");
    expect(normalizeForHash("Last modified by admin")).toBe("");
    expect(normalizeForHash("Last checked 2026-03-09")).toBe("");
  });

  it("preserves audition-relevant content", () => {
    const text = "Trumpet audition August 12. Submit resume by July 1.";
    expect(normalizeForHash(text)).toBe(text);
  });

  it("collapses whitespace after stripping", () => {
    const result = normalizeForHash("Open positions  3 hours ago  apply now");
    expect(result).toBe("Open positions apply now");
  });
});

describe("passesBrassKeywordGate", () => {
  it("returns true for 'trumpet'", () => {
    expect(passesBrassKeywordGate("Principal Trumpet audition")).toBe(true);
  });
  it("returns true for 'cornet'", () => {
    expect(passesBrassKeywordGate("Cornet position available")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(passesBrassKeywordGate("TRUMPET AUDITION")).toBe(true);
  });
  it("returns false for irrelevant text", () => {
    expect(passesBrassKeywordGate("Violin solo competition")).toBe(false);
  });
  it("returns false when 'faculty' is present even with 'trumpet'", () => {
    expect(passesBrassKeywordGate("Trumpet faculty position")).toBe(false);
  });
  it("returns false when 'instructor' is present even with 'trumpet'", () => {
    expect(passesBrassKeywordGate("Trumpet instructor wanted")).toBe(false);
  });
});

// ─── extractAuditionLinks ─────────────────────────────────────────────────────

describe("extractAuditionLinks", () => {
  const BASE = "https://orchestra.example.com/auditions";

  it("returns empty array when no audition keywords in HTML links", () => {
    const html = '<a href="/about">About Us</a> <a href="/concerts">Concerts</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([]);
  });

  it("extracts a link when anchor text contains 'Auditions'", () => {
    const html = '<a href="/auditions/winds">Winds Auditions</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([
      "https://orchestra.example.com/auditions/winds",
    ]);
  });

  it("extracts a link when href path contains 'audition'", () => {
    const html = '<a href="/audition/trumpet">Apply here</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([
      "https://orchestra.example.com/audition/trumpet",
    ]);
  });

  it("extracts a link when anchor text contains 'position'", () => {
    const html = '<a href="/section/open">Principal Violin Position Available</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([
      "https://orchestra.example.com/section/open",
    ]);
  });

  it("excludes external links (different hostname)", () => {
    const html = '<a href="https://playbill.com/job/trumpet">Trumpet Audition</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([]);
  });

  it("excludes self-links (same pathname as baseUrl)", () => {
    const html = '<a href="/auditions">Back to Auditions</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([]);
  });

  it("excludes .pdf links", () => {
    const html = '<a href="/docs/audition-requirements.pdf">Audition Requirements</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([]);
  });

  it("excludes image and media file links", () => {
    const html = [
      '<a href="/img/audition-poster.jpg">Audition Poster</a>',
      '<a href="/media/audition-recording.mp4">Audition Recording</a>',
    ].join(" ");
    expect(extractAuditionLinks(html, BASE)).toEqual([]);
  });

  it("caps results at 3 links", () => {
    const html = [
      '<a href="/audition/1">Audition 1</a>',
      '<a href="/audition/2">Audition 2</a>',
      '<a href="/audition/3">Audition 3</a>',
      '<a href="/audition/4">Audition 4</a>',
    ].join(" ");
    const result = extractAuditionLinks(html, BASE);
    expect(result).toHaveLength(3);
  });

  it("deduplicates links that appear multiple times in HTML", () => {
    const html = [
      '<a href="/audition/winds">Winds Audition</a>',
      '<a href="/audition/winds">Winds Audition (again)</a>',
    ].join(" ");
    expect(extractAuditionLinks(html, BASE)).toHaveLength(1);
  });

  it("normalizes relative hrefs to absolute URLs using baseUrl", () => {
    const html = '<a href="/careers/opening">Career Opening</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([
      "https://orchestra.example.com/careers/opening",
    ]);
  });

  it("uses firecrawlLinks when provided, filtered by keyword", () => {
    const firecrawlLinks = [
      "https://orchestra.example.com/audition/trumpet",
      "https://orchestra.example.com/about",
      "https://orchestra.example.com/jobs/principal-bass",
    ];
    const result = extractAuditionLinks("", BASE, firecrawlLinks);
    expect(result).toEqual([
      "https://orchestra.example.com/audition/trumpet",
      "https://orchestra.example.com/jobs/principal-bass",
    ]);
  });

  it("ignores HTML when firecrawlLinks is provided", () => {
    const html = '<a href="/audition/winds">Winds Audition</a>';
    expect(extractAuditionLinks(html, BASE, [])).toEqual([]);
  });

  it("strips query strings and fragments when normalizing URLs", () => {
    const html = '<a href="/auditions/winds?ref=homepage#details">Winds Auditions</a>';
    expect(extractAuditionLinks(html, BASE)).toEqual([
      "https://orchestra.example.com/auditions/winds",
    ]);
  });
});

// ─── fetchWithFirecrawl — key gate ───────────────────────────────────────────

describe("fetchWithFirecrawl — key gate", () => {
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
});
