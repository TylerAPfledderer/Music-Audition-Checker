import * as https from "https";

// ─── Gmail OAuth2 (native https) ──────────────────────────────────────────────
//
// Both the preflight credential check and the email send obtain a Gmail access
// token here, using Node's native `https` module rather than the googleapis /
// gaxios client. gaxios v6 performs its fetch through node-fetch v2, which throws
// "Invalid response body ... Premature close" (ERR_STREAM_PREMATURE_CLOSE) when the
// keep-alive connection to `oauth2.googleapis.com` is closed early on recent Node
// runtimes — the failure that was aborting the weekly run. Native `https` is not
// subject to that bug and matches the project's "no external HTTP library" convention.

export const OAUTH_MAX_RETRIES = 3;
export const OAUTH_BASE_DELAY_MS = 2000;

/**
 * A permanent OAuth2 failure (bad/expired/revoked credentials) is not worth retrying —
 * Google surfaces these as `invalid_grant`/`invalid_client`/`unauthorized_client`. Every
 * other failure (e.g. "Premature close", ECONNRESET, socket hang up, timeouts) is a
 * transient transport error where the credentials never got judged, so a retry can succeed.
 */
export function isPermanentOAuthError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes("invalid_grant") ||
    msg.includes("invalid_client") ||
    msg.includes("unauthorized_client")
  );
}

/**
 * Exchanges the refresh token for an access token via a direct POST to Google's OAuth
 * endpoint using Node's native `https` module. A genuine credential rejection comes back
 * as a 400 with an `invalid_grant` body, which `isPermanentOAuthError` detects.
 */
export function exchangeRefreshTokenForAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID!,
    client_secret: process.env.GMAIL_CLIENT_SECRET!,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
    grant_type: "refresh_token",
  }).toString();

  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed: { access_token?: string; error?: string; error_description?: string };
          try {
            parsed = JSON.parse(data);
          } catch {
            reject(new Error(`Unexpected token endpoint response (${res.statusCode}): ${data}`));
            return;
          }
          if (res.statusCode === 200 && parsed.access_token) {
            resolve(parsed.access_token);
          } else {
            // Surface Google's `error` (e.g. invalid_grant) so isPermanentOAuthError can classify it.
            reject(
              new Error(
                `${parsed.error ?? `HTTP ${res.statusCode}`}${parsed.error_description ? `: ${parsed.error_description}` : ""}`
              )
            );
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Token request timed out"));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Runs an OAuth-dependent operation with exponential backoff. Transient transport drops
 * (e.g. "Premature close") are retried; permanent credential errors fail fast. Used to wrap
 * both the preflight token check and the Gmail send so a single dropped connection to
 * Google does not abort the run or silently lose a notification.
 */
export async function withOAuthRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (isPermanentOAuthError(err) || attempt === OAUTH_MAX_RETRIES) {
        throw err;
      }
      const delayMs = OAUTH_BASE_DELAY_MS * 2 ** attempt;
      console.log(
        `  ⏳ ${label} failed (${err}) — retry ${attempt + 1}/${OAUTH_MAX_RETRIES} in ${Math.round(delayMs / 1000)}s...`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
