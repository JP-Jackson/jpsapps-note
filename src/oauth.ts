/**
 * OAuth 2.1 for the MCP connector (NOTE_SPEC.md §8a).
 *
 * Cloudflare Access authenticates a browser. Claude is not a browser — it connects
 * from Anthropic's cloud with no way to complete an Access login — so /mcp is
 * excluded from the Access application and authorises itself with a bearer token
 * instead. This file is where that token comes from.
 *
 * Access still decides who may grant one. /oauth/authorize stays *inside* the
 * Access application, so the consent screen is only ever reachable by someone
 * Access has already logged in. That is the whole security model in one line:
 * Access says who you are, this file turns that into a token a server can carry.
 *
 * Written out rather than pulled from @cloudflare/workers-oauth-provider, which
 * keeps its state in Workers KV. That would put authorisation — the decision about
 * who may read the log — outside src/db.ts, and "all database access in one module"
 * is a rule worth more than the code it saves. No SQL here either; every read and
 * write goes through Db.
 */

import { Db } from "./db";

/** Refreshed roughly monthly; a stolen token is not useful forever. */
const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/** Tokens are stored as hashes, never in the clear — see migration 0003. */
async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// -------------------------------------------------------------- client identity

interface ClientInfo {
  name: string | null;
  redirect_uris: string[];
}

/**
 * A registered client, remembered by signing it into its own client_id.
 *
 * Dynamic registration (RFC 7591) is unauthenticated by design, so a clients table
 * would be a table anyone on the internet could write rows into — and one that has
 * no user_id, because at registration time there is no user yet. Signing the
 * details into the id instead means registration stores nothing, cannot be spammed,
 * and still cannot be forged: without the secret, no attacker can mint a client_id
 * that carries a redirect_uri of their choosing.
 */
async function signClient(info: ClientInfo, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(info)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

async function verifyClient(clientId: string, secret: string): Promise<ClientInfo | null> {
  const [payload, sig] = clientId.split(".");
  if (!payload || !sig) return null;

  const expected = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  if (b64url(expected) !== sig) return null;

  try {
    const info = JSON.parse(fromB64url(payload)) as ClientInfo;
    return Array.isArray(info.redirect_uris) ? info : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- responses

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...CORS, ...headers } });

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

// -------------------------------------------------------------------- metadata

