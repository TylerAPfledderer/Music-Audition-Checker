# CLAUDE.md

## Project Overview

A GitHub Actions cron job that monitors symphony orchestra audition pages weekly, using Google Gemini for LLM-powered content analysis, and Gmail OAuth2 for email delivery. Built for a professional trumpet player tracking audition opportunities.

## Stack

- TypeScript + Node.js (CommonJS, ES2022 target)
- Google Gemini API (`@google/generative-ai`) — content classification
- Google Gmail API (`googleapis`) — OAuth2 email delivery
- Firecrawl (`@mendable/firecrawl-js`) — managed scraping fallback for JS-rendered and bot-protected pages
- Vitest — test suite
- GitHub Actions — weekly cron scheduler and CI

## Project Structure

```
src/
  check-auditions.ts   # Main orchestrator (preflight + main run)
  llm.ts               # LlmClient interface + Gemini factory
  llm-classifiers.ts   # LLM-powered classifiers (relevance, audition page probe)
  playbill-crawler.ts  # Two-stage Playbill job board crawler
  scraper.ts           # HTTP/Firecrawl fetch utilities
  setup-oauth.ts       # One-time Gmail OAuth2 token setup script
tests/
  check-auditions.test.ts
  playbill-crawler.test.ts
  scraper.test.ts
urls.json              # Orchestras/job boards to monitor
audition-state.json    # Persisted run state (committed to git by Actions)
```

## Development Commands

```bash
npm run check          # Run the audition checker
npm run check:dry      # Dry-run mode (no email sent, no state written)
npm test               # Run vitest test suite
```

## Architecture

### Two-Phase Execution (`check-auditions.ts`)
1. **PREFLIGHT** — validates secrets, probes all URLs, confirms they are audition pages, builds content cache. Collects failures without stopping; auto-creates GitHub Issues for failures.
2. **MAIN RUN** — dispatches each URL by `crawlMode`. Skips unchanged pages (content hash), calls LLM for relevance analysis, sends a single digest email with all findings.

### Crawl Modes
- **Standard** (`crawlMode` absent): fetch → hash check → LLM analysis → notify on new relevant items
- **Playbill** (`crawlMode: "playbill"`): index fetch → URL extraction → per-listing detail validation

### State Persistence
- State stored in `audition-state.json` (no external DB)
- Committed back to the repo after every workflow run by GitHub Actions
- State schema uses defensive defaults to allow evolution without migrations

### LLM Usage
- Provider: Google Gemini (free tier) via `@google/generative-ai`
- Model: `gemini-2.0-flash` with `responseMimeType: "application/json"` for native JSON output
- Abstraction: `LlmClient` interface in `src/llm.ts` — single `generate(prompt, maxTokens)` method; easy to swap providers
- Classifiers: `analyzeWithLlm()` (relevance), `probeIsAuditionPage()` (URL type), `extractPlaybillListings()` (structured extraction), `checkListingForTrumpet()` (binary check)
- Pass only the text content (after `stripHtml()`), not raw HTML, to reduce token usage

### Email
- Single digest per run (not one email per finding)
- RFC 2047-encoded subject line (`encodeSubjectRfc2047()`) — required for emojis/em dashes
- Gmail API with OAuth2 refresh token (not app passwords)

## Key Conventions

- **No external HTTP library** — `scraper.ts` uses Node's native `http`/`https` modules for the primary fetch
- **Firecrawl imported dynamically** — only engaged when `FIRECRAWL_API_KEY` is set and plain HTTP returns insufficient content; script runs without it
- **Rising-edge notifications** — email sent when a page first becomes relevant, or when new relevant items appear on an already-relevant page (`shouldNotify()` in `check-auditions.ts`); non-trumpet content changes are ignored
- **At-least-once delivery** — Playbill `notified` flags written only after successful email send
- **Content hashing** — SHA256 (16-char prefix) via `contentHash()` to skip unchanged pages

## Testing

Tests live in `tests/` and mirror `src/`. Run with `npm test`.

- Mock `LlmClient` and `googleapis` — no real API calls in tests
- Test crawl logic, state mutations, email building, HTML stripping, and URL extraction
- CI runs tests on every push/PR to `main` (`.github/workflows/test.yml`)
- Do not test `setup-oauth.ts` (one-time interactive script)

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` | Google Gemini API access (free tier) |
| `GMAIL_CLIENT_ID` | Gmail OAuth2 client ID |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth2 refresh token |
| `NOTIFY_EMAIL` | Recipient email address |
| `GMAIL_LABEL_NAME` | (Optional) Gmail label name to apply via `messages.insert`. Only works when `NOTIFY_EMAIL` is the same account as the OAuth credentials (`GMAIL_USER`). Label is created automatically if it doesn't exist. |
| `DRY_RUN` | Set to `true` to skip email and state writes |
| `GH_TOKEN` | GitHub token for creating issues on failures |
| `FIRECRAWL_API_KEY` | (Optional) Firecrawl API key. When set, enables Firecrawl as a fallback scraper after native HTTP fails or returns too-short content. Also surfaces a `links` array for higher-quality Playbill job URL extraction. |

Locally, store in `.env.local` (gitignored). In Actions, store as GitHub Secrets.

## GitHub Actions

- **`audition-checker.yml`** — runs Monday 8:00 AM UTC; reads secrets, runs checker, commits updated `audition-state.json`
- **`test.yml`** — runs on push/PR to `main`; no secrets needed

## Adding a New Orchestra

Add an entry to `urls.json`:

```json
{ "name": "Orchestra Name", "url": "https://orchestra.org/auditions" }
```

For Playbill-style job boards, add `"crawlMode": "playbill"`.
