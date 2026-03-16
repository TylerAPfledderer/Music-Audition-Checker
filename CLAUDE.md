# CLAUDE.md

## Project Overview

A GitHub Actions cron job that monitors symphony orchestra audition pages weekly, using Claude for LLM-powered content analysis, and Gmail OAuth2 for email delivery. Built for a professional trumpet player tracking audition opportunities.

## Stack

- TypeScript + Node.js (CommonJS, ES2022 target)
- Anthropic Claude API (`@anthropic-ai/sdk`) — content classification
- Google Gmail API (`googleapis`) — OAuth2 email delivery
- Puppeteer — headless browser fallback for JS-rendered pages
- Vitest — test suite
- GitHub Actions — weekly cron scheduler and CI

## Project Structure

```
src/
  check-auditions.ts   # Main orchestrator (preflight + main run)
  playbill-crawler.ts  # Two-stage Playbill job board crawler
  scraper.ts           # HTTP/Puppeteer fetch utilities
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
2. **MAIN RUN** — dispatches each URL by `crawlMode`. Skips unchanged pages (content hash), calls Claude for relevance analysis, sends a single digest email with all findings.

### Crawl Modes
- **Standard** (`crawlMode` absent): fetch → hash check → Claude analysis → notify on new relevant items
- **Playbill** (`crawlMode: "playbill"`): index fetch → URL extraction → per-listing detail validation

### State Persistence
- State stored in `audition-state.json` (no external DB)
- Committed back to the repo after every workflow run by GitHub Actions
- State schema uses defensive defaults to allow evolution without migrations

### Claude Usage
- Model: use `claude-sonnet-4-6` (latest Sonnet) for all classifiers
- Classifiers: `analyzeWithClaude()` (relevance), `probeIsAuditionPage()` (URL type), `extractPlaybillListings()` (structured extraction), `checkListingForTrumpet()` (binary check)
- Pass only the text content (after `stripHtml()`), not raw HTML, to reduce token usage

### Email
- Single digest per run (not one email per finding)
- RFC 2047-encoded subject line (`encodeSubjectRfc2047()`) — required for emojis/em dashes
- Gmail API with OAuth2 refresh token (not app passwords)

## Key Conventions

- **No external HTTP library** — `scraper.ts` uses Node's native `http`/`https` modules
- **Puppeteer imported dynamically** — only loaded if plain HTTP fails, so script runs without it installed
- **Rising-edge notifications** — email sent when a page first becomes relevant, or when new relevant items appear on an already-relevant page (`shouldNotify()` in `check-auditions.ts`); non-trumpet content changes are ignored
- **At-least-once delivery** — Playbill `notified` flags written only after successful email send
- **Content hashing** — SHA256 (16-char prefix) via `contentHash()` to skip unchanged pages

## Testing

Tests live in `tests/` and mirror `src/`. Run with `npm test`.

- Mock `@anthropic-ai/sdk` and `googleapis` — no real API calls in tests
- Test crawl logic, state mutations, email building, HTML stripping, and URL extraction
- CI runs tests on every push/PR to `main` (`.github/workflows/test.yml`)
- Do not test `setup-oauth.ts` (one-time interactive script)

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API access |
| `GMAIL_CLIENT_ID` | Gmail OAuth2 client ID |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth2 refresh token |
| `NOTIFY_EMAIL` | Recipient email address |
| `GMAIL_LABEL_NAME` | (Optional) Gmail label name to apply via `messages.insert`. Only works when `NOTIFY_EMAIL` is the same account as the OAuth credentials (`GMAIL_USER`). Label is created automatically if it doesn't exist. |
| `DRY_RUN` | Set to `true` to skip email and state writes |
| `GH_TOKEN` | GitHub token for creating issues on failures |

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
