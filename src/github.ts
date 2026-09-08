import * as https from "https";

import { ProbeFailure } from "./email";

// ─── GitHub Issue ─────────────────────────────────────────────────────────────

/**
 * Returns true if there is already an open issue carrying `label`. Used to prevent a
 * new issue from being created on every run when the same problem persists — the
 * existing open issue already tracks it. Callers use distinct labels per failure
 * category (URL failures vs. credential failures) so one category's open issue
 * doesn't suppress the other's.
 */
async function hasOpenIssueWithLabel(token: string, repo: string, label: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`,
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": "audition-checker",
          "Accept": "application/vnd.github+json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const issues = JSON.parse(data);
            resolve(Array.isArray(issues) && issues.length > 0);
          } catch {
            resolve(false); // parse error → assume no open issue, proceed with creation
          }
        });
      }
    );
    req.on("error", () => resolve(false)); // network error → assume no open issue
    req.end();
  });
}

/** Back-compat wrapper — checks for an open issue under the general `audition-checker` label. */
export async function hasOpenAuditionCheckerIssue(token: string, repo: string): Promise<boolean> {
  return hasOpenIssueWithLabel(token, repo, "audition-checker");
}

/**
 * POSTs a prebuilt issue payload and logs the resulting URL. Shared by both issue-creation
 * paths (URL failures, credential failures) so the request boilerplate lives in one place.
 */
async function postIssue(token: string, repo: string, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${repo}/issues`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "audition-checker",
          "Accept": "application/vnd.github+json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 201) {
            const issue = JSON.parse(data);
            console.log(`  ✓ GitHub issue created: ${issue.html_url}`);
            resolve();
          } else {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function createGitHubIssue(failures: ProbeFailure[]): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // set automatically by Actions: "owner/repo"

  if (!token || !repo) {
    console.warn("  ⚠️  GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping issue creation");
    return;
  }

  // Skip creation if an open issue already tracks a prior failure — prevents
  // a new issue from being filed on every run for a persistently broken URL.
  const alreadyOpen = await hasOpenIssueWithLabel(token, repo, "audition-checker");
  if (alreadyOpen) {
    console.log("  ℹ️  Open audition-checker issue already exists — skipping duplicate creation");
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const title = `[Audition Checker] URL issue(s) detected on ${today}`;

  const rows = failures
    .map((f) => {
      const label = f.reason === "fetch-failed" ? "❌ Could not fetch" : "⚠️ Not an audition page";
      return `| ${f.name} | ${f.url} | ${label} | ${f.detail} |`;
    })
    .join("\n");

  const body = `## Audition Checker — Preflight URL Failures

The weekly audition checker ran on **${today}** and encountered issues with the following URL(s):

| Name | URL | Issue | Detail |
|------|-----|-------|--------|
${rows}

### What to do
- **Could not fetch**: The page may be down, moved, or blocking automated requests. Verify the URL is correct and accessible.
- **Not an audition page**: The URL may have changed to a different section of the site. Update \`urls.json\` with the correct audition/careers page URL.

_This issue was created automatically by the [audition-checker workflow](../../actions)._`;

  const payload = JSON.stringify({ title, body, labels: ["audition-checker", "bug"] });

  await postIssue(token, repo, payload);
}

/**
 * Files a GitHub issue when `preflightSecrets` fails (e.g. an expired/revoked Gmail
 * OAuth2 refresh token). This is a distinct code path from `createGitHubIssue` because
 * a credential failure aborts the run before any URL is probed — there is no
 * `ProbeFailure[]` to report, and without this the only signal is the Actions run
 * going red, which is easy to miss on a weekly cron.
 */
export async function createCredentialFailureIssue(errorDetail: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // set automatically by Actions: "owner/repo"

  if (!token || !repo) {
    console.warn("  ⚠️  GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping issue creation");
    return;
  }

  // Distinct label from the URL-failure path so an open URL-failure issue doesn't
  // suppress a credential-failure issue, or vice versa.
  const alreadyOpen = await hasOpenIssueWithLabel(token, repo, "credentials");
  if (alreadyOpen) {
    console.log("  ℹ️  Open credential-failure issue already exists — skipping duplicate creation");
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const title = `[Audition Checker] Gmail credentials failed preflight on ${today}`;

  const body = `## Audition Checker — Credential Failure

The weekly audition checker ran on **${today}** and could not authenticate with Gmail, so preflight aborted before checking any pages or sending any email:

\`\`\`
${errorDetail}
\`\`\`

### What to do
This usually means the Gmail OAuth2 refresh token has expired or been revoked (e.g. after a Google security review, a password change, or manually revoking access at https://myaccount.google.com/permissions).

1. Run the one-time setup script locally: \`GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... npx ts-node src/setup-oauth.ts\`
2. Open the printed URL, sign in, and click Allow.
3. Copy the new \`GMAIL_REFRESH_TOKEN\` value the script prints, and update the \`GMAIL_REFRESH_TOKEN\` secret under this repo's Settings → Secrets and variables → Actions.
4. Re-run the [audition-checker workflow](../../actions) to confirm it succeeds, then close this issue.

_This issue was created automatically by the [audition-checker workflow](../../actions)._`;

  const payload = JSON.stringify({ title, body, labels: ["audition-checker", "credentials", "bug"] });

  await postIssue(token, repo, payload);
}
