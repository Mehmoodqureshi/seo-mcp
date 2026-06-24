/**
 * src/seo/audit.ts — the on-page / technical SEO analysis logic.
 *
 * Pure functions over fetched HTML (parsed with cheerio). Each returns a plain
 * object the tool layer serializes to JSON. No network here except where noted.
 */
import * as cheerio from 'cheerio';
import { fetchText, statusOf, normalizeUrl, originOf, mapPool } from './http';
import { pageSpeed, type Strategy } from './pagespeed';

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Recommended approach to resolve the issue. */
  fix?: string;
}

export interface AuditOptions {
  /** Also run PageSpeed Insights and attach lab/field metrics under `pagespeed`. */
  pagespeed?: boolean;
  /** PSI strategy when `pagespeed` is enabled (default "mobile"). */
  strategy?: Strategy;
  /** Pull the full GTmetrix-style detail layer (all categories, diagnostics, suggestions). */
  detail?: boolean;
}

/** Full single-page on-page audit. */
export async function auditPage(rawUrl: string, opts: AuditOptions = {}) {
  const url = normalizeUrl(rawUrl);
  // Kick off the (slower) PageSpeed call concurrently with the page fetch so the
  // combined audit isn't fetch-then-PSI serialized.
  const psiPromise = opts.pagespeed ? pageSpeed(url, opts.strategy ?? 'mobile', { detail: opts.detail }) : null;
  const res = await fetchText(url);
  const issues: Issue[] = [];

  if (!res.ok)
    issues.push({ severity: 'error', message: `HTTP ${res.status} — page did not return 200 OK`, fix: 'Return a 200 for live URLs. If the page is gone, 301-redirect it to the best replacement and remove it from the sitemap; investigate 5xx as a server/hosting problem.' });
  if (!/text\/html/i.test(res.contentType)) {
    issues.push({ severity: 'warning', message: `Content-Type is "${res.contentType || 'unknown'}", not text/html`, fix: 'Serve HTML pages with "Content-Type: text/html; charset=UTF-8" so crawlers parse them as pages.' });
  }

  const $ = cheerio.load(res.body);

  // Title
  const title = $('head > title').first().text().trim();
  if (!title) issues.push({ severity: 'error', message: 'Missing <title>', fix: 'Add a unique, descriptive <title> (~50–60 chars) leading with the page\'s primary keyword.' });
  else if (title.length > 60) issues.push({ severity: 'warning', message: `Title is ${title.length} chars (>60 may truncate in SERPs)`, fix: 'Trim the title to ~50–60 characters so it isn\'t cut off in search results; front-load the key term.' });
  else if (title.length < 30) issues.push({ severity: 'info', message: `Title is ${title.length} chars (<30 is short)`, fix: 'Expand the title toward ~50–60 chars with relevant keywords/brand to use the full SERP width.' });

  // Meta description
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? '';
  if (!metaDescription) issues.push({ severity: 'warning', message: 'Missing meta description', fix: 'Add a compelling 140–160 char meta description that summarizes the page and includes the target keyword to improve click-through.' });
  else if (metaDescription.length > 160) issues.push({ severity: 'warning', message: `Meta description is ${metaDescription.length} chars (>160 may truncate)`, fix: 'Tighten the description to ≤160 chars so it isn\'t truncated; put the most important wording first.' });
  else if (metaDescription.length < 50) issues.push({ severity: 'info', message: `Meta description is ${metaDescription.length} chars (<50 is short)`, fix: 'Expand toward 140–160 chars with a clear value proposition and the target keyword.' });

  // Core head signals
  const canonical = $('link[rel="canonical"]').attr('href')?.trim() ?? null;
  if (!canonical) issues.push({ severity: 'info', message: 'No canonical link', fix: 'Add <link rel="canonical"> pointing to the preferred URL to consolidate duplicates and signal the canonical version.' });
  const metaRobots = $('meta[name="robots"]').attr('content')?.trim() ?? null;
  if (metaRobots && /noindex/i.test(metaRobots)) issues.push({ severity: 'error', message: `Page is noindex (meta robots="${metaRobots}")`, fix: 'If this page should rank, remove the noindex directive. If it is intentionally hidden (thank-you/admin page), this is fine — ignore.' });
  const viewport = $('meta[name="viewport"]').attr('content')?.trim() ?? null;
  if (!viewport) issues.push({ severity: 'warning', message: 'No viewport meta — not mobile-friendly', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so the page renders responsively on mobile.' });
  const charset = $('meta[charset]').attr('charset')?.trim() ?? $('meta[http-equiv="Content-Type"]').attr('content') ?? null;
  const lang = $('html').attr('lang')?.trim() ?? null;
  if (!lang) issues.push({ severity: 'info', message: 'No <html lang> attribute', fix: 'Set <html lang="en"> (or the correct locale) to help search engines and assistive tech understand the language.' });

  // Open Graph + Twitter
  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const k = $(el).attr('property')!;
    og[k] = $(el).attr('content') ?? '';
  });
  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const k = $(el).attr('name')!;
    twitter[k] = $(el).attr('content') ?? '';
  });
  if (Object.keys(og).length === 0) issues.push({ severity: 'info', message: 'No Open Graph tags (worse social sharing previews)', fix: 'Add og:title, og:description, og:image (1200×630), og:url and og:type so shared links show a rich preview card.' });

  // Headings
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const headingCounts: Record<string, number> = {};
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) headingCounts[tag] = $(tag).length;
  if (h1s.length === 0) issues.push({ severity: 'error', message: 'No <h1> on the page', fix: 'Add exactly one <h1> that states the page\'s main topic, then use <h2>/<h3> for sub-sections in order.' });
  else if (h1s.length > 1) issues.push({ severity: 'warning', message: `${h1s.length} <h1> tags (prefer exactly one)`, fix: 'Keep a single <h1> as the page\'s main heading; demote the others to <h2>/<h3> to form a clean outline.' });

  // Word count (visible body text). Clone the body and drop non-content nodes
  // first so <script>/<style>/etc. contents don't inflate the count.
  const $body = $('body').clone();
  $body.find('script, style, noscript, template, svg').remove();
  const bodyText = $body.text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;
  if (wordCount < 300) issues.push({ severity: 'info', message: `Only ~${wordCount} words (thin content)`, fix: 'Expand toward 300+ words of genuinely useful, unique content covering the topic so the page can rank; avoid filler.' });

  // Images / alt
  const imgs = $('img');
  const imgsMissingAlt = imgs.filter((_, el) => !($(el).attr('alt') ?? '').trim()).length;
  if (imgsMissingAlt > 0) issues.push({ severity: 'warning', message: `${imgsMissingAlt}/${imgs.length} images missing alt text`, fix: 'Add descriptive alt text to meaningful images (and alt="" for purely decorative ones) for accessibility and image SEO.' });

  // Links
  const origin = originOf(res.finalUrl);
  let internal = 0;
  let external = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')!;
    try {
      const abs = new URL(href, res.finalUrl);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
      if (abs.origin === origin) internal++;
      else external++;
    } catch {
      /* ignore malformed */
    }
  });

  // hreflang
  const hreflang = $('link[rel="alternate"][hreflang]').map((_, el) => $(el).attr('hreflang')).get();

  // Structured data presence (count only; see extractSchema for detail)
  const jsonLdBlocks = $('script[type="application/ld+json"]').length;
  if (jsonLdBlocks === 0) issues.push({ severity: 'info', message: 'No JSON-LD structured data', fix: 'Add relevant schema.org JSON-LD (e.g. Organization, WebPage, Article, BreadcrumbList, FAQ) to qualify for rich results.' });

  // Optional PageSpeed (awaited here — it was started before the fetch above).
  const pagespeed = psiPromise ? await psiPromise : undefined;
  const perfScore = (pagespeed as { performanceScore?: number } | undefined)?.performanceScore;
  if (pagespeed?.ok && typeof perfScore === 'number' && perfScore < 50) {
    issues.push({ severity: 'warning', message: `Low PageSpeed performance score: ${perfScore}/100 (${pagespeed.strategy})`, fix: 'Tackle the top PageSpeed opportunities: defer/trim unused JavaScript, preload the LCP image (don\'t lazy-load it), serve WebP/AVIF, and improve server response/caching.' });
  }

  return {
    url: res.finalUrl,
    requestedUrl: url,
    status: res.status,
    redirected: res.redirected,
    contentType: res.contentType,
    fetchMs: res.elapsedMs,
    title: { text: title, length: title.length },
    metaDescription: { text: metaDescription, length: metaDescription.length },
    canonical,
    metaRobots,
    viewport,
    charset,
    lang,
    openGraph: og,
    twitter,
    headings: { counts: headingCounts, h1: h1s },
    wordCount,
    images: { total: imgs.length, missingAlt: imgsMissingAlt },
    links: { internal, external, total: internal + external },
    hreflang,
    structuredDataBlocks: jsonLdBlocks,
    issues,
    score: scoreFromIssues(issues),
    ...(pagespeed ? { pagespeed } : {}),
  };
}

