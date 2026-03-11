import { describe, it, expect } from "vitest";
import { stripHtml, contentHash, normalizeForHash, MIN_CONTENT_LENGTH } from "../src/scraper";

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
