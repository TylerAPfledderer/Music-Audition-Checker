/**
 * Tests for the OAuth2 token-exchange retry logic in preflightSecrets.
 * Transient transport failures (e.g. "Premature close") should be retried with
 * backoff, while genuine credential rejections (invalid_grant) fail fast.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const getAccessToken = vi.fn();
const setCredentials = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = setCredentials;
        getAccessToken = getAccessToken;
      },
    },
  },
}));

import { preflightSecrets } from "../src/preflight";

const REQUIRED_ENV = {
  GEMINI_API_KEY: "g",
  GMAIL_CLIENT_ID: "id",
  GMAIL_CLIENT_SECRET: "secret",
  GMAIL_REFRESH_TOKEN: "refresh",
  GMAIL_USER: "user@example.com",
};

describe("preflightSecrets — OAuth2 token exchange retry", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, REQUIRED_ENV);
    // Make backoff sleeps instant so the suite doesn't wait real seconds.
    vi.spyOn(global, "setTimeout").mockImplementation((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("throws when a required env var is missing", async () => {
    delete process.env.GMAIL_REFRESH_TOKEN;
    await expect(preflightSecrets()).rejects.toThrow(
      /Missing required env vars: GMAIL_REFRESH_TOKEN/
    );
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("succeeds on the first attempt when the token exchange works", async () => {
    getAccessToken.mockResolvedValue({ token: "abc" });
    await expect(preflightSecrets()).resolves.toBeUndefined();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 'Premature close' failure and then succeeds", async () => {
    getAccessToken
      .mockRejectedValueOnce(new Error("Premature close"))
      .mockRejectedValueOnce(new Error("Premature close"))
      .mockResolvedValue({ token: "abc" });

    await expect(preflightSecrets()).resolves.toBeUndefined();
    expect(getAccessToken).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting retries on persistent transient failures", async () => {
    getAccessToken.mockRejectedValue(new Error("Premature close"));

    await expect(preflightSecrets()).rejects.toThrow(
      /Gmail OAuth2 token exchange failed: Error: Premature close/
    );
    // Initial attempt + OAUTH_MAX_RETRIES (3) = 4 total calls.
    expect(getAccessToken).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry a permanent credential error (invalid_grant)", async () => {
    getAccessToken.mockRejectedValue(new Error("invalid_grant"));

    await expect(preflightSecrets()).rejects.toThrow(
      /Gmail OAuth2 token exchange failed: Error: invalid_grant/
    );
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("treats an empty token as a failure and retries", async () => {
    getAccessToken
      .mockResolvedValueOnce({ token: null })
      .mockResolvedValue({ token: "abc" });

    await expect(preflightSecrets()).resolves.toBeUndefined();
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });
});
