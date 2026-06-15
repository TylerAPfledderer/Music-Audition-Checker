# 🎺 Symphony Audition Checker

A GitHub Actions cron job that monitors symphony orchestra audition pages on a weekly schedule and emails you when relevant trumpet opportunities are posted. Content is classified with Google Gemini, and email is delivered through the Gmail API over OAuth2.

**What it detects:**
- Auditions for trumpet (principal, section, associate, extra, sub)
- Sub list openings for any instrument (where trumpet qualifies)
- General orchestral auditions open to brass players
- Only alerts on **future-dated** or currently open opportunities

It also crawls the [Playbill job board](https://playbill.com/jobs) for musician listings and validates each one for trumpet relevance.

---

## Setup

### 1. Clone / fork this repo

```bash
git clone <your-repo-url>
cd Music-Audition-Checker
npm install
```

### 2. Configure your URLs

Edit `urls.json` to add/remove pages you want to monitor. Each entry needs a `name` and `url`:

```json
[
  {
    "name": "New York Philharmonic — Auditions",
    "url": "https://nyphil.org/about-us/careers/auditions"
  }
]
```

The file ships with a set of regional orchestras and military bands as a starting point, plus the Playbill job board. For a job board that lists openings across many organizations, add `"crawlMode": "playbill"` to the entry (see [Adding more orchestras](#adding-more-orchestras)).

### 3. Get a Google Gemini API key

Content classification runs on Gemini's free tier.

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Create an API key and copy it — this is your `GEMINI_API_KEY`

By default the script uses `gemini-2.5-flash` and automatically falls back to `gemini-2.0-flash` if the primary model is overloaded. Override the primary model with the optional `GEMINI_MODEL` env var.

### 4. Set up Gmail API OAuth2

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
npx ts-node src/setup-oauth.ts
```
This opens a local server on `http://localhost:3000`, prints an authorization URL, and — after you sign in and click Allow — prints your `GMAIL_REFRESH_TOKEN`. The refresh token does not expire unless you revoke app access.

### 5. (Optional) Get a Firecrawl API key

Some pages are JS-rendered or bot-protected and return too little content over a plain HTTP fetch. When `FIRECRAWL_API_KEY` is set, [Firecrawl](https://firecrawl.dev) is used as a fallback scraper (and surfaces a higher-quality links array for the Playbill crawler). The script runs without it — Firecrawl is only engaged when the native fetch falls short.

### 6. Add GitHub Secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GMAIL_CLIENT_ID` | OAuth2 Client ID from Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | OAuth2 Client Secret from Google Cloud Console |
| `GMAIL_REFRESH_TOKEN` | Refresh token printed by `src/setup-oauth.ts` |
| `GMAIL_USER` | Your Gmail address (e.g. `you@gmail.com`) — the account that sends mail |
| `NOTIFY_EMAIL` | Email to receive alerts (can be same as `GMAIL_USER`) |
| `FIRECRAWL_API_KEY` | (Optional) Firecrawl API key to enable the scraping fallback |

`GITHUB_TOKEN` and `GITHUB_REPOSITORY` are provided automatically by GitHub Actions — no setup needed. They let the workflow open an issue when a URL fails preflight.

### 7. Enable GitHub Actions write permissions

In your repo: **Settings → Actions → General → Workflow permissions**
→ Select **"Read and write permissions"**

This allows the workflow to commit the updated `audition-state.json` back to the repo after each run. The workflow also declares `issues: write` so it can file an issue when a URL fails preflight.

---

## How it works

```
Every Monday 8:00 AM UTC and Thursday 8:00 PM UTC
        ↓
── Preflight (runs before any state mutation) ──
  1. Validate required env vars are present
  2. Perform a live Gmail OAuth2 token exchange
  3. Fetch each URL → confirm enough readable content returned
  4. Ask Gemini whether each page looks like an audition/employment page
     (Playbill and previously-validated URLs skip this probe)
  → Failures are collected, not fatal: a GitHub issue is opened and the
    run continues for all healthy URLs
        ↓
── Main run (only reached after preflight) ──
For each URL in urls.json:
  Standard pages:
    1. Fetch page (native HTTP first, Firecrawl fallback for JS-heavy/blocked pages)
    2. Hash audition-relevant text → compare to stored hash; skip if unchanged
    3. Deterministic brass keyword gate skips pages with no trumpet/cornet mention
    4. Send text (plus any audition sub-pages) to Gemini for relevance analysis
    5. If newly relevant — or a new relevant item appears — queue for email
  Playbill job board (crawlMode: "playbill"):
    1. Fetch the index → extract musician listing URLs
    2. Fetch each new listing → ask Gemini if it involves trumpet
    3. Queue matching listings for email
        ↓
Send a single digest email with all new findings + any URL issues
        ↓
Commit updated audition-state.json to the repo
```

**State file (`audition-state.json`):** Auto-generated on first run. Stores, per URL, a content hash plus Gemini's extracted summary and the canonical list of items you've already been notified about; Playbill listing state is tracked separately. Committed back to the repo after every run so state persists between workflow executions. Do not edit manually.

**Change detection:** Pages are hashed only on their audition-relevant sentences (after stripping timestamps and rotating content), so news posts and featured-musician bios don't trigger spurious re-analysis. Gemini is only called when the hash changes — keeping API usage proportional to real page changes.

**Notifications:** An email fires the first time a page becomes relevant, and again when a *new* relevant item appears on an already-relevant page. Item labels are canonicalized (e.g. "Principal Trumpet" vs. "1st Trumpet") so wording drift between runs doesn't cause duplicate alerts. Playbill `notified` flags are written only after the email is sent successfully (at-least-once delivery).

---

## Running locally

Store your secrets in a `.env.local` file (gitignored) — it's loaded automatically:

```bash
# .env.local
GEMINI_API_KEY=...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_USER=you@gmail.com
NOTIFY_EMAIL=you@gmail.com
# Optional
FIRECRAWL_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

Then run:

```bash
npm run check        # Full run — analyzes pages, sends email, writes state
npm run check:dry    # Dry run — no email sent, no state written
npm run check:debug  # Dry run + verbose hash debug logging to debug.log
npm test             # Run the Vitest suite
```

---

## Environment variables

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API access (required) |
| `GEMINI_MODEL` | (Optional) Primary Gemini model. Defaults to `gemini-2.5-flash`. |
| `GMAIL_CLIENT_ID` | Gmail OAuth2 client ID (required) |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth2 client secret (required) |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth2 refresh token (required) |
| `GMAIL_USER` | Sending Gmail address (required) |
| `NOTIFY_EMAIL` | Recipient address. Defaults to `GMAIL_USER` if unset. |
| `GMAIL_LABEL_NAME` | (Optional) Gmail label to apply via `messages.insert` instead of sending. Only works when `NOTIFY_EMAIL` is the same account as the OAuth credentials. The label is created automatically if missing. |
| `FIRECRAWL_API_KEY` | (Optional) Enables the Firecrawl scraping fallback. |
| `DRY_RUN` | Set to `true` to skip email and state writes. |
| `CHECKER_DEBUG` | Set to `true` to write hash-diff debug output to `debug.log`. |
| `GITHUB_TOKEN` / `GITHUB_REPOSITORY` | Provided automatically by Actions; used to open issues on preflight failures. |

---

## Customizing the schedule

Edit the cron expressions in `.github/workflows/audition-checker.yml`:

```yaml
- cron: "0 8 * * 1"    # Every Monday at 8:00 AM UTC
- cron: "0 20 * * 4"   # Every Thursday at 8:00 PM UTC
```

Use [crontab.guru](https://crontab.guru) to build expressions.

---

## Adding more orchestras

Just add entries to `urls.json`:

```json
{ "name": "Orchestra Name", "url": "https://orchestra.org/auditions" }
```

For Playbill-style job boards that aggregate listings across organizations, add `"crawlMode": "playbill"`:

```json
{ "name": "Playbill Job Board", "url": "https://playbill.com/jobs?show=60&category=Musician", "crawlMode": "playbill" }
```

Good sources:
- The orchestra's official website (careers/auditions section)
- [ICSOM audition listings](https://www.icsom.org/)
- [AFM Local listings](https://www.afm.org/)

---

## What I Learned Building This

This project was built primarily with the assistance of Claude AI. Beyond the automation itself, the process surfaced a few things worth documenting.

### Using AI as a semantic filter, not just a chatbot
The core motivation was a personal RSS-style feed that was *thoughtful* — one that understood context rather than just pattern-matching keywords. A regex search for "trumpet" would catch past auditions, administrative roles, and irrelevant mentions equally. Using an LLM as a classifier inside an automated pipeline meant the notifications could reflect actual intent. This was the primary reason the project exists at all. (A cheap deterministic keyword gate still runs first, so the LLM is only invoked for pages that could plausibly be relevant — keeping API usage low.)

### Preflight as an isolated phase
Without a clear mental model of the steps involved, I would likely have entangled validation, fetching, and state updates together as the logic evolved. Seeing preflight implemented as a completely isolated phase made the distinction clear: initialize and validate everything first, before touching any state. If anything fails — an expired OAuth token, an unreachable URL — it surfaces cleanly. Without that separation, a mid-run failure risks leaving `audition-state.json` partially updated, silently corrupting future runs.

### Node's built-in `http`/`https` modules
I hadn't worked directly with Node's built-in HTTP modules before. In a CI script, reaching for `axios` or `node-fetch` adds a dependency that needs installing. The built-in modules handle raw HTTP requests with no overhead — no rendering, no parsing, just the response body — which is all the primary fetch needs. Firecrawl is imported dynamically and only as a fallback, so the script still runs without it.

### Reviewing code through conversation
Talking through a codebase with AI is a lot like rubber-duck debugging — except the duck talks back. When AI explains what the code is actually doing in clear, unbiased terms, it offers a different perspective on the logic — one that can prompt you to consider possibilities and gaps you hadn't thought to look for. One specific example surfaced here: when the LLM's JSON response fails to parse, the script logs a warning and moves on silently — no email, no GitHub issue. That's a guardrail worth keeping an eye on.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Email not sending | Verify all four Gmail OAuth secrets are set (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER`); confirm the Gmail API is enabled in Google Cloud Console. Preflight performs a live token exchange and will fail loudly if the refresh token is bad. |
| No refresh token returned by `src/setup-oauth.ts` | Revoke app access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then re-run the script (it requests `prompt: consent`). |
| Page content empty / too short | The site likely blocks scrapers or needs JS rendering. Set `FIRECRAWL_API_KEY` to enable the Firecrawl fallback. |
| Gemini not finding relevant content | Check `audition-state.json` to see the summary Gemini extracted; some sites need JS rendering (Firecrawl). |
| Hitting Gemini quota | The free tier has daily limits; the script retries on rate limits and aborts cleanly when the daily quota is exhausted. Set `GEMINI_MODEL` to a lighter model if needed. |
| Workflow can't commit state | Ensure "Read and write permissions" is enabled in repo Actions settings. |
