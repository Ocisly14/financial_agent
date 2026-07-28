import { createHmac } from "node:crypto";

export type BinanceCredentials = {
  apiKey: string;
  apiSecret: string;
};

export async function binanceFetch(
  credentials: BinanceCredentials,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<unknown> {
  const allParams: Record<string, string> = {};

  for (const [k, v] of Object.entries(params)) {
    allParams[k] = String(v);
  }

  allParams["timestamp"] = String(Date.now());
  allParams["recvWindow"] = "10000";

  const queryString = new URLSearchParams(allParams).toString();

  const hmac = createHmac("sha256", credentials.apiSecret);
  hmac.update(queryString);
  const signature = hmac.digest("hex");

  allParams["signature"] = signature;

  const finalQuery = new URLSearchParams(allParams).toString();
  const url = `https://api.binance.com${path}?${finalQuery}`;

  const response = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": credentials.apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Binance API error ${response.status}: ${body}`);
  }

  return response.json();
}
