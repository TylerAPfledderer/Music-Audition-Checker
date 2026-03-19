import { describe, it, expect } from "vitest";
import { encodeSubjectRfc2047, buildEmailRaw } from "../src/email";
import { shouldNotify, normalizeItemLabel } from "../src/check-auditions";

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

  // Label-bounce loop prevention: after notifying, notifiedRelevantItems is updated
  // to the union of old + new items. The tests below validate that once both label
  // variants are in the union, shouldNotify correctly returns false for either.
  it("returns false when a synonym label is present in notifiedItems union (prevents label-bounce)", () => {
    // Simulate: Claude said "Sub list for all instruments" on run 1 (notified),
    // then "Substitute list for all instruments" on run 2 (false positive fired),
    // so notifiedItems now holds the union of both.
    const unionNotified = ["Sub list for all instruments", "Substitute list for all instruments"];
    // Run 3: Claude returns the original label — should NOT re-notify.
    expect(shouldNotify(true, true, ["Sub list for all instruments"], unionNotified)).toBe(false);
    // Run 4: Claude returns the synonym label — should NOT re-notify.
    expect(shouldNotify(true, true, ["Substitute list for all instruments"], unionNotified)).toBe(false);
  });

  it("still notifies when a genuinely new item appears alongside a previously-notified synonym", () => {
    const unionNotified = ["Sub list for all instruments", "Substitute list for all instruments"];
    // A new Principal Trumpet audition was added — not in union → should notify.
    expect(
      shouldNotify(
        true,
        true,
        ["Substitute list for all instruments", "Principal Trumpet"],
        unionNotified
      )
    ).toBe(true);
  });

  // Normalized matching: parentheticals and " - suffix" qualifiers should not cause re-notification
  it("does not re-notify when Claude adds a parenthetical to a previously-notified label", () => {
    // Stored: "Sub list for all instruments"
    // Claude returns: "Sub list for all instruments (contact operations manager)"
    expect(
      shouldNotify(
        true,
        true,
        ["Sub list for all instruments (contact operations manager)"],
        ["Sub list for all instruments"]
      )
    ).toBe(false);
  });

  it("does not re-notify when Claude adds a dash-suffix qualifier to a previously-notified label", () => {
    // Stored: "Substitute musician positions"
    // Claude returns: "Substitute musician positions - general orchestral"
    expect(
      shouldNotify(
        true,
        true,
        ["Substitute musician positions - general orchestral"],
        ["Substitute musician positions (ongoing applications accepted)"]
      )
    ).toBe(false);
  });

  it("still notifies for a genuinely different item despite normalization", () => {
    // "Principal Trumpet" does not normalize to the same string as "Sub list for all instruments"
    expect(
      shouldNotify(true, true, ["Principal Trumpet"], ["Sub list for all instruments"])
    ).toBe(true);
  });
});

describe("normalizeItemLabel", () => {
  it("lowercases the label", () => {
    expect(normalizeItemLabel("Principal Trumpet")).toBe("principal trumpet");
  });

  it("strips parenthetical remarks", () => {
    expect(normalizeItemLabel("Sub list for all instruments (contact operations manager)")).toBe(
      "sub list for all instruments"
    );
  });

  it("strips dash-suffix qualifiers", () => {
    expect(normalizeItemLabel("Substitute musician positions - general orchestral")).toBe(
      "substitute musician positions"
    );
  });

  it("strips both parenthetical and dash-suffix", () => {
    expect(normalizeItemLabel("Open positions (all instruments) - ongoing")).toBe(
      "open positions"
    );
  });

  it("leaves a plain label unchanged (modulo case)", () => {
    expect(normalizeItemLabel("Second Trumpet")).toBe("second trumpet");
  });
});
