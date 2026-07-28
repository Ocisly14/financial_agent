import { createSign, randomBytes } from "node:crypto";

export type CoinbaseCredentials = {
  apiKeyName: string;   // e.g. "organizations/.../apiKeys/..."
  apiKeySecret: string; // EC private key PEM
};

function base64url(s: string): string {
  return Buffer.from(s, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlFromBuffer(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildCoinbaseJwt(
  credentials: CoinbaseCredentials,
  method: string,
  path: string,
): string {
  const header = {
    alg: "ES256",
    kid: credentials.apiKeyName,
    nonce: randomBytes(16).toString("hex"),
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    sub: credentials.apiKeyName,
    uri: `${method} api.coinbase.com${path}`,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const sign = createSign("SHA256");
  sign.update(signingInput);
  sign.end();

  const signatureDer = sign.sign(credentials.apiKeySecret);
  const signatureB64url = base64urlFromBuffer(signatureDer);

  return `${signingInput}.${signatureB64url}`;
}

export async function coinbaseFetch(
  credentials: CoinbaseCredentials,
  method: string,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const jwt = buildCoinbaseJwt(credentials, method, path);
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  const url = `https://api.coinbase.com${path}${query}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Coinbase API error ${response.status}: ${body}`);
  }

  return response.json();
}
