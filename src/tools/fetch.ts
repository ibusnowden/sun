import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ToolResult } from "../core/types.ts";

/**
 * Reading the web, without becoming a way into the private network.
 *
 * Bash runs under bubblewrap with `--unshare-all` and therefore has no
 * network at all. That is deliberate, and this tool does not change it: `fetch`
 * runs in Sun's own process, so the sandbox stays exactly as tight as it was
 * and the network is reachable only through this one narrow, validated path.
 *
 * The threat this file actually defends against is SSRF. The model chooses the
 * URL, and Sun runs on machines that can usually see things the open internet
 * cannot — a metadata endpoint at 169.254.169.254, a database on localhost, an
 * admin panel on 10.x. So every hostname is resolved and every resulting
 * address is checked against the private ranges, and because a public hostname
 * can redirect to a private one, redirects are followed by hand with the same
 * check applied at every hop.
 *
 * What this does not defend against, stated plainly: DNS rebinding. The name is
 * resolved for the check and resolved again by the actual request, and a server
 * that returns different answers can slip between the two. Closing that needs
 * connection-level pinning that Bun's fetch does not expose.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 200_000;
const DEFAULT_MAX_REDIRECTS = 5;

export interface FetchInput {
  url: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real DNS lookup. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

/** Names that are private regardless of what DNS says about them today. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** `a.b.c.d/bits` ranges that must never be reachable through this tool. */
const PRIVATE_V4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // carrier NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — the cloud metadata endpoint lives here
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    if (value === null) return true; // Unparsable is not provably public.
    return PRIVATE_V4_RANGES.some(([base, bits]) => {
      const baseValue = ipv4ToInt(base);
      if (baseValue === null) return false;
      const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === (baseValue & mask) >>> 0;
    });
  }
  if (family === 6) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
    // An IPv4-mapped address is an IPv4 address wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (normalized === "::1" || normalized === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique local
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // link local
    return false;
  }
  return true;
}

/**
 * Rejects a URL Sun must not request. Returns null when the URL is allowed, or
 * the reason it was refused — which is shown to the model, so it reads as an
 * explanation rather than a bare denial.
 */
export async function checkUrl(
  raw: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Not a valid absolute URL: ${raw}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Only http and https are allowed, not ${url.protocol.replace(":", "")}.`;
  }
  if (url.username || url.password) {
    return "URLs carrying credentials are refused.";
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return `${url.hostname} is a local address.`;
  }
  // `.internal` and `.local` are private by convention everywhere they appear.
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    return `${url.hostname} is a private-network name.`;
  }

  if (isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? `${url.hostname} is a private or loopback address.`
      : null;
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return `Could not resolve ${url.hostname}.`;
  }
  if (addresses.length === 0) return `Could not resolve ${url.hostname}.`;
  // Every answer must be public: one private address is enough to make the
  // request useful to an attacker, whichever one the OS ends up picking.
  const priv = addresses.find((address) => isPrivateAddress(address));
  if (priv) {
    return `${url.hostname} resolves to the private address ${priv}.`;
  }
  return null;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/** Reads at most `maxBytes`, so a huge response cannot exhaust memory. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(buffer), truncated };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/**
 * HTML to something worth spending context on. Markup is most of a page's
 * bytes and almost none of its meaning, so the tags go and the text stays.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+|#\d+);/gi, (match, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key];
      if (key.startsWith("#")) {
        const code = Number(key.slice(1));
        return Number.isInteger(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTextual(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type.includes("x-www-form-urlencoded")
  );
}

/**
 * Fetches a URL and returns its readable text. Never throws: a failed fetch is
 * an ordinary tool result the model can react to, like a failed command.
 */
export async function fetchUrl(
  input: FetchInput,
  options: FetchOptions = {},
): Promise<ToolResult> {
  const request = options.fetchImpl ?? fetch;
  const resolveHost = options.resolveHost ?? defaultResolve;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let current = input.url.trim();
  const visited: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Re-checked at every hop: a public host is free to redirect to a private
    // one, and that redirect is the whole attack.
    const refusal = await checkUrl(current, resolveHost);
    if (refusal) return { ok: false, summary: `Refused: ${refusal}`, output: "" };
    visited.push(current);

    let response: Response;
    try {
      response = await request(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "user-agent": "sun-agent",
          "accept-language": "en",
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: `Could not fetch ${current}: ${detail}`, output: "" };
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === maxRedirects) {
        return {
          ok: false,
          summary: `Too many redirects (${maxRedirects}) from ${input.url}`,
          output: "",
        };
      }
      current = new URL(location, current).toString();
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      return {
        ok: false,
        summary: `${response.status} ${response.statusText || "error"} from ${current}`,
        output: "",
      };
    }
    if (contentType && !isTextual(contentType)) {
      return {
        ok: false,
        summary: `${current} is ${contentType.split(";")[0]}, which has no useful text form.`,
        output: "",
      };
    }

    const { text, truncated } = await readCapped(response, maxBytes);
    const body = /html/i.test(contentType) ? htmlToText(text) : text.trim();
    const redirected = visited.length > 1 ? ` after ${visited.length - 1} redirect(s)` : "";
    const cut = truncated ? `, truncated at ${maxBytes} bytes` : "";
    return {
      ok: true,
      summary: `Fetched ${current}${redirected} (${body.length} chars${cut})`,
      // The page is data, never instructions. The prompt says so too, but the
      // fence is what makes the boundary visible in the transcript.
      output: `<fetched url="${current}">\n${body}\n</fetched>`,
    };
  }

  return { ok: false, summary: `Too many redirects from ${input.url}`, output: "" };
}
