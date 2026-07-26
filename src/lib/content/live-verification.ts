import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

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
  tlsCa?: string | Buffer;
};

export type PinnedLookup = (
  hostname: string,
  options: { all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | ResolvedAddress[],
    family?: number,
  ) => void,
) => void;

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

function isForbiddenIp(address: string) {
  try {
    const parsed = ipaddr.parse(address.split("%", 1)[0]);
    if (parsed.range() !== "unicast") return true;
    if (parsed instanceof ipaddr.IPv4) return false;

    // Public IPv6 global unicast space is 2000::/3. Requiring both this prefix
    // and ipaddr.js' unicast classification fail-closes transition mechanisms
    // and special-purpose assignments (site-local, benchmarking, ORCHID,
    // mapped/compatible IPv4, documentation, multicast, and reserved ranges).
    return !parsed.match(ipaddr.IPv6.parseCIDR("2000::/3"));
  } catch {
    return true;
  }
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

export function createPinnedLookup(address: string, family: number): PinnedLookup {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

export async function requestDefault(input: NetworkRequestInput): Promise<NetworkResponse> {
  const target = new URL(input.url);
  const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    let activeResponse: IncomingMessage | undefined;
    const deadlineError = () => new Error(`Publication verification timeout after ${input.timeoutMs}ms`);
    const deadlineTimer = setTimeout(() => {
      const error = deadlineError();
      fail(error);
      activeResponse?.destroy(error);
      request?.destroy(error);
    }, Math.max(0, input.timeoutMs));
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const succeed = (response: NetworkResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve(response);
    };

    try {
      request = requester(target, {
        method: "GET",
        headers: {
          "user-agent": "AIPaths Mission Control live-verifier/2.0",
          accept: "text/html,application/xhtml+xml",
          "accept-encoding": "identity",
        },
        lookup: createPinnedLookup(input.address, input.family),
        agent: false,
        ...(input.tlsCa ? { ca: input.tlsCa } : {}),
      }, (response) => {
        activeResponse = response;
        if (settled) {
          response.destroy();
          return;
        }
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
          succeed({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("aborted", () => fail(new Error("Publication response was aborted")));
        response.on("error", fail);
      });
      request.on("error", fail);
      request.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function timeoutError(timeoutMs: number) {
  return new Error(`Publication verification timeout after ${timeoutMs}ms`);
}

function withDeadline<T>(operation: Promise<T>, deadline: number, timeoutMs: number): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.reject(timeoutError(timeoutMs));

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(timeoutError(timeoutMs));
    }, remainingMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
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
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    assertSafeHostname(hostname, allowedHosts);

    const addressFamily = isIP(hostname);
    const addresses = addressFamily
      ? [{ address: hostname, family: addressFamily }]
      : await withDeadline(
        Promise.resolve().then(() => resolveHost(hostname)),
        deadline,
        timeoutMs,
      );
    if (!addresses.length) throw new Error(`DNS returned no addresses for ${hostname}`);
    const forbidden = addresses.find(({ address, family }) => (
      isForbiddenIp(address) || isIP(address) !== family
    ));
    if (forbidden) throw new Error(`DNS returned forbidden or invalid non-public address: ${forbidden.address}`);

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError(timeoutMs);
    const response = await withDeadline(request({
      url: target.toString(),
      address: addresses[0].address,
      family: addresses[0].family,
      timeoutMs: remainingMs,
      maxBodyBytes,
    }), deadline, timeoutMs);

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
