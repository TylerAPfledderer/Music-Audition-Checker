/**
 * Tests for the hardened Gmail send in sendEmail. The send now mints an access token via
 * the native-https OAuth helper and retries the whole send on transient transport drops
 * (e.g. "Premature close"), so a single dropped connection no longer silently discards a
 * notification. Permanent credential errors (invalid_grant) fail fast.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Hoisted so the vi.mock factories (also hoisted) can reference these mocks safely.
const { messagesSend, messagesInsert, labelsList, labelsCreate, setCredentials, exchangeToken } =
  vi.hoisted(() => ({
    messagesSend: vi.fn(),
    messagesInsert: vi.fn(),
    labelsList: vi.fn(),
    labelsCreate: vi.fn(),
    setCredentials: vi.fn(),
    exchangeToken: vi.fn(),
  }));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = setCredentials;
      },
    },
    gmail: () => ({
      users: {
        messages: { send: messagesSend, insert: messagesInsert },
        labels: { list: labelsList, create: labelsCreate },
      },
    }),
  },
}));

// Keep the real withOAuthRetry (so retry/backoff is exercised) but stub the token fetch.
vi.mock("../src/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/oauth")>();
  return { ...actual, exchangeRefreshTokenForAccessToken: exchangeToken };
});

import { sendEmail, CrawlResult } from "../src/email";

const FINDING: CrawlResult = {
  source: "standard",
  name: "Test Orchestra",
  url: "https://example.com/auditions",
  summary: "Trumpet audition",
  relevantItems: ["Principal Trumpet"],
  futureDates: [],
};

const REQUIRED_ENV = {
  GMAIL_CLIENT_ID: "id",
  GMAIL_CLIENT_SECRET: "secret",
  GMAIL_REFRESH_TOKEN: "refresh",
  GMAIL_USER: "user@example.com",
  NOTIFY_EMAIL: "notify@example.com",
};

describe("sendEmail — Gmail send hardening", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, REQUIRED_ENV);
    delete process.env.GMAIL_LABEL_NAME;
    exchangeToken.mockResolvedValue("access-token-abc");
    // Instant backoff.
    vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("sends via messages.send and sets a natively-fetched access token", async () => {
    messagesSend.mockResolvedValue({});
    await expect(sendEmail([FINDING])).resolves.toBeUndefined();
    expect(exchangeToken).toHaveBeenCalledTimes(1);
    expect(setCredentials).toHaveBeenCalledWith({ access_token: "access-token-abc" });
    expect(messagesSend).toHaveBeenCalledTimes(1);
  });

  it("retries the send on a transient 'Premature close' and then succeeds", async () => {
    messagesSend
      .mockRejectedValueOnce(new Error("Invalid response body ... Premature close"))
      .mockResolvedValue({});
    await expect(sendEmail([FINDING])).resolves.toBeUndefined();
    // Two send attempts, each preceded by a fresh token fetch.
    expect(messagesSend).toHaveBeenCalledTimes(2);
    expect(exchangeToken).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on persistent transient failures", async () => {
    messagesSend.mockRejectedValue(new Error("Premature close"));
    await expect(sendEmail([FINDING])).rejects.toThrow(/Premature close/);
    // Initial + 3 retries = 4 attempts.
    expect(messagesSend).toHaveBeenCalledTimes(4);
  });

  it("fails fast (no retry) when the token exchange returns invalid_grant", async () => {
    exchangeToken.mockRejectedValue(new Error("invalid_grant: Token has been expired or revoked."));
    await expect(sendEmail([FINDING])).rejects.toThrow(/invalid_grant/);
    expect(exchangeToken).toHaveBeenCalledTimes(1);
    expect(messagesSend).not.toHaveBeenCalled();
  });

  it("uses messages.insert with a label when GMAIL_LABEL_NAME is set", async () => {
    process.env.GMAIL_LABEL_NAME = "Auditions";
    labelsList.mockResolvedValue({ data: { labels: [{ name: "Auditions", id: "Label_1" }] } });
    messagesInsert.mockResolvedValue({});
    await expect(sendEmail([FINDING])).resolves.toBeUndefined();
    expect(messagesInsert).toHaveBeenCalledTimes(1);
    expect(messagesSend).not.toHaveBeenCalled();
  });
});
