import Anthropic from "@anthropic-ai/sdk";

import { AuditionAnalysis } from "./email";

// ─── Claude Analysis ──────────────────────────────────────────────────────────

/**
 * LLM-as-classifier for standard single-page sources. Claude is given the full
 * relevance criteria inline so the classification logic lives in the prompt, not
 * in fragile HTML parsing or keyword matching. The structured JSON contract in the
 * prompt ensures the output is machine-readable without a schema validation library.
 * Regex extraction (`/\{[\s\S]*\}/`) is the fallback in case Claude wraps the JSON
 * in prose despite instructions — a known LLM output reliability issue.
 */
export async function analyzeWithClaude(
  client: Anthropic,
  pageText: string,
  pageUrl: string,
  pageName: string
): Promise<AuditionAnalysis> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `Classify this orchestra page for trumpet audition relevance.

RELEVANT: audition/position with a future date (after ${today}) that involves trumpet, brass, or an open orchestral audition where trumpet would qualify (e.g. a sub list open to any instrument).
NOT RELEVANT: past auditions, admin/education-only roles, instruments that exclude brass.

Return JSON only — no prose, no markdown fences:
{
  "isRelevant": boolean,
  "instrument": string[],
  "deadline": string | null,
  "location": string,
  "confidenceScore": number,
  "summary": string | null,
  "futureDates": string[],
  "relevantItems": string[]
}

- instrument: trumpet/brass-specific position titles only (e.g. "Principal Trumpet", "Section Trumpet", "Sub List"); empty array if none
- deadline: earliest audition/application deadline string, null if none
- location: city and state of the orchestra, empty string if unknown
- confidenceScore: 0.0–1.0 confidence in isRelevant verdict
- summary: 2-3 sentence plain-English summary if isRelevant, null otherwise
- futureDates: all relevant future date strings found on the page
- relevantItems: trumpet/brass position titles matching the relevance criteria

Page: ${pageName} (${pageUrl})
Today: ${today}

Content (first 8000 chars):
${pageText.slice(0, 8000)}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found");
    const parsed = JSON.parse(match[0]);
    return {
      hasRelevantAuditions: parsed.isRelevant ?? false,
      instrument: parsed.instrument ?? [],
      deadline: parsed.deadline ?? null,
      location: parsed.location ?? "",
      confidenceScore: parsed.confidenceScore ?? 0,
      summary: parsed.summary ?? null,
      futureDates: parsed.futureDates ?? [],
      relevantItems: parsed.relevantItems ?? [],
    };
  } catch {
    console.warn("  Could not parse Claude response as JSON:", raw.slice(0, 200));
    return {
      hasRelevantAuditions: false,
      instrument: [],
      deadline: null,
      location: "",
      confidenceScore: 0,
      summary: null,
      futureDates: [],
      relevantItems: [],
    };
  }
}

export async function probeIsAuditionPage(
  client: Anthropic,
  pageText: string,
  url: string,
  name: string
): Promise<{ isAuditionPage: boolean; reason: string }> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `Does this page appear to be an orchestra/symphony audition or employment/careers page?
Answer with JSON only: { "isAuditionPage": boolean, "reason": string }
Reason should be one sentence.

URL: ${url}
Page name: ${name}
Content sample (first 2000 chars):
${pageText.slice(0, 2000)}`,
      },
    ],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found");
    return JSON.parse(match[0]);
  } catch {
    return { isAuditionPage: false, reason: "Could not parse Claude response" };
  }
}
