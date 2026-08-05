import test from "node:test";
import assert from "node:assert/strict";
import {
  clearLinkPreviewCache,
  fetchLinkPreview,
  isAllowedPreviewUrl,
  isBlockedAddress,
  parsePreviewMetadata,
} from "../linkPreview.ts";

test("blocks private, loopback and metadata address space", () => {
  for (const address of [
    "127.0.0.1", "10.0.0.5", "172.16.9.1", "192.168.1.1",
    "169.254.169.254", // cloud instance metadata
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, `${address} must be allowed`);
  }
});

test("rejects non-http schemes, credentials and internal hostnames", () => {
  assert.equal(isAllowedPreviewUrl("https://finance.yahoo.com/a"), true);
  assert.equal(isAllowedPreviewUrl("http://example.com"), true);
  assert.equal(isAllowedPreviewUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedPreviewUrl("ftp://example.com"), false);
  assert.equal(isAllowedPreviewUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedPreviewUrl("https://user:pw@example.com"), false);
  assert.equal(isAllowedPreviewUrl("http://localhost:8080/admin"), false);
  assert.equal(isAllowedPreviewUrl("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isAllowedPreviewUrl("not a url"), false);
});

test("extracts open graph fields and resolves a relative image", () => {
  const html = `<html><head>
    <meta property="og:site_name" content="Yahoo Finance">
    <meta property="og:title" content="Nvidia Reportedly Moves to Backstop $250 Billion">
    <meta property="og:description" content="Shares fell 3.9% &amp; CDS widened.">
    <meta property="og:image" content="/img/card.png">
  </head></html>`;
  const preview = parsePreviewMetadata(html, "https://finance.yahoo.com/news/a.html");
  assert.equal(preview.siteName, "Yahoo Finance");
  assert.equal(preview.title, "Nvidia Reportedly Moves to Backstop $250 Billion");
  assert.equal(preview.description, "Shares fell 3.9% & CDS widened.");
  assert.equal(preview.image, "https://finance.yahoo.com/img/card.png");
});

test("falls back to <title> and tolerates a missing image", () => {
  const preview = parsePreviewMetadata("<html><head><title>Plain page</title></head>", "https://example.com/x");
  assert.equal(preview.title, "Plain page");
  assert.equal(preview.image, undefined);
  assert.equal(preview.url, "https://example.com/x");
});

test("ignores a javascript: og:image", () => {
  const html = `<meta property="og:image" content="javascript:alert(1)">`;
  assert.equal(parsePreviewMetadata(html, "https://example.com").image, undefined);
});

test("a redirect into private space is refused", async () => {
  clearLinkPreviewCache();
  const fetchImpl = (async (url: string | URL | Request) => {
    assert.equal(String(url), "https://8.8.8.8/a");
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
  }) as unknown as typeof fetch;
  assert.equal(await fetchLinkPreview("https://8.8.8.8/a", fetchImpl), null);
});

test("a non-html response yields no preview", async () => {
  const fetchImpl = (async () =>
    new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } })
  ) as unknown as typeof fetch;
  assert.equal(await fetchLinkPreview("https://8.8.8.8/a.pdf", fetchImpl), null);
});

test("reads metadata from a successful html response", async () => {
  const fetchImpl = (async () =>
    new Response(
      `<html><head><meta property="og:title" content="Hello"><meta property="og:image" content="https://cdn.example.com/i.png"></head><body>…</body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    )
  ) as unknown as typeof fetch;
  const preview = await fetchLinkPreview("https://8.8.8.8/a", fetchImpl);
  assert.equal(preview?.title, "Hello");
  assert.equal(preview?.image, "https://cdn.example.com/i.png");
});
