import { describe, expect, test } from "bun:test";
import {
  checkUrl,
  fetchUrl,
  htmlToText,
  isPrivateAddress,
} from "../src/tools/fetch.ts";

/** Resolves every hostname to one address, so the guard is what is tested. */
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses;

const PUBLIC = resolvesTo("93.184.216.34");

function responder(
  pages: Record<string, { status?: number; headers?: Record<string, string>; body?: string }>,
) {
  const seen: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const key = String(url);
    seen.push(key);
    const page = pages[key];
    if (!page) return new Response("missing", { status: 404 });
    return new Response(page.body ?? "", {
      status: page.status ?? 200,
      headers: { "content-type": "text/plain", ...page.headers },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("isPrivateAddress", () => {
  test("blocks loopback, link-local, and the RFC1918 ranges", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata endpoint
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  test("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1", "172.15.255.255"]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  test("blocks IPv6 loopback, unique-local, link-local and v4-mapped private", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  test("treats anything unparsable as private rather than guessing", () => {
    expect(isPrivateAddress("not-an-address")).toBe(true);
  });
});

describe("checkUrl", () => {
  test("allows a public https URL", async () => {
    expect(await checkUrl("https://example.com/docs", PUBLIC)).toBeNull();
  });

  test("refuses non-http schemes", async () => {
    expect(await checkUrl("file:///etc/passwd", PUBLIC)).toContain("Only http and https");
    expect(await checkUrl("ftp://example.com", PUBLIC)).toContain("Only http and https");
  });

  test("refuses a literal private address", async () => {
    expect(await checkUrl("http://169.254.169.254/latest/meta-data/", PUBLIC)).toContain("private");
    expect(await checkUrl("http://127.0.0.1:4000/v1/models", PUBLIC)).toContain("private");
  });

  test("refuses a public name that resolves into the private network", async () => {
    const refusal = await checkUrl("https://evil.test/", resolvesTo("10.1.2.3"));
    expect(refusal).toContain("10.1.2.3");
  });

  test("refuses when any answer is private, not only the first", async () => {
    expect(await checkUrl("https://evil.test/", resolvesTo("93.184.216.34", "127.0.0.1"))).toContain(
      "127.0.0.1",
    );
  });

  test("refuses localhost and private-network suffixes by name", async () => {
    for (const url of [
      "http://localhost:8080/",
      "http://app.localhost/",
      "http://metadata.google.internal/",
      "http://db.internal/",
      "http://printer.local/",
    ]) {
      expect(await checkUrl(url, PUBLIC)).not.toBeNull();
    }
  });

  test("refuses embedded credentials", async () => {
    expect(await checkUrl("https://user:pw@example.com/", PUBLIC)).toContain("credentials");
  });

  test("refuses a name that will not resolve", async () => {
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await checkUrl("https://nope.test/", failing)).toContain("Could not resolve");
    expect(await checkUrl("https://nope.test/", resolvesTo())).toContain("Could not resolve");
  });
});

describe("fetchUrl", () => {
  test("returns page text, fenced as data", async () => {
    const { impl } = responder({
      "https://example.com/": { body: "hello world" },
    });
    const result = await fetchUrl(
      { url: "https://example.com/" },
      { fetchImpl: impl, resolveHost: PUBLIC },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello world");
    expect(result.output).toContain('<fetched url="https://example.com/">');
  });

  test("re-checks every redirect hop, so a public host cannot bounce to a private one", async () => {
    const { impl, seen } = responder({
      "https://example.com/": {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      },
    });
    const result = await fetchUrl(
      { url: "https://example.com/" },
      { fetchImpl: impl, resolveHost: PUBLIC },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("private");
    // The dangerous hop was refused before it was ever requested.
    expect(seen).toEqual(["https://example.com/"]);
  });

  test("follows an ordinary redirect and says it did", async () => {
    const { impl } = responder({
      "https://example.com/": { status: 301, headers: { location: "/final" } },
      "https://example.com/final": { body: "arrived" },
    });
    const result = await fetchUrl(
      { url: "https://example.com/" },
      { fetchImpl: impl, resolveHost: PUBLIC },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("arrived");
    expect(result.summary).toContain("1 redirect");
  });

  test("gives up on a redirect loop", async () => {
    const { impl } = responder({
      "https://example.com/": { status: 302, headers: { location: "https://example.com/" } },
    });
    const result = await fetchUrl(
      { url: "https://example.com/" },
      { fetchImpl: impl, resolveHost: PUBLIC, maxRedirects: 2 },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Too many redirects");
  });

  test("caps the body and says it truncated", async () => {
    const { impl } = responder({
      "https://example.com/": { body: "x".repeat(5_000) },
    });
    const result = await fetchUrl(
      { url: "https://example.com/" },
      { fetchImpl: impl, resolveHost: PUBLIC, maxBytes: 100 },
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("truncated");
    expect(result.output.length).toBeLessThan(400);
  });

  test("reports an HTTP error rather than returning the error page as content", async () => {
    const { impl } = responder({
      "https://example.com/": { status: 500, body: "<h1>oops</h1>" },
    });
    const result = await fetchUrl(
      { url: "https://example.com/" },
      { fetchImpl: impl, resolveHost: PUBLIC },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("500");
    expect(result.output).toBe("");
  });

  test("declines binary content instead of dumping bytes", async () => {
    const { impl } = responder({
      "https://example.com/a.png": {
        headers: { "content-type": "image/png" },
        body: "PNG",
      },
    });
    const result = await fetchUrl(
      { url: "https://example.com/a.png" },
      { fetchImpl: impl, resolveHost: PUBLIC },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("image/png");
  });

  test("never throws when the network fails", async () => {
    const impl = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const result = await fetchUrl(
      { url: "https://example.com/" },
      { fetchImpl: impl, resolveHost: PUBLIC },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("connection reset");
  });

  test("strips markup from HTML so the model pays for text, not tags", async () => {
    const { impl } = responder({
      "https://example.com/": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><head><style>b{}</style></head><body><script>evil()</script><h1>Title</h1><p>Body &amp; more</p></body></html>",
      },
    });
    const result = await fetchUrl(
      { url: "https://example.com/" },
      { fetchImpl: impl, resolveHost: PUBLIC },
    );
    expect(result.output).toContain("Title");
    expect(result.output).toContain("Body & more");
    expect(result.output).not.toContain("evil()");
    expect(result.output).not.toContain("<script>");
  });
});

describe("htmlToText", () => {
  test("drops scripts and styles entirely", () => {
    expect(htmlToText("<style>a{color:red}</style><p>kept</p>")).toBe("kept");
    expect(htmlToText("<script>alert(1)</script><p>kept</p>")).toBe("kept");
  });

  test("keeps block structure as line breaks and decodes entities", () => {
    expect(htmlToText("<p>one</p><p>two</p>")).toBe("one\ntwo");
    expect(htmlToText("<p>a &lt; b &amp;&amp; c &gt; d</p>")).toBe("a < b && c > d");
  });

  test("renders list items as bullets", () => {
    expect(htmlToText("<ul><li>first</li><li>second</li></ul>")).toBe("- first\n- second");
  });
});
