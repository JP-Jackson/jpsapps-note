/** Identifier and object-key generation. */

/**
 * Entry IDs are generated on the device at capture time (NOTE_SPEC.md §6), so an
 * offline capture is a new row that lands whenever it lands and two devices
 * capturing at once can never collide.
 */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * R2 object key for a photo.
 *
 * img.jpsapps.com is an R2 custom domain, which means the bucket is publicly
 * readable — that is deliberate (§3: serving from cache bypasses the Worker and
 * does not consume request quota), but it means the URL *is* the capability.
 * So keys are unguessable: a random UUID, never a sequential or derived name.
 */
export function photoKey(userId: string, at: Date, ext = "jpg"): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `u/${userId}/${yyyy}/${mm}/${crypto.randomUUID()}.${ext}`;
}

/** 'YYYY-MM-DD' in UTC, the bucketing used by usage_log. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * R2 object key for a document.
 *
 * Documents live in a SEPARATE bucket from photos, and the separation is the point.
 * img.jpsapps.com is a custom domain on the photo bucket, which makes that whole
 * bucket world-readable — so a PDF placed there would be public however carefully
 * the app served it. The file bucket has no custom domain, so the only route to an
 * object is through the Worker, which means through Cloudflare Access.
 *
 * Keys are still unguessable. Belt and braces: an accidental custom domain on this
 * bucket later should not turn every document public overnight.
 */
export function fileKey(userId: string, at: Date = new Date()): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `f/${userId}/${yyyy}/${mm}/${crypto.randomUUID()}`;
}
