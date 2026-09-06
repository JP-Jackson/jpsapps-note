/**
 * Authentication.
 *
 * Cloudflare Access sits in front of the app and handles login (NOTE_SPEC.md §7).
 * By the time a request reaches this Worker, Access has already verified who the
 * user is and attached a signed JWT. Our job is only to verify that signature —
 * never to trust the header blindly, because the Worker is reachable directly on
 * workers.dev and an unverified header is an open door.
 *
 * Everything auth-related is behind `authenticate()`. If Access is ever replaced
 * (a Resend magic link, a hand-rolled WebAuthn flow), this file changes and nothing
 * else does.
 *
 * Note on passkeys: the spec says "passkeys on top" of Access, but Access has no
 * WebAuthn login method — its options are the Cloudflare IdP, one-time PIN, or a
 * third-party IdP. The route to biometric unlock with no code is the Cloudflare IdP
 * login method with a passkey on the Cloudflare account itself. See README.
 */

import type { Env } from "./env";
import { Db, type QueryCost, type UserRow } from "./db";

export interface Session {
  userId: string;
  email: string;
  user: UserRow;
  /** Row cost of the lookup that built this session, for the caller to meter. */
  cost: QueryCost;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
  }
}

interface Jwk extends JsonWebKey {
  kid: string;
}

interface AccessClaims {
  aud: string | string[];
  iss: string;
  exp: number;
  iat: number;
  sub: string;
  email?: string;
  identity_nonce?: string;
}

// JWKS is stable; cache it per isolate so a warm Worker does no network I/O.
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment))) as T;
}

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const fresh = jwksCache && jwksCache.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh && jwksCache) return jwksCache.keys;

  const res = await fetch(url);
  if (!res.ok) throw new AuthError(`Could not fetch Access signing keys (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!body.keys?.length) throw new AuthError("Access signing keys were empty");

  jwksCache = { url, keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/** Verify an Access JWT's signature and claims. Throws AuthError on any failure. */
export async function verifyAccessJwt(token: string, env: Env): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Malformed Access token");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJson<{ kid?: string; alg?: string }>(headerB64);
  if (header.alg !== "RS256") throw new AuthError(`Unexpected token algorithm: ${header.alg}`);
  if (!header.kid) throw new AuthError("Access token has no key id");

  const jwk = (await getJwks(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError("Access token signed by an unknown key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) throw new AuthError("Access token signature is invalid");

  const claims = decodeJson<AccessClaims>(payloadB64);

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) throw new AuthError("Access token has expired");

  // The audience tag binds the token to *this* Access application. Without this
  // check, a token minted for any other app on the same team would be accepted.
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AuthError("Access token is for a different application");

  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) {
    throw new AuthError("Access token issued by a different team");
  }
  if (!claims.email) throw new AuthError("Access token carries no email");

  return claims;
}

/**
 * Resolve the caller to a Session, or throw AuthError.
 *
 * In development there is no Access in front of `wrangler dev`, so DEV_EMAIL stands
 * in. That path is gated on ENVIRONMENT === 'development' and is unreachable in
 * production, where ENVIRONMENT is set in wrangler.jsonc.
 */
export async function authenticate(request: Request, env: Env): Promise<Session> {
  let email: string;

  if (env.ENVIRONMENT === "development" && env.DEV_EMAIL) {
    email = env.DEV_EMAIL;
  } else {
    const token =
      request.headers.get("Cf-Access-Jwt-Assertion") ??
      readCookie(request.headers.get("Cookie"), "CF_Authorization");
    if (!token) throw new AuthError("No Access token on request");
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      throw new AuthError("Access is not configured on this Worker", 403);
    }
    email = (await verifyAccessJwt(token, env)).email!;
  }

  const allowed = env.ALLOWED_EMAILS.split(",");
  const { user, cost } = await Db.resolveUser(env.DB, email, allowed);
  if (!user) throw new AuthError(`${email} is not provisioned for this app`, 403);

  return { userId: user.id, email: user.email, user, cost };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
