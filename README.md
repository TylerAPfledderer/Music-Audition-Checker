# 🎺 Symphony Audition Checker

A GitHub Actions cron job that monitors symphony orchestra audition pages weekly and emails you when relevant trumpet opportunities are posted.

**What it detects:**
- Auditions for trumpet (principal, section, associate, extra, sub)
- Sub list openings for any instrument (where trumpet qualifies)
- General orchestral auditions open to brass players
- Only alerts on **future-dated** or currently open opportunities

---

## Setup

### 1. Clone / fork this repo

```bash
git clone <your-repo-url>
cd audition-checker
npm install
```

### 2. Configure your URLs

Edit `urls.json` to add/remove symphony pages you want to monitor. Each entry needs a `name` and `url`:

```json
[
  {
    "name": "New York Philharmonic — Auditions",
    "url": "https://nyphil.org/about-us/careers/auditions"
  }
]
```

The file ships with 10 major US orchestras as a starting point.

### 3. Set up Gmail API OAuth2

This uses Google's OAuth2 — no App Password needed. One-time setup:

**a) Create a Google Cloud project & OAuth credentials:**
1. Go to [console.cloud.google.com](https://console.cloud.google.com) → New Project
2. Enable the **Gmail API**: APIs & Services → Enable APIs → search "Gmail API"
3. Go to APIs & Services → **Credentials** → Create Credentials → **OAuth client ID**
4. Application type: **Desktop app** → name it "Audition Checker" → Create
5. Copy your **Client ID** and **Client Secret**

**b) Generate a refresh token (run once locally):**
```bash
GMAIL_CLIENT_ID=your-client-id \
GMAIL_CLIENT_SECRET=your-client-secret \
npx ts-node setup-oauth.ts
```
Follow the prompts — it will print your `GMAIL_REFRESH_TOKEN`.

### 4. Add GitHub Secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key from [console.anthropic.com](https://console.anthropic.com) |
| `GMAIL_CLIENT_ID` | OAuth2 Client ID from Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | OAuth2 Client Secret from Google Cloud Console |
| `GMAIL_REFRESH_TOKEN` | Refresh token printed by `setup-oauth.ts` |
| `GMAIL_USER` | Your Gmail address (e.g. `you@gmail.com`) |
| `NOTIFY_EMAIL` | Email to receive alerts (can be same as `GMAIL_USER`) |

### 5. Enable GitHub Actions write permissions

In your repo: **Settings → Actions → General → Workflow permissions**
→ Select **"Read and write permissions"**

This allows the workflow to commit the updated `audition-state.json` back to the repo after each run.

---

## How it works

```
Every Monday 8AM UTC
        ↓
── Preflight (exits with error if anything fails) ──
  1. Validate all required env vars are present
  2. Test Gmail OAuth2 token exchange
  3. Fetch each URL → confirm readable content returned
  4. Ask Claude if each page looks like an audition/employment page
        ↓
── Main run (only reached if preflight passes) ──
For each URL in urls.json:
  1. Fetch page (HTTP fetch first, Puppeteer fallback for JS-heavy pages)
  2. Hash page text → compare to stored hash in audition-state.json
  3. If changed → send text to Claude for analysis
  4. Claude checks for: future-dated trumpet/sub auditions
  5. If newly relevant (wasn't flagged before) → queue for email
        ↓
Send single digest email with all new findings
        ↓
Commit updated audition-state.json to repo
```

**State file (`audition-state.json`):** Auto-generated on first run. Stores a content hash and Claude's extracted summary per URL. Committed back to the repo after every run so state persists between workflow executions. Do not edit manually.

---

## Running locally

```bash
# Set env vars
export ANTHROPIC_API_KEY=sk-ant-...
export GMAIL_USER=you@gmail.com
export GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
export NOTIFY_EMAIL=you@gmail.com

# Run
npm run check
```

---

## Customizing the schedule

Edit the cron expression in `.github/workflows/audition-checker.yml`:

```yaml
- cron: "0 8 * * 1"   # Every Monday at 8AM UTC
- cron: "0 8 * * 1,4" # Monday and Thursday
- cron: "0 8 1 * *"   # First of every month
```

Use [crontab.guru](https://crontab.guru) to build expressions.

---

## Adding more orchestras

Just add entries to `urls.json`. Good sources:
- The orchestra's official website (careers/auditions section)
- [ICSOM audition listings](https://www.icsom.org/)
- [AFM Local listings](https://www.afm.org/)

---

## What I Learned Building This

This project was built primarily with the assistance of Claude AI. Beyond the automation itself, the process surfaced a few things worth documenting.

### Using AI as a semantic filter, not just a chatbot
The core motivation was a personal RSS-style feed that was *thoughtful* — one that understood context rather than just pattern-matching keywords. A regex search for "trumpet" would catch past auditions, administrative roles, and irrelevant mentions equally. Using Claude as a classifier inside an automated pipeline meant the notifications could reflect actual intent. This was the primary reason the project exists at all.

### Preflight as an isolated phase
Without a clear mental model of the steps involved, I would likely have entangled validation, fetching, and state updates together as the logic evolved. Seeing preflight implemented as a completely isolated phase made the distinction clear: initialize and validate everything first, before touching any state. If anything fails — an expired OAuth token, an unreachable URL — it surfaces cleanly. Without that separation, a mid-run failure risks leaving `audition-state.json` partially updated, silently corrupting future runs.

### Node's built-in `http`/`https` modules
I hadn't worked directly with Node's built-in HTTP modules before. In a CI script, reaching for `axios` or `node-fetch` adds a dependency that needs installing. The built-in modules handle raw HTTP requests with no overhead — no rendering, no parsing, just the response body — which is all this script needs.

### Reviewing code through conversation
Talking through a codebase with AI is a lot like rubber-duck debugging — except the duck talks back. When AI explains what the code is actually doing in clear, unbiased terms, it offers a different perspective on the logic — one that can prompt you to consider possibilities and gaps you hadn't thought to look for. One specific example surfaced here: when Claude fails to parse a page's JSON response, the script logs a warning and moves on silently — no email, no GitHub issue. That's a guardrail worth adding.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Email not sending | Verify all 3 OAuth secrets are set correctly; check Gmail API is enabled in Google Cloud Console |
| No refresh token returned by setup-oauth.ts | Revoke app access at myaccount.google.com/permissions, then re-run the script |
| Page content empty | Site may block scrapers; try adding it to Puppeteer-only mode by lowering `MIN_CONTENT_LENGTH` threshold |
| Claude not finding relevant content | Check `audition-state.json` to see what text Claude received; some sites need JS rendering |
| Workflow can't commit state | Ensure "Read and write permissions" is enabled in repo Actions settings |
