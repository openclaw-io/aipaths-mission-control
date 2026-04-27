type VerifyPublishedContentInput = {
  type: "blog" | "guide" | "doc";
  url: string;
  expectedTitle: string;
  expectedSlug?: string | null;
  expectedDescription?: string | null;
};

type VerifyPublishedContentResult = {
  ok: boolean;
  url: string;
  finalUrl?: string;
  status?: number;
  checks: Record<string, boolean>;
  errors: string[];
};

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

function buildChecks(input: VerifyPublishedContentInput, response: Response, html: string) {
  const finalUrl = response.url || input.url;
  const normalizedHtml = normalize(stripTags(html));
  const normalizedTitle = normalize(input.expectedTitle);
  const expectedPhrase = firstMeaningfulPhrase(input.expectedDescription);
  const normalizedPhrase = expectedPhrase ? normalize(expectedPhrase) : null;
  const slug = input.expectedSlug ? String(input.expectedSlug).trim() : "";

  const checks: Record<string, boolean> = {
    status_200: response.status === 200,
    final_url_ok: !/[/?](login|404|not-found)([/?#]|$)/i.test(finalUrl),
    no_not_found_markers: !NOT_FOUND_MARKERS.some((marker) => normalizedHtml.includes(marker)),
    title_present: normalizedHtml.includes(normalizedTitle),
    slug_present: slug ? decodeURIComponent(finalUrl).includes(slug) || html.includes(slug) : true,
    // Docs/guides pages may render most body content client-side while the
    // server HTML still carries a reliable title/route. Keep the deeper phrase
    // check strict for blogs, but do not block guide/doc reconciliation on it.
    content_phrase_present: input.type === "blog" && normalizedPhrase ? normalizedHtml.includes(normalizedPhrase) : true,
  };

  if (input.type === "guide" || input.type === "doc") {
    checks.guide_path = /\/([a-z]{2}\/)?(docs|guides)\//i.test(finalUrl);
  }

  return { checks, finalUrl };
}

export async function verifyPublishedContent(input: VerifyPublishedContentInput): Promise<VerifyPublishedContentResult> {
  const errors: string[] = [];
  const checks: Record<string, boolean> = {};

  if (!input.url || !/^https?:\/\//i.test(input.url)) {
    return {
      ok: false,
      url: input.url,
      checks: { valid_url: false },
      errors: ["Missing or invalid URL"],
    };
  }

  try {
    const response = await fetch(input.url, {
      redirect: "follow",
      headers: {
        "user-agent": "AIPaths Mission Control live-verifier/1.0",
        accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });
    const html = await response.text();
    const { checks: builtChecks, finalUrl } = buildChecks(input, response, html);
    Object.assign(checks, builtChecks);

    for (const [name, passed] of Object.entries(checks)) {
      if (!passed) errors.push(`Failed check: ${name}`);
    }

    return {
      ok: errors.length === 0,
      url: input.url,
      finalUrl,
      status: response.status,
      checks,
      errors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      url: input.url,
      checks,
      errors: [`Fetch failed: ${message}`],
    };
  }
}
