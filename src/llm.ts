import { GoogleGenerativeAI } from "@google/generative-ai";

/** Minimal LLM client interface — one method, easy to mock. */
export interface LlmClient {
  generate(prompt: string, maxTokens: number): Promise<string>;
}

/** Creates a Gemini-backed LlmClient. */
export function createGeminiClient(apiKey: string): LlmClient {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  return {
    async generate(prompt: string, maxTokens: number): Promise<string> {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0,
          responseMimeType: "application/json",
        },
      });
      return result.response.text();
    },
  };
}
