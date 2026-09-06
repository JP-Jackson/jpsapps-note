export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;

  ENVIRONMENT: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  IMG_BASE: string;

  /** Local dev only. Ignored unless ENVIRONMENT === 'development'. */
  DEV_EMAIL?: string;
}
