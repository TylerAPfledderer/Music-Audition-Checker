import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleGenerativeAIFetchError } from "@google/generative-ai";
import { createGeminiClient, DailyQuotaExhaustedError } from "../src/llm.ts";

// Mock the @google/generative-ai module while keeping the real error classes
const mockGenerateContent = vi.fn();

vi.mock("@google/generative-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/generative-ai")>();

  return {
    ...actual,
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return { generateContent: mockGenerateContent };
      }
    },
  };
});

function makeResponse(text: string) {
  return {
    response: {
      text: () => text,
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
  };
}

describe("createGeminiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns response text on success", async () => {
    mockGenerateContent.mockResolvedValueOnce(makeResponse('{"ok":true}'));

    const client = createGeminiClient("fake-key");
    const result = await client.generate("test prompt", 100);

    expect(result).toBe('{"ok":true}');
  });

  it("falls back to another model on 503", async () => {
    mockGenerateContent
      .mockRejectedValueOnce(new GoogleGenerativeAIFetchError("overloaded", 503))
      .mockResolvedValueOnce(makeResponse('{"fallback":true}'));

    const client = createGeminiClient("fake-key");
    const result = await client.generate("test prompt", 100);

    expect(result).toBe('{"fallback":true}');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it("throws 503 when primary is already the fallback model (no fallback available)", async () => {
    mockGenerateContent.mockRejectedValueOnce(
      new GoogleGenerativeAIFetchError("overloaded", 503)
    );

    const client = createGeminiClient("fake-key", "gemini-2.0-flash");
    await expect(client.generate("test prompt", 100)).rejects.toThrow(
      GoogleGenerativeAIFetchError
    );
  });

  it("throws 503 when both primary and fallback are overloaded", async () => {
    mockGenerateContent
      .mockRejectedValueOnce(new GoogleGenerativeAIFetchError("overloaded", 503))
      .mockRejectedValueOnce(new GoogleGenerativeAIFetchError("still overloaded", 503));

    const client = createGeminiClient("fake-key");
    await expect(client.generate("test prompt", 100)).rejects.toThrow(
      GoogleGenerativeAIFetchError
    );
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it("retries 429 with backoff (does not fall back to different model)", async () => {
    vi.useFakeTimers();

    mockGenerateContent
      .mockRejectedValueOnce(new GoogleGenerativeAIFetchError("rate limited", 429))
      .mockResolvedValueOnce(makeResponse('{"retried":true}'));

    const client = createGeminiClient("fake-key");
    const resultPromise = client.generate("test prompt", 100);

    await vi.advanceTimersByTimeAsync(60_000);

    const result = await resultPromise;
    expect(result).toBe('{"retried":true}');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("throws DailyQuotaExhaustedError on daily quota 429", async () => {
    mockGenerateContent.mockRejectedValueOnce(
      new GoogleGenerativeAIFetchError("quota", 429, "Too Many Requests", [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }],
        },
      ])
    );

    const client = createGeminiClient("fake-key");
    await expect(client.generate("test prompt", 100)).rejects.toThrow(
      DailyQuotaExhaustedError
    );
  });

  it("throws non-retryable errors immediately", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("network failure"));

    const client = createGeminiClient("fake-key");
    await expect(client.generate("test prompt", 100)).rejects.toThrow("network failure");
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });
});
