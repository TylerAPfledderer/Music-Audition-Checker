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

  const prompt = `You are helping a professional trumpet player monitor symphony orchestra audition pages.

Today's date: ${today}
Page: ${pageName} (${pageUrl})

Analyze the following page content and determine if there are any RELEVANT audition opportunities.

RELEVANT means ALL of the following must be true:
1. The audition/position has a future date (after ${today}) or is currently open with no closing date yet
2. AND at least one of:
   a. It specifically mentions trumpet (any part: principal, associate, section, extra, sub)
   b. It is for a sub list open to any instrument (and trumpet would reasonably qualify)
   c. It is a general orchestral audition where brass/trumpet players would audition

NOT relevant: past auditions, non-orchestral positions (admin, education-only), auditions for instruments that exclude brass.

Return a JSON object with this exact shape:
{
  "hasRelevantAuditions": boolean,
  "summary": string | null,
  "futureDates": string[],
  "relevantItems": string[]
}

- summary: 2-3 sentence plain-English summary of what was found (null if nothing relevant)
- futureDates: list of relevant future date strings found on the page
- relevantItems: list of specific audition/position titles that are relevant

Page content (truncated to first 8000 chars):
${pageText.slice(0, 8000)}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
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
    return JSON.parse(match[0]) as AuditionAnalysis;
  } catch {
    console.warn("  Could not parse Claude response as JSON:", raw.slice(0, 200));
    return {
      hasRelevantAuditions: false,
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
    model: "claude-sonnet-4-20250514",
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
