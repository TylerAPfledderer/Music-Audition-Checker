import * as https from "https";

import { ProbeFailure } from "./email";

// ─── GitHub Issue ─────────────────────────────────────────────────────────────

export async function createGitHubIssue(failures: ProbeFailure[]): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // set automatically by Actions: "owner/repo"

  if (!token || !repo) {
    console.warn("  ⚠️  GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping issue creation");
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
