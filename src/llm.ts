import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from "@google/generative-ai";

/** Minimal LLM client interface — one method, easy to mock. */
export interface LlmClient {
  generate(prompt: string, maxTokens: number): Promise<string>;
}

/** Thrown when the Gemini daily quota is exhausted — retries cannot help. */
export class DailyQuotaExhaustedError extends Error {
  constructor() {
    super("Gemini daily quota exhausted \u2014 aborting run");
    this.name = "DailyQuotaExhaustedError";
  }
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 60_000;

/** Extract retryDelay (in ms) from Gemini errorDetails if present. */
function parseRetryDelay(errorDetails?: { [key: string]: unknown }[]): number | null {
  if (!errorDetails) return null;
  const retryInfo = errorDetails.find(
    (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
  );
  if (!retryInfo?.retryDelay) return null;
  const match = String(retryInfo.retryDelay).match(/^(\d+)/);
  return match ? parseInt(match[1], 10) * 1000 : null;
}

/** Check if the 429 is a daily quota exhaustion (unrecoverable within this run). */
function isDailyQuotaExhausted(errorDetails?: { [key: string]: unknown }[]): boolean {
  if (!errorDetails) return false;
  const quotaFailure = errorDetails.find(
    (d) => d["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
  );
  if (!quotaFailure) return false;
  const violations = quotaFailure.violations as { quotaId?: string }[] | undefined;
  return violations?.some((v) => v.quotaId?.includes("PerDay")) ?? false;
}

const DEFAULT_MODEL = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.0-flash";

/** Creates a Gemini-backed LlmClient. */
export function createGeminiClient(apiKey: string, modelName?: string): LlmClient {
  const genAI = new GoogleGenerativeAI(apiKey);
  const primaryName = modelName || DEFAULT_MODEL;
  const fallbackName = primaryName !== FALLBACK_MODEL ? FALLBACK_MODEL : null;

  return {
    async generate(prompt: string, maxTokens: number): Promise<string> {
      const modelsToTry = [primaryName, ...(fallbackName ? [fallbackName] : [])];

      for (let m = 0; m < modelsToTry.length; m++) {
        const currentName = modelsToTry[m];
        const model = genAI.getGenerativeModel({ model: currentName });
        const hasNext = m < modelsToTry.length - 1;

        for (let attempt = 0; ; attempt++) {
          try {
            // thinkingConfig is supported by the REST API inside generationConfig
            // but not typed in @google/generative-ai v0.24 — the SDK passes the
            // object through to the API via JSON.stringify, so the cast is safe.
            const result = await model.generateContent({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                maxOutputTokens: maxTokens,
                temperature: 0,
                responseMimeType: "application/json",
                thinkingConfig: { thinkingBudget: 0 },
              } as Parameters<typeof model.generateContent>[0] extends { generationConfig?: infer G } ? G : never,
            });
            const usage = result.response.usageMetadata;
            if (usage) {
              console.log(
                `  [tokens] in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} total=${usage.totalTokenCount ?? 0}`
              );
            }
            return result.response.text();
          } catch (err) {
            if (
              err instanceof GoogleGenerativeAIFetchError &&
              err.status === 429
            ) {
              if (isDailyQuotaExhausted(err.errorDetails)) {
                throw new DailyQuotaExhaustedError();
              }
              if (attempt < MAX_RETRIES) {
                const retryMs = parseRetryDelay(err.errorDetails) || BASE_DELAY_MS * 2 ** attempt;
                console.log(
                  `  \u23F3 Gemini 429 \u2014 retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(retryMs / 1000)}s...`
                );
                await new Promise((r) => setTimeout(r, retryMs));
                continue;
              }
            }
            if (
              err instanceof GoogleGenerativeAIFetchError &&
              err.status === 503 &&
              hasNext
            ) {
              console.log(
                `  \u26A0\uFE0F ${currentName} overloaded (503) \u2014 falling back to ${modelsToTry[m + 1]}...`
              );
              break;
            }
            throw err;
          }
        }
      }
      throw new Error("All Gemini models unavailable");
    },
  };
}
