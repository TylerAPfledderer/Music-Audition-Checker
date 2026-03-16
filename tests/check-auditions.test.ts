import { describe, it, expect } from "vitest";
import { encodeSubjectRfc2047, buildEmailRaw } from "../src/email";
import { shouldNotify } from "../src/check-auditions";

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
    expect(shouldNotify(true, true, ["Principal Trumpet"], ["Principal Trumpet"])).toBe(false);
  });

  it("returns true when still relevant and a new trumpet item was added (bug fix case)", () => {
    expect(
      shouldNotify(true, true, ["Principal Trumpet", "Second Trumpet"], ["Principal Trumpet"])
    ).toBe(true);
  });

  it("returns false when still relevant but only non-trumpet content changed (same relevant items)", () => {
    // Claude re-analyzed after a non-trumpet audition was added, but relevantItems is unchanged
    expect(shouldNotify(true, true, ["Principal Trumpet"], ["Principal Trumpet"])).toBe(false);
  });

  it("returns true when still relevant but notifiedItems is empty (never notified before)", () => {
    expect(shouldNotify(true, true, ["Principal Trumpet"], [])).toBe(true);
  });

  it("returns true on rising edge when notifiedItems is empty (new page, first notification)", () => {
    expect(shouldNotify(true, false, ["Principal Trumpet"], [])).toBe(true);
  });
});
