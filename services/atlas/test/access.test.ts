// Cloudflare Access token check (src/api/access.ts) with a locally made key.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, test } from "node:test";
import { AccessVerifier, tokenFrom } from "../src/api/access.ts";

const TEAM = "example.cloudflareaccess.com";
const AUD = "aud-tag-123";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = 1_800_000_000;
function token(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: typeof privateKey; alg?: string } = {}) {
  const head = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = b64({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, iat: now, email: "me@example.net", sub: "u1", ...claims });
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

let certFetches = 0;
const fakeFetch = (async (url: string | URL | Request) => {
  assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
  certFetches++;
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
}) as typeof fetch;

describe("AccessVerifier", () => {
  const v = new AccessVerifier(TEAM, AUD, fakeFetch);
  const at = now * 1000;

  test("accepts a valid token and returns the identity", async () => {
    assert.deepEqual(await v.verify(token(), at), { ok: true, id: { email: "me@example.net", sub: "u1" } });
  });

  test("rejects everything else", async () => {
    const cases: [string | undefined, string][] = [
      [undefined, "no Access token"],
      ["abc", "malformed token"],
      [token({ aud: ["someone-else"] }), "wrong audience"],
      [token({ iss: "https://evil.cloudflareaccess.com" }), "wrong issuer"],
      [token({ exp: now - 3600 }), "expired"],
      [token({ nbf: now + 3600 }), "not yet valid"],
      [token({}, { key: other.privateKey }), "bad signature"],
      [token({}, { alg: "HS256" }), "unexpected algorithm"],
    ];
    for (const [t, reason] of cases) assert.deepEqual(await v.verify(t, at), { ok: false, reason }, reason);
    // A tampered payload with the original signature.
    const [h, , s] = token().split(".");
    assert.deepEqual(await v.verify(`${h}.${b64({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, email: "admin@evil" })}.${s}`, at), {
      ok: false,
      reason: "bad signature",
    });
  });

  test("an unknown key id refetches at most once a minute", async () => {
    const before = certFetches;
    assert.deepEqual(await v.verify(token({}, { kid: "nope" }), at), { ok: false, reason: "unknown signing key" });
    assert.deepEqual(await v.verify(token({}, { kid: "nope" }), at), { ok: false, reason: "unknown signing key" });
    assert.ok(certFetches - before <= 1);
  });
});

describe("tokenFrom", () => {
  const h = (m: Record<string, string>) => ({ header: (n: string) => m[n] });
  test("header first, then the CF_Authorization cookie", () => {
    assert.equal(tokenFrom(h({ "cf-access-jwt-assertion": "a.b.c" })), "a.b.c");
    assert.equal(tokenFrom(h({ cookie: "x=1; CF_Authorization=d.e.f; y=2" })), "d.e.f");
    assert.equal(tokenFrom(h({})), undefined);
  });
});
