import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from "@google/generative-ai";

/** Minimal LLM client interface — one method, easy to mock. */
export interface LlmClient {
  generate(prompt: string, maxTokens: number): Promise<string>;
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

const DEFAULT_MODEL = "gemini-2.5-flash";

/** Creates a Gemini-backed LlmClient. */
export function createGeminiClient(apiKey: string, modelName?: string): LlmClient {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName || DEFAULT_MODEL });

  return {
    async generate(prompt: string, maxTokens: number): Promise<string> {
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
          return result.response.text();
        } catch (err) {
          if (
            err instanceof GoogleGenerativeAIFetchError &&
            err.status === 429 &&
            attempt < MAX_RETRIES
          ) {
            const retryMs = parseRetryDelay(err.errorDetails) || BASE_DELAY_MS * 2 ** attempt;
            console.log(
              `  \u23F3 Gemini 429 \u2014 retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(retryMs / 1000)}s...`
            );
            await new Promise((r) => setTimeout(r, retryMs));
            continue;
          }
          throw err;
        }
      }
    },
  };
}