/** RFC 8414. How a client discovers where to register, authorise and exchange. */
export function authServerMetadata(origin: string): Response {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: ["note"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

/** RFC 9728. Points a client that got a 401 from /mcp at the server above. */
export function protectedResourceMetadata(origin: string): Response {
  return json({
    resource: origin,
    authorization_servers: [origin],
    scopes_supported: ["note"],
    bearer_methods_supported: ["header"],
  });
}

/** The 401 that starts the whole flow: "you need a token, and here is where from". */
export function unauthorized(origin: string): Response {
  return json({ error: "invalid_token" }, 401, {
    "www-authenticate":
      `Bearer realm="note", error="invalid_token", ` +
      `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  });
}

// ---------------------------------------------------------------- registration

export async function handleRegister(request: Request, secret: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }

  const uris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (!uris.length) {
    return oauthError("invalid_redirect_uri", "At least one redirect_uri is required");
  }
  // Redirecting a code over plain HTTP hands it to anyone on the path. Loopback is
  // the exception every OAuth client relies on for local development.
  for (const u of uris) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return oauthError("invalid_redirect_uri", `Not a URL: ${u}`);
    }
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !loopback) {
      return oauthError("invalid_redirect_uri", "redirect_uri must be https");
    }
  }

  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 80) : null;
  const clientId = await signClient({ name, redirect_uris: uris }, secret);

  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // No secret: a public client proves itself with PKCE instead.
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

// ------------------------------------------------------------------- authorize

interface AuthzRequest {
  client: ClientInfo;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}

/** Shared by the GET that renders consent and the POST that acts on it. */
async function readAuthzRequest(
  params: URLSearchParams,
  secret: string,
): Promise<AuthzRequest | Response> {
  const clientId = params.get("client_id") ?? "";
  const client = await verifyClient(clientId, secret);
  if (!client) return oauthError("invalid_client", "Unknown or tampered client_id", 401);

  // Validated against the registration, not merely echoed: an open redirect here
  // would hand the code to whoever asked for it.
  const redirectUri = params.get("redirect_uri") ?? client.redirect_uris[0] ?? "";
  if (!client.redirect_uris.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri was not registered");
  }

  if ((params.get("response_type") ?? "code") !== "code") {
    return oauthError("unsupported_response_type", "Only the code flow is supported");
  }

  const challenge = params.get("code_challenge") ?? "";
  if (!challenge || params.get("code_challenge_method") !== "S256") {
    return oauthError("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }

  return { client, clientId, redirectUri, state: params.get("state") ?? "", challenge };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * The consent screen.
 *
 * Plain server-rendered HTML rather than a route in the app shell: it has to work
 * before any token exists, it is seen roughly once a year, and a page that grants
 * access to everything should look like a decision, not like a screen you swipe past.
 */
function consentPage(a: AuthzRequest, email: string, params: URLSearchParams): Response {
  const host = escapeHtml(new URL(a.redirectUri).host);
  const name = escapeHtml(a.client.name ?? "An application");
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope"]
    .map((k) => {
      const v = k === "redirect_uri" ? a.redirectUri : params.get(k);
      return v ? `<input type="hidden" name="${k}" value="${escapeHtml(v)}">` : "";
    })
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Connect to Note</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--navy:#16222E;--blue:#2C7BC4;--bg:#E6E9EC;--card:#FFF;--ink:#121A22;--ink-2:#586573;--line:#D2D8DE}
  @media (prefers-color-scheme:dark){
    :root{--bg:#171B20;--card:#222831;--ink:#E6EBF0;--ink-2:#94A1AE;--line:#323A45}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:400 16px/1.55 Inter,system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;
    max-width:400px;width:100%;padding:26px 22px 22px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}
  .tile{width:36px;height:36px;border-radius:10px;background:var(--navy);color:#fff;
    display:grid;place-items:center;font:600 15px/1 Inter,sans-serif}
  .word{font:600 34px/1 Caveat,cursive;color:var(--ink)}
  h1{font-size:19px;font-weight:600;margin:0 0 6px}
  p{margin:0 0 14px;color:var(--ink-2);font-size:14px}
  ul{margin:0 0 18px;padding-left:18px;color:var(--ink-2);font-size:14px}
  li{margin:3px 0}
  .who{font-size:13px;color:var(--ink-2);border-top:1px solid var(--line);
    padding-top:12px;margin-top:4px}
  .row{display:flex;gap:10px;margin-top:18px}
  button{flex:1;font:600 15px/1 Inter,sans-serif;padding:15px 12px;border-radius:12px;
    border:1px solid var(--line);cursor:pointer}
  .allow{background:var(--blue);color:#fff;border-color:var(--blue);box-shadow:0 4px 0 #1B5486}
  .allow:active{transform:translateY(4px);box-shadow:none}
  .deny{background:var(--card);color:var(--ink)}
</style></head>
<body>
  <form class="card" method="POST" action="/oauth/authorize">
    <div class="brand"><div class="tile">JP</div><div class="word">Note</div></div>
    <h1>${name} wants to connect</h1>
    <p>It will be redirected to <strong>${host}</strong>. Once connected it can:</p>
    <ul>
      <li>Read your log, open items and the things you track</li>
      <li>Add notes and things on your behalf</li>
    </ul>
    <p>It cannot edit or delete anything already written, and you can disconnect it
       from Settings at any time.</p>
    <div class="who">Signed in as ${escapeHtml(email)}</div>
    ${hidden}
    <div class="row">
      <button class="deny" name="decision" value="deny" type="submit">Cancel</button>
      <button class="allow" name="decision" value="allow" type="submit">Connect</button>
    </div>
  </form>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleAuthorizeGet(
  request: Request,
  secret: string,
  email: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const a = await readAuthzRequest(params, secret);
  return a instanceof Response ? a : consentPage(a, email, params);
}

export async function handleAuthorizePost(
  request: Request,
  secret: string,
  db: Db,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  // The Access cookie would ride along on a cross-site form post, so the Origin
  // header is what stops another page from silently pressing Connect for you.
  if (request.headers.get("origin") !== origin) {
    return oauthError("invalid_request", "Cross-origin form submission", 403);
  }

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const [k, v] of form) if (typeof v === "string") params.set(k, v);

  const a = await readAuthzRequest(params, secret);
  if (a instanceof Response) return a;

  const back = new URL(a.redirectUri);
  if (a.state) back.searchParams.set("state", a.state);

  if (params.get("decision") !== "allow") {
    back.searchParams.set("error", "access_denied");
    return Response.redirect(back.toString(), 302);
  }

  const code = randomToken();
  await db.saveAuthCode({
    codeHash: await sha256(code),
    clientId: a.clientId,
    clientName: a.client.name,
    redirectUri: a.redirectUri,
    codeChallenge: a.challenge,
  });

  back.searchParams.set("code", code);
  return Response.redirect(back.toString(), 302);
}

// ----------------------------------------------------------------------- token

async function issue(
  d1: D1Database,
  t: { userId: string; clientId: string; clientName: string | null },
): Promise<Response> {
  const access = randomToken();
  const refresh = randomToken();
  const now = Date.now();

  await Db.issueTokens(d1, {
    userId: t.userId,
    clientId: t.clientId,
    clientName: t.clientName,
    accessHash: await sha256(access),
    accessExpiresAt: now + ACCESS_TTL_MS,
    refreshHash: await sha256(refresh),
    refreshExpiresAt: now + REFRESH_TTL_MS,
  });

  return json(
    {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: "note",
    },
    200,
    { "cache-control": "no-store" },
  );
}

export async function handleToken(
  request: Request,
  d1: D1Database,
  secret: string,
): Promise<Response> {
  const form = await request.formData();
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };

  const clientId = get("client_id");
  const grant = get("grant_type");

  if (grant === "refresh_token") {
    const presented = get("refresh_token");
    const hash = await sha256(presented);
    const row = await Db.findToken(d1, hash, "refresh");
    if (!row) return oauthError("invalid_grant", "That refresh token is not valid", 400);
    if (clientId && clientId !== row.client_id) {
      return oauthError("invalid_grant", "Refresh token belongs to another client", 400);
    }
    // Rotate: the old one dies as the new pair is born.
    await Db.revokeTokenHash(d1, hash);
    return issue(d1, { userId: row.user_id, clientId: row.client_id, clientName: row.client_name });
  }

  if (grant !== "authorization_code") {
    return oauthError("unsupported_grant_type", `Cannot do ${grant || "(none)"}`);
  }

  const client = await verifyClient(clientId, secret);
  if (!client) return oauthError("invalid_client", "Unknown or tampered client_id", 401);

  const row = await Db.consumeAuthCode(d1, await sha256(get("code")));
  if (!row) return oauthError("invalid_grant", "That code is unknown, used or expired");
  if (row.client_id !== clientId) {
    return oauthError("invalid_grant", "Code was issued to another client");
  }
  if (get("redirect_uri") && get("redirect_uri") !== row.redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri does not match the one authorised");
  }

  // PKCE: the verifier is the secret the client kept; only its hash was ever sent.
  const verifier = get("code_verifier");
  if (!verifier || (await sha256(verifier)) !== row.code_challenge) {
    return oauthError("invalid_grant", "code_verifier does not match the challenge");
  }

  return issue(d1, { userId: row.user_id, clientId: row.client_id, clientName: row.client_name });
}

/** RFC 7009, so a client can hand its own token back when it disconnects. */
export async function handleRevoke(request: Request, d1: D1Database): Promise<Response> {
  const form = await request.formData();
  const token = form.get("token");
  if (typeof token === "string" && token) await Db.revokeTokenHash(d1, await sha256(token));
  // Always 200: telling a caller whether a token existed is telling it too much.
  return json({}, 200);
}

// ------------------------------------------------------------------- bearer auth

/** The user a bearer token belongs to, or null if it is missing, stale or revoked. */
export async function bearerUser(request: Request, d1: D1Database): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const row = await Db.findToken(d1, await sha256(token), "access");
  return row?.user_id ?? null;
}

export { CORS };
