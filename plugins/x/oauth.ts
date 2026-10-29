// OAuth 1.0a user-context signing for the X API (HMAC-SHA1 via node:crypto). Pure functions, no Yaypost state.
import { createHmac, randomBytes } from "node:crypto";

/** RFC 3986 percent-encoding (encodeURIComponent leaves !'()* alone). */
export const percentEncode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface OAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `Authorization: OAuth …` for one request. The signature covers the oauth_* params, the URL's query params and
 * any form-encoded body fields; JSON bodies are not signed.
 */
export function oauthHeader(
  method: string,
  url: string,
  creds: OAuthCredentials,
  opts: { form?: Record<string, string>; nonce?: string; timestamp?: string } = {},
): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const params = [...Object.entries(oauth), ...u.searchParams, ...Object.entries(opts.form ?? {})]
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => cmp(ak, bk) || cmp(av, bv))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseString = [method.toUpperCase(), percentEncode(`${u.protocol}//${u.host}${u.pathname}`), percentEncode(params)].join("&");
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey).update(baseString).digest("base64");
  return "OAuth " + Object.entries(oauth).map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`).join(", ");
}
