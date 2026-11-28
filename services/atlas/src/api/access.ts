// Cloudflare Access: every request must carry a valid Access token.
//
// Why: the Gateway is also reachable directly on the LAN (10.77.20.60), and
// that path skips Cloudflare Access. Atlas has no login of its own yet, so
// the API checks the token Access adds to each request it lets through
// (`Cf-Access-Jwt-Assertion` header, or the CF_Authorization cookie):
// RS256 signature against the team's published keys, audience = our Access
// application, issuer = our team, not expired. Anything else gets 401.
//
// Env: CF_ACCESS_TEAM_DOMAIN (e.g. jupitertech7.cloudflareaccess.com),
// CF_ACCESS_AUD (the Access application's AUD tag).
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
import { createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from "node:crypto";

export interface AccessIdentity {
  email: string;
  sub: string;
}

type Jwk = JsonWebKeyInput["key"] & { kid?: string; kty?: string };

const b64url = (s: string) => Buffer.from(s, "base64url");

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private readonly issuer: string;
  private readonly aud: string;
  private readonly fetchImpl: typeof fetch;

  constructor(teamDomain: string, aud: string, fetchImpl: typeof fetch = fetch) {
    this.issuer = `https://${teamDomain}`;
    this.aud = aud;
    this.fetchImpl = fetchImpl;
  }

  private async refreshKeys(force = false) {
    // At most once a minute even when forced (an unknown kid shouldn't let
    // anyone make us hammer Cloudflare), otherwise hourly.
    const age = Date.now() - this.fetchedAt;
    if (age < 60_000 || (!force && age < 3_600_000 && this.keys.size > 0)) return;
    this.fetchedAt = Date.now();
    const res = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) if (k.kid && k.kty === "RSA") keys.set(k.kid, createPublicKey({ key: k, format: "jwk" }));
    // (Cloudflare publishes RSA keys only; anything else is ignored.)
    if (keys.size === 0) throw new Error("Access certs: no RSA keys");
    this.keys = keys;
  }

  /** The identity in a valid token, or null (with the reason) if it isn't valid. */
  async verify(token: string | undefined, now = Date.now()): Promise<{ ok: true; id: AccessIdentity } | { ok: false; reason: string }> {
    if (!token) return { ok: false, reason: "no Access token" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed token" };
    let header: { alg?: string; kid?: string };
    let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string };
    try {
      header = JSON.parse(b64url(parts[0]!).toString("utf8"));
      claims = JSON.parse(b64url(parts[1]!).toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed token" };
    }
    if (header.alg !== "RS256" || !header.kid) return { ok: false, reason: "unexpected algorithm" };

    await this.refreshKeys();
    let key = this.keys.get(header.kid);
    if (!key) {
      await this.refreshKeys(true); // keys rotate
      key = this.keys.get(header.kid);
    }
    if (!key) return { ok: false, reason: "unknown signing key" };
    const signed = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]!));
    if (!signed) return { ok: false, reason: "bad signature" };

    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(this.aud)) return { ok: false, reason: "wrong audience" };
    if (claims.iss !== this.issuer) return { ok: false, reason: "wrong issuer" };
    const t = Math.floor(now / 1000);
    if (typeof claims.exp !== "number" || claims.exp < t - 30) return { ok: false, reason: "expired" };
    if (typeof claims.nbf === "number" && claims.nbf > t + 30) return { ok: false, reason: "not yet valid" };
    return { ok: true, id: { email: claims.email ?? "", sub: claims.sub ?? "" } };
  }
}

/** The token from the header Access adds, or its cookie. */
export function tokenFrom(headers: { header: (n: string) => string | undefined }): string | undefined {
  const h = headers.header("cf-access-jwt-assertion");
  if (h) return h;
  const cookie = headers.header("cookie") ?? "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m?.[1];
}
