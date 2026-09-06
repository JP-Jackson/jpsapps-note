export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;

  ENVIRONMENT: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  IMG_BASE: string;

  /**
   * Signing key for MCP client ids and nothing else. A Worker secret, set with
   * `wrangler secret put OAUTH_SECRET` — never in wrangler.jsonc, which is committed.
   */
  OAUTH_SECRET?: string;

  /** Local dev only. Ignored unless ENVIRONMENT === 'development'. */
  DEV_EMAIL?: string;
}