/** Crude 0–100 health score from issue severities. */
function scoreFromIssues(issues: Issue[]): number {
  let score = 100;
  for (const i of issues) score -= i.severity === 'error' ? 15 : i.severity === 'warning' ? 7 : 2;
  return Math.max(0, score);
}

/** Fetch + parse robots.txt. */
export async function checkRobots(rawUrl: string) {
  const origin = originOf(normalizeUrl(rawUrl));
  const robotsUrl = `${origin}/robots.txt`;
  const res = await fetchText(robotsUrl);
  if (!res.ok) return { robotsUrl, found: false, status: res.status, note: 'No robots.txt (everything crawlable by default)' };

  const groups: Array<{ userAgents: string[]; disallow: string[]; allow: string[] }> = [];
  const sitemaps: string[] = [];
  let current: { userAgents: string[]; disallow: string[]; allow: string[] } | null = null;

  for (const line of res.body.split('\n')) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const idx = clean.indexOf(':');
    if (idx === -1) continue;
    const field = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.disallow.length || current.allow.length) {
        current = { userAgents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.userAgents.push(value);
    } else if (field === 'disallow' && current) current.disallow.push(value);
    else if (field === 'allow' && current) current.allow.push(value);
    else if (field === 'sitemap') sitemaps.push(value);
  }

  return { robotsUrl, found: true, status: res.status, groups, sitemaps, raw: res.body.slice(0, 4000) };
}

