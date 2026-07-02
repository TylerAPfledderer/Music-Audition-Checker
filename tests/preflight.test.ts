/**
 * Tests for the OAuth2 token-exchange retry logic in preflightSecrets.
 *
 * The token exchange is performed with Node's native `https` module (bypassing the
 * googleapis/node-fetch "Premature close" bug). These tests drive that path via a
 * scriptable `https.request` mock: transient transport failures should be retried
 * with backoff, while genuine credential rejections (invalid_grant) fail fast.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("https", () => ({
  request: vi.fn(),
}));

import * as https from "https";
import { preflightSecrets } from "../src/preflight";

const REQUIRED_ENV = {
  GEMINI_API_KEY: "g",
  GMAIL_CLIENT_ID: "id",
  GMAIL_CLIENT_SECRET: "secret",
  GMAIL_REFRESH_TOKEN: "refresh",
  GMAIL_USER: "user@example.com",
};

type Outcome =
  | { status: number; body: unknown }
  | { networkError: string }
  | { timeout: true };

/**
 * Queue a sequence of outcomes for successive https.request calls. Each entry maps to
 * one token-exchange attempt, letting a single test assert the retry sequence.
 */
function queueHttps(outcomes: Outcome[]): void {
  let i = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(https.request).mockImplementation(((_opts: any, cb: (res: any) => void) => {
    const outcome = outcomes[i++] ?? { status: 200, body: { access_token: "abc" } };
    let errorHandler: ((e: Error) => void) | undefined;
    const req = {
      on: (evt: string, h: (e: Error) => void) => {
        if (evt === "error") errorHandler = h;
        return req;
      },
      setTimeout: (_ms: number, h: () => void) => {
        if ("timeout" in outcome) queueMicrotask(() => h());
        return req;
      },
      write: () => req,
      end: () => req,
      destroy: () => req,
    };
    queueMicrotask(() => {
      if ("networkError" in outcome) {
        errorHandler?.(new Error(outcome.networkError));
      } else if ("status" in outcome) {
        const resHandlers: Record<string, (arg?: string) => void> = {};
        const res = {
          statusCode: outcome.status,
          on: (evt: string, h: (arg?: string) => void) => {
            resHandlers[evt] = h;
            return res;
          },
        };
        cb(res);
        resHandlers.data?.(JSON.stringify(outcome.body));
        resHandlers.end?.();
      }
    });
    return req;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

describe("preflightSecrets — OAuth2 token exchange retry", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, REQUIRED_ENV);
    // Make backoff sleeps instant so the suite doesn't wait real seconds.
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

  it("throws when a required env var is missing", async () => {
    delete process.env.GMAIL_REFRESH_TOKEN;
    await expect(preflightSecrets()).rejects.toThrow(
      /Missing required env vars: GMAIL_REFRESH_TOKEN/
    );
    expect(https.request).not.toHaveBeenCalled();
  });

  it("succeeds on the first attempt when the token exchange works", async () => {
    queueHttps([{ status: 200, body: { access_token: "abc" } }]);
    await expect(preflightSecrets()).resolves.toBeUndefined();
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 'Premature close' failure and then succeeds", async () => {
    queueHttps([
      { networkError: "Premature close" },
      { networkError: "Premature close" },
      { status: 200, body: { access_token: "abc" } },
    ]);
    await expect(preflightSecrets()).resolves.toBeUndefined();
    expect(https.request).toHaveBeenCalledTimes(3);
  });

  it("retries a request timeout and then succeeds", async () => {
    queueHttps([{ timeout: true }, { status: 200, body: { access_token: "abc" } }]);
    await expect(preflightSecrets()).resolves.toBeUndefined();
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on persistent transient failures", async () => {
    queueHttps([
      { networkError: "Premature close" },
      { networkError: "Premature close" },
      { networkError: "Premature close" },
      { networkError: "Premature close" },
    ]);
    await expect(preflightSecrets()).rejects.toThrow(
      /Gmail OAuth2 token exchange failed:.*Premature close/
    );
    // Initial attempt + OAUTH_MAX_RETRIES (3) = 4 total calls.
    expect(https.request).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry a permanent credential error (invalid_grant)", async () => {
    queueHttps([
      { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
    ]);
    await expect(preflightSecrets()).rejects.toThrow(
      /Gmail OAuth2 token exchange failed:.*invalid_grant/
    );
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  it("treats a 200 with no access_token as a retryable failure", async () => {
    queueHttps([{ status: 200, body: {} }, { status: 200, body: { access_token: "abc" } }]);
    await expect(preflightSecrets()).resolves.toBeUndefined();
    expect(https.request).toHaveBeenCalledTimes(2);
  });
});
