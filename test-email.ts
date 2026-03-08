/**
 * test-email.ts
 *
 * Verifies that email subject lines and body HTML are formatted correctly,
 * with no encoding issues for emojis or special characters (e.g. em dash).
 *
 * Run with: npm run test:email
 * No env vars, network requests, or Claude API calls required.
 */

import assert from "assert";
import { buildEmailRaw, encodeSubjectRfc2047 } from "./check-auditions";

// ─── Hard-coded test inputs ────────────────────────────────────────────────────

const SUBJECT = "🎺 1 new trumpet audition found — Saturday, March 7, 2026";

const HTML_BODY = `
<h2>🎺 Trumpet Audition Alert — Saturday, March 7, 2026</h2>
<p>The following symphony pages have <strong>new relevant audition opportunities</strong>:</p>
<hr/>
<h3><a href="https://example.com/auditions">Example Symphony</a></h3>
<p>Found a trumpet audition.</p>
<p><strong>Positions/Auditions:</strong></p><ul><li>Principal Trumpet</li></ul>
<p><strong>Dates:</strong> April 1, 2026</p>
<p><a href="https://example.com/auditions">→ View page</a></p><hr/>
<h3 style="margin-top:24px;">🎭 Playbill Job Board</h3>
<p>The following Playbill listings mention trumpet:</p>
<div style="margin-bottom:16px;padding:12px;border-left:4px solid #c0392b;">
<h4 style="margin:0 0 4px;"><a href="https://playbill.com/job/123">Trumpet Player Wanted</a></h4>
<p style="margin:0 0 4px;color:#555;"><em>Test Orchestra</em></p>
<p style="margin:0;"><a href="https://playbill.com/job/123">→ View listing on Playbill</a></p>
</div><hr/>
<p style="color:#888;font-size:12px;">Sent by <a href="https://github.com/TylerAPfledderer/Music-Audition-Checker">audition-checker</a></p>
`.trim();

// ─── Build the MIME message and decode it back ─────────────────────────────────

const raw = buildEmailRaw({
  from: "Audition Checker <test@example.com>",
  to: "notify@example.com",
  subject: SUBJECT,
  html: HTML_BODY,
});

// base64url → base64 → decoded MIME text
const mimeText = Buffer.from(
  raw.replace(/-/g, "+").replace(/_/g, "/"),
  "base64"
).toString("utf-8");

// ─── Tests ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}`);
    console.error(`    ${message}`);
    failed++;
  }
}

console.log("\nSubject encoding");

test("uses RFC 2047 encoded-word format", () => {
  const match = mimeText.match(/^Subject: (.+)$/m);
  assert.ok(match, "Subject header not found");
  assert.match(
    match![1],
    /^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/,
    `Subject header is not RFC 2047 encoded: ${match![1]}`
  );
});

test("decoded subject contains trumpet emoji", () => {
  const encoded = encodeSubjectRfc2047(SUBJECT);
  const base64Part = encoded.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
  const decoded = Buffer.from(base64Part, "base64").toString("utf-8");
  assert.ok(decoded.includes("🎺"), `Missing 🎺 in decoded subject: ${decoded}`);
});

test("decoded subject contains em dash", () => {
  const encoded = encodeSubjectRfc2047(SUBJECT);
  const base64Part = encoded.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
  const decoded = Buffer.from(base64Part, "base64").toString("utf-8");
  assert.ok(decoded.includes("—"), `Missing em dash in decoded subject: ${decoded}`);
});

test("decoded subject matches original exactly", () => {
  const encoded = encodeSubjectRfc2047(SUBJECT);
  const base64Part = encoded.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
  const decoded = Buffer.from(base64Part, "base64").toString("utf-8");
  assert.strictEqual(decoded, SUBJECT);
});

console.log("\nBody content");

test("h2 heading contains trumpet emoji and em dash", () => {
  assert.ok(
    mimeText.includes("<h2>🎺 Trumpet Audition Alert — Saturday, March 7, 2026</h2>"),
    "h2 heading not found or incorrectly formatted"
  );
});

test("orchestra name link is present", () => {
  assert.ok(
    mimeText.includes('<a href="https://example.com/auditions">Example Symphony</a>'),
    "Orchestra name link missing"
  );
});

test("Playbill section heading is present", () => {
  assert.ok(
    mimeText.includes("🎭 Playbill Job Board"),
    "Playbill section heading missing"
  );
});

test("Playbill listing title and org are present", () => {
  assert.ok(
    mimeText.includes("Trumpet Player Wanted"),
    "Playbill listing title missing"
  );
  assert.ok(mimeText.includes("Test Orchestra"), "Playbill org missing");
});

test("Playbill listing URL is present", () => {
  assert.ok(
    mimeText.includes("https://playbill.com/job/123"),
    "Playbill listing URL missing"
  );
});

test("footer GitHub link is present", () => {
  assert.ok(
    mimeText.includes(
      '<a href="https://github.com/TylerAPfledderer/Music-Audition-Checker">audition-checker</a>'
    ),
    "Footer GitHub link missing"
  );
});

test("probe failures section is absent when not provided", () => {
  assert.ok(
    !mimeText.includes("⚠️ URL Issues Detected"),
    "Probe failures section should not be present"
  );
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
