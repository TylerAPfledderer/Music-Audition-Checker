/**
 * Tests for GitHub issue creation on preflight failures.
 *
 * `createGitHubIssue` (URL probe failures) and `createCredentialFailureIssue`
 * (Gmail OAuth2 credential failures) share a dedup-check + POST path but use
 * distinct labels so an open issue in one category never suppresses the other.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("https", () => ({
  request: vi.fn(),
}));

import * as https from "https";
import { createGitHubIssue, createCredentialFailureIssue, hasOpenAuditionCheckerIssue } from "../src/github";

type Route = { method: string; status: number; body: unknown };

// Captures the JSON body of the most recent POST request so tests can assert on
// what would have been sent to the GitHub Issues API.
let lastPostPayload: string | undefined;

/**
 * Queue GET/POST responses keyed by method so a single test can assert both the
 * dedup GET and the issue-creation POST without caring about call order.
 */
function queueHttps(routes: Route[]): void {
  lastPostPayload = undefined;
  vi.mocked(https.request).mockImplementation(((opts: any, cb: (res: any) => void) => {
    const route = routes.find((r) => r.method === opts.method) ?? routes[0];
    let errorHandler: ((e: Error) => void) | undefined;
    const req = {
      on: (evt: string, h: (e: Error) => void) => {
        if (evt === "error") errorHandler = h;
        return req;
      },
      write: (chunk: string) => {
        if (opts.method === "POST") lastPostPayload = chunk;
        return req;
      },
      end: () => req,
    };
    queueMicrotask(() => {
      void errorHandler; // referenced to avoid unused-var lint; error path unused by these tests
      const resHandlers: Record<string, (arg?: string) => void> = {};
      const res = {
        statusCode: route.status,
        on: (evt: string, h: (arg?: string) => void) => {
          resHandlers[evt] = h;
          return res;
        },
      };
      cb(res);
      resHandlers.data?.(JSON.stringify(route.body));
      resHandlers.end?.();
    });
    return req;
  }) as any);
}

describe("GitHub issue creation", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = "token";
    process.env.GITHUB_REPOSITORY = "owner/repo";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe("createGitHubIssue", () => {
    it("creates an issue when no open audition-checker issue exists", async () => {
      queueHttps([
        { method: "GET", status: 200, body: [] },
        { method: "POST", status: 201, body: { html_url: "https://github.com/owner/repo/issues/1" } },
      ]);
      await createGitHubIssue([{ name: "Orch", url: "https://x.com", reason: "fetch-failed", detail: "timeout" }]);
      const postCall = vi.mocked(https.request).mock.calls.find(([opts]: any) => opts.method === "POST");
      expect(postCall).toBeDefined();
    });

    it("skips creation when an open audition-checker issue already exists", async () => {
      queueHttps([{ method: "GET", status: 200, body: [{ number: 1 }] }]);
      await createGitHubIssue([{ name: "Orch", url: "https://x.com", reason: "fetch-failed", detail: "timeout" }]);
      const postCall = vi.mocked(https.request).mock.calls.find(([opts]: any) => opts.method === "POST");
      expect(postCall).toBeUndefined();
    });

    it("skips creation when GITHUB_TOKEN is missing", async () => {
      delete process.env.GITHUB_TOKEN;
      await createGitHubIssue([{ name: "Orch", url: "https://x.com", reason: "fetch-failed", detail: "timeout" }]);
      expect(https.request).not.toHaveBeenCalled();
    });
  });

  describe("createCredentialFailureIssue", () => {
    it("creates an issue labeled 'credentials' when none is open", async () => {
      queueHttps([
        { method: "GET", status: 200, body: [] },
        { method: "POST", status: 201, body: { html_url: "https://github.com/owner/repo/issues/2" } },
      ]);
      await createCredentialFailureIssue("invalid_grant: Token has been expired or revoked.");
      const postCall = vi.mocked(https.request).mock.calls.find(([opts]: any) => opts.method === "POST");
      expect(postCall).toBeDefined();
    });

    it("queries the 'credentials' label, not 'audition-checker', for dedup", async () => {
      queueHttps([{ method: "GET", status: 200, body: [] }, { method: "POST", status: 201, body: { html_url: "u" } }]);
      await createCredentialFailureIssue("invalid_grant");
      const getCall = vi.mocked(https.request).mock.calls.find(([opts]: any) => opts.method === "GET");
      expect((getCall![0] as any).path).toContain("labels=credentials");
    });

    it("skips creation when an open credential-failure issue already exists", async () => {
      queueHttps([{ method: "GET", status: 200, body: [{ number: 3 }] }]);
      await createCredentialFailureIssue("invalid_grant");
      const postCall = vi.mocked(https.request).mock.calls.find(([opts]: any) => opts.method === "POST");
      expect(postCall).toBeUndefined();
    });

    it("skips creation when GITHUB_REPOSITORY is missing", async () => {
      delete process.env.GITHUB_REPOSITORY;
      await createCredentialFailureIssue("invalid_grant");
      expect(https.request).not.toHaveBeenCalled();
    });

    it("includes the error detail and setup-oauth remediation steps in the issue body", async () => {
      queueHttps([{ method: "GET", status: 200, body: [] }, { method: "POST", status: 201, body: { html_url: "u" } }]);
      await createCredentialFailureIssue("invalid_grant: Token has been expired or revoked.");
      const { body, labels } = JSON.parse(lastPostPayload!);
      expect(body).toContain("invalid_grant: Token has been expired or revoked.");
      expect(body).toContain("setup-oauth.ts");
      expect(labels).toContain("credentials");
    });
  });

  describe("hasOpenAuditionCheckerIssue (back-compat)", () => {
    it("still queries the 'audition-checker' label", async () => {
      queueHttps([{ method: "GET", status: 200, body: [] }]);
      await hasOpenAuditionCheckerIssue("token", "owner/repo");
      const getCall = vi.mocked(https.request).mock.calls.find(([opts]: any) => opts.method === "GET");
      expect((getCall![0] as any).path).toContain("labels=audition-checker");
    });
  });
});