/** Fetch a sitemap (or discover via robots.txt) and summarize it. */
export async function checkSitemap(rawUrl: string) {
  const origin = originOf(normalizeUrl(rawUrl));
  // discover sitemap url(s)
  let candidates: string[] = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const robots = await fetchText(`${origin}/robots.txt`);
  if (robots.ok) {
    const refs = [...robots.body.matchAll(/sitemap:\s*(\S+)/gi)].map((m) => m[1]);
    if (refs.length) candidates = refs;
  }

  for (const sitemapUrl of candidates) {
    const res = await fetchText(sitemapUrl);
    if (!res.ok || !/<(urlset|sitemapindex)/i.test(res.body)) continue;
    const $ = cheerio.load(res.body, { xmlMode: true });
    const isIndex = $('sitemapindex').length > 0;
    if (isIndex) {
      const children = $('sitemap > loc').map((_, el) => $(el).text().trim()).get();
      return { sitemapUrl, type: 'index', childSitemaps: children.length, sample: children.slice(0, 20) };
    }
    const urls = $('url > loc').map((_, el) => $(el).text().trim()).get();
    return { sitemapUrl, type: 'urlset', urlCount: urls.length, sample: urls.slice(0, 20) };
  }
  return { found: false, tried: candidates, note: 'No sitemap found at common locations or via robots.txt' };
}

/** Extract JSON-LD structured data and list the schema @types found. */
export async function extractSchema(rawUrl: string) {
  const url = normalizeUrl(rawUrl);
  const res = await fetchText(url);
  const $ = cheerio.load(res.body);
  const blocks: unknown[] = [];
  const types = new Set<string>();
  const errors: string[] = [];
  if (!res.ok) errors.push(`HTTP ${res.status} — page did not return 200 OK; results may be empty or unreliable`);

  $('script[type="application/ld+json"]').each((i, el) => {
    const txt = $(el).contents().text();
    try {
      const json = JSON.parse(txt);
      blocks.push(json);
      collectTypes(json, types);
    } catch (e) {
      errors.push(`Block ${i + 1}: invalid JSON-LD (${(e as Error).message})`);
    }
  });

  // microdata itemtype hint
  const microdataTypes = $('[itemscope][itemtype]').map((_, el) => $(el).attr('itemtype')).get();

  return {
    url: res.finalUrl,
    ok: res.ok,
    status: res.status,
    jsonLdBlocks: blocks.length,
    schemaTypes: [...types],
    microdataTypes,
    errors,
    blocks: blocks.slice(0, 10),
  };
}

function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out);
  } else if (node && typeof node === 'object') {
    const t = (node as Record<string, unknown>)['@type'];
    if (typeof t === 'string') out.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.add(x));
    for (const v of Object.values(node as Record<string, unknown>)) collectTypes(v, out);
  }
}

/** Check links on a page with HEAD requests (bounded concurrency); report broken ones. */
export async function findBrokenLinks(rawUrl: string, max = 50, concurrency = 8) {
  const url = normalizeUrl(rawUrl);
  const res = await fetchText(url);
  const $ = cheerio.load(res.body);

  // Collect ALL unique http(s) links on the page, then cap — so the limit takes a
  // deduped slice rather than stopping at the first `max` raw hrefs in DOM order.
  const seen = new Set<string>();
  for (const el of $('a[href]').toArray()) {
    const href = $(el).attr('href')!;
    try {
      const abs = new URL(href, res.finalUrl);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') seen.add(abs.toString());
    } catch {
      /* ignore malformed */
    }
  }
  const totalUnique = seen.size;
  const links = [...seen].slice(0, max);

  const results = await mapPool(links, concurrency, async (l) => {
    const { status, reason } = await statusOf(l);
    return reason ? { url: l, status, reason } : { url: l, status };
  });
  const broken = results.filter((r) => r.status === 0 || r.status >= 400);
  return {
    url: res.finalUrl,
    uniqueLinks: totalUnique,
    checked: links.length,
    brokenCount: broken.length,
    broken,
    truncated: totalUnique > links.length,
  };
}

/** Free keyword ideas via Google's public Suggest endpoint (no key, no volumes). */
export async function keywordIdeas(seed: string, lang = 'en') {
  const endpoint = `https://suggestqueries.google.com/complete/search?client=firefox&hl=${encodeURIComponent(lang)}&q=${encodeURIComponent(seed)}`;
  const res = await fetchText(endpoint);
  let suggestions: string[] = [];
  try {
    const parsed = JSON.parse(res.body);
    suggestions = Array.isArray(parsed?.[1]) ? parsed[1] : [];
  } catch {
    /* leave empty */
  }
  return {
    seed,
    count: suggestions.length,
    suggestions,
    note: 'Google Suggest gives related queries only — no search volume (volume needs a paid API).',
  };
}
