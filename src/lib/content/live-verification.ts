import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type VerifyPublishedContentInput = {
  type: "blog" | "guide" | "doc";
  url: string;
  expectedTitle: string;
  expectedSlug?: string | null;
  expectedDescription?: string | null;
};

export type VerifyPublishedContentResult = {
  ok: boolean;
  url: string;
  finalUrl?: string;
  status?: number;
  checks: Record<string, boolean>;
  errors: string[];
};

type ResolvedAddress = { address: string; family: number };
type NetworkResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
type NetworkRequestInput = {
  url: string;
  address: string;
  family: number;
  timeoutMs: number;
  maxBodyBytes: number;
};

export type LiveVerificationOptions = {
  allowedHosts?: string[];
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (input: NetworkRequestInput) => Promise<NetworkResponse>;
};

const DEFAULT_ALLOWED_HOSTS = ["aipaths.academy", "www.aipaths.academy"];
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

const NOT_FOUND_MARKERS = [
  "post not found",
  "guide not found",
  "page not found",
  "not found",
  "404",
  "something went wrong",
  "application error",
];

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function firstMeaningfulPhrase(value?: string | null) {
  if (!value) return null;
  const clean = stripTags(value).replace(/[#*_>`-]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length < 24) return null;
  return clean.slice(0, Math.min(120, clean.length));
}

function buildChecks(input: VerifyPublishedContentInput, status: number, finalUrl: string, html: string) {
  const normalizedHtml = normalize(stripTags(html));
  const normalizedTitle = normalize(input.expectedTitle);
  const expectedPhrase = firstMeaningfulPhrase(input.expectedDescription);
  const normalizedPhrase = expectedPhrase ? normalize(expectedPhrase) : null;
  const slug = input.expectedSlug ? String(input.expectedSlug).trim() : "";

  const checks: Record<string, boolean> = {
    status_200: status === 200,
    final_url_ok: !/[/?](login|404|not-found)([/?#]|$)/i.test(finalUrl),
    no_not_found_markers: !NOT_FOUND_MARKERS.some((marker) => normalizedHtml.includes(marker)),
    title_present: normalizedHtml.includes(normalizedTitle),
    slug_present: slug ? decodeURIComponent(finalUrl).includes(slug) || html.includes(slug) : true,
    content_phrase_present: input.type === "blog" && normalizedPhrase ? normalizedHtml.includes(normalizedPhrase) : true,
  };

  if (input.type === "guide" || input.type === "doc") {
    checks.guide_path = /\/([a-z]{2}\/)?(docs|guides)\//i.test(finalUrl);
  }

  return checks;
}

function configuredAllowedHosts() {
  const configured = process.env.LIVE_VERIFICATION_ALLOWED_HOSTS
    ?.split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_ALLOWED_HOSTS;
}

function hostMatchesAllowlist(hostname: string, allowedHosts: string[]) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase().replace(/\.$/, "");
    return allowed.startsWith("*.")
      ? host.endsWith(allowed.slice(1)) && host !== allowed.slice(2)
      : host === allowed;
  });
}

function ipv4Octets(address: string) {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return octets.length === 4 ? octets : null;
}

function isForbiddenIpv4(address: string) {
  const octets = ipv4Octets(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function mappedIpv4(address: string) {
  const normalized = address.toLowerCase();
  const dotted = normalized.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hex = normalized.match(/^(?:::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isForbiddenIp(address: string) {
  const family = isIP(address);
  if (family === 4) return isForbiddenIpv4(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase().split("%")[0];
  const mapped = mappedIpv4(normalized);
  if (mapped) return isForbiddenIpv4(mapped);
  return normalized === "::"
    || normalized === "::1"
    || /^f[cd]/.test(normalized)
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:");
}

function assertSafeHostname(hostname: string, allowedHosts: string[]) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostMatchesAllowlist(host, allowedHosts)) throw new Error(`Host is not in publication allowlist: ${host}`);
  if (host === "localhost" || host.endsWith(".localhost") || METADATA_HOSTS.has(host) || host.endsWith(".internal")) {
    throw new Error(`Forbidden loopback or metadata host: ${host}`);
  }
  if (isIP(host) && isForbiddenIp(host)) throw new Error(`Forbidden private, loopback, link-local, or metadata address: ${host}`);
}

async function resolveHostDefault(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function requestDefault(input: NetworkRequestInput): Promise<NetworkResponse> {
  const target = new URL(input.url);
  const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = requester(target, {
      method: "GET",
      headers: {
        "user-agent": "AIPaths Mission Control live-verifier/2.0",
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "identity",
      },
      lookup: (_hostname, _options, callback) => callback(null, input.address, input.family),
      agent: false,
    }, (response) => {
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > input.maxBodyBytes) {
        response.destroy();
        fail(new Error(`Response body exceeds configured limit of ${input.maxBodyBytes} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > input.maxBodyBytes) {
          response.destroy();
          fail(new Error(`Response body exceeds configured limit of ${input.maxBodyBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", fail);
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error(`Publication verification timeout after ${input.timeoutMs}ms`)));
    request.on("error", fail);
    request.end();
  });
}

async function fetchSafeHtml(initialUrl: string, options: LiveVerificationOptions) {
  const allowedHosts = (options.allowedHosts || configuredAllowedHosts()).map((host) => host.trim()).filter(Boolean);
  if (!allowedHosts.length) throw new Error("Publication host allowlist is empty");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const resolveHost = options.resolveHost || resolveHostDefault;
  const request = options.request || requestDefault;
  const deadline = Date.now() + timeoutMs;
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const target = new URL(currentUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`Unsupported URL protocol: ${target.protocol}`);
    if (target.username || target.password) throw new Error("Publication URL credentials are forbidden");
    assertSafeHostname(target.hostname, allowedHosts);

    const addresses = isIP(target.hostname)
      ? [{ address: target.hostname, family: isIP(target.hostname) }]
      : await resolveHost(target.hostname);
    if (!addresses.length) throw new Error(`DNS returned no addresses for ${target.hostname}`);
    const forbidden = addresses.find(({ address }) => isForbiddenIp(address));
    if (forbidden) throw new Error(`DNS returned forbidden private, loopback, link-local, or metadata address: ${forbidden.address}`);

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`Publication verification timeout after ${timeoutMs}ms`);
    const response = await request({
      url: target.toString(),
      address: addresses[0].address,
      family: addresses[0].family,
      timeoutMs: remainingMs,
      maxBodyBytes,
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { ...response, finalUrl: target.toString() };
    }
    const location = headerValue(response.headers, "location");
    if (!location) throw new Error(`Redirect ${response.status} is missing Location`);
    if (redirectCount === maxRedirects) throw new Error(`Too many redirects (max ${maxRedirects})`);
    currentUrl = new URL(location, target).toString();
  }
  throw new Error(`Too many redirects (max ${maxRedirects})`);
}

export async function verifyPublishedContent(
  input: VerifyPublishedContentInput,
  options: LiveVerificationOptions = {},
): Promise<VerifyPublishedContentResult> {
  const errors: string[] = [];
  const checks: Record<string, boolean> = {};

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, url: input.url, checks: { valid_url: false }, errors: ["Missing or invalid URL"] };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, url: input.url, checks: { valid_url: false }, errors: ["Missing or invalid URL"] };
  }

  try {
    const response = await fetchSafeHtml(parsed.toString(), options);
    Object.assign(checks, buildChecks(input, response.status, response.finalUrl, response.body));
    for (const [name, passed] of Object.entries(checks)) {
      if (!passed) errors.push(`Failed check: ${name}`);
    }
    return {
      ok: errors.length === 0,
      url: input.url,
      finalUrl: response.finalUrl,
      status: response.status,
      checks,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, url: input.url, checks, errors: [`Fetch failed: ${message}`] };
  }
}
