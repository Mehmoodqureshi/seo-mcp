/**
 * src/seo/site.ts — site-wide auditing.
 *
 * Discovers a site's URLs from its sitemap (resolving a sitemap index into its
 * child sitemaps), runs the on-page audit on each (concurrency-limited, keyless),
 * and rolls the per-page results up into site-level aggregates.
 *
 * PageSpeed/Lighthouse is intentionally NOT run per-page here — it's far too slow
 * and quota-heavy across dozens of URLs. Site-wide focuses on the fast on-page
 * signals (titles, meta, headings, alt coverage, schema, issues, score).
 */
import * as cheerio from 'cheerio';
import { fetchText, mapPool, normalizeUrl, originOf } from './http';
import { auditPage } from './audit';

/** Walk a sitemap (index or urlset) and collect page URLs. */
async function sitemapUrls(origin: string): Promise<string[]> {
  let candidates = [`${origin}/sitemap.xml`, `${origin}/wp-sitemap.xml`, `${origin}/sitemap_index.xml`];
  const robots = await fetchText(`${origin}/robots.txt`);
  if (robots.ok) {
    const refs = [...robots.body.matchAll(/sitemap:\s*(\S+)/gi)].map((m) => m[1].trim());
    if (refs.length) candidates = refs;
  }

  const pages = new Set<string>();
  const seen = new Set<string>();
  const queue = [...candidates];
  let guard = 0;
  while (queue.length && guard < 200) {
    guard++;
    const sm = queue.shift() as string;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await fetchText(sm);
    if (!res.ok || !/<(urlset|sitemapindex)/i.test(res.body)) continue;
    const $ = cheerio.load(res.body, { xmlMode: true });
    if ($('sitemapindex').length) {
      $('sitemap > loc').each((_, el) => {
        const u = $(el).text().trim();
        if (u) queue.push(u);
      });
    } else {
      $('url > loc').each((_, el) => {
        const u = $(el).text().trim();
        if (u) pages.add(u);
      });
    }
  }
  return [...pages];
}

/** Discover up to `max` page URLs for a site (from its sitemap, else the URL itself). */
export async function discoverSiteUrls(rawUrl: string, max = 50): Promise<{ urls: string[]; total: number; source: string }> {
  const origin = originOf(normalizeUrl(rawUrl));
  let urls = await sitemapUrls(origin);
  let source = 'sitemap';
  if (!urls.length) {
    urls = [normalizeUrl(rawUrl)];
    source = 'single URL (no sitemap found)';
  }
  return { urls: urls.slice(0, max), total: urls.length, source };
}

/** One page's row in a site-wide audit (rich enough for a per-page detail block). */
export interface SitePageResult {
  url: string;
  status: number | null;
  score: number | null;
  issues: number;
  errors: number;
  warnings: number;
  title: string;
  titleLen: number;
  metaDesc: string;
  metaDescLen: number;
  canonical: string | null;
  metaRobots: string | null;
  lang: string | null;
  h1Count: number;
  h1Text: string[];
  headingCounts: Record<string, number>;
  words: number;
  imagesTotal: number;
  missingAlt: number;
  linksInternal: number;
  linksExternal: number;
  schema: number;
  issuesList: Array<{ severity: string; message: string; fix?: string }>;
  allIssues: string[];
  error?: string;
}

export interface SiteAuditResult {
  site: string;
  source: string;
  pagesInSitemap: number;
  pagesAudited: number;
  truncated: boolean;
  summary: {
    avgScore: number | null;
    minScore: number | null;
    maxScore: number | null;
    pagesWithErrors: number;
    pagesWithWarnings: number;
    totalIssues: number;
    missingTitle: number;
    missingMetaDesc: number;
    missingH1: number;
    noSchema: number;
  };
  commonIssues: Array<{ issue: string; pages: number; severity: string; fix?: string }>;
  pages: SitePageResult[];
}

/** Worst-of two severities (error > warning > info). */
function worseSeverity(a: string, b: string): string {
  const rank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  return (rank[a] ?? 9) <= (rank[b] ?? 9) ? a : b;
}

/** Normalize an issue message for rollup (digits → #) so length-specific issues group. */
function issueKey(msg: string): string {
  return msg.replace(/\d+/g, '#').trim();
}

/** Audit a whole site: discover URLs, on-page audit each, aggregate. */
export async function auditSite(rawUrl: string, opts: { max?: number; concurrency?: number } = {}): Promise<SiteAuditResult> {
  const max = opts.max ?? 50;
  const origin = originOf(normalizeUrl(rawUrl));
  const { urls, total, source } = await discoverSiteUrls(rawUrl, max);

  const pages: SitePageResult[] = await mapPool(urls, opts.concurrency ?? 6, async (u) => {
    try {
      const a = await auditPage(u, {});
      const errors = a.issues.filter((i) => i.severity === 'error').length;
      const warnings = a.issues.filter((i) => i.severity === 'warning').length;
      return {
        url: a.url,
        status: a.status,
        score: a.score,
        issues: a.issues.length,
        errors,
        warnings,
        title: a.title.text,
        titleLen: a.title.length,
        metaDesc: a.metaDescription.text,
        metaDescLen: a.metaDescription.length,
        canonical: a.canonical,
        metaRobots: a.metaRobots,
        lang: a.lang,
        h1Count: a.headings.counts.h1,
        h1Text: a.headings.h1,
        headingCounts: a.headings.counts,
        words: a.wordCount,
        imagesTotal: a.images.total,
        missingAlt: a.images.missingAlt,
        linksInternal: a.links.internal,
        linksExternal: a.links.external,
        schema: a.structuredDataBlocks,
        issuesList: a.issues.map((i) => ({ severity: i.severity, message: i.message, fix: i.fix })),
        allIssues: a.issues.map((i) => i.message),
      };
    } catch (e) {
      return {
        url: u,
        status: null,
        score: null,
        issues: 0,
        errors: 0,
        warnings: 0,
        title: '',
        titleLen: 0,
        metaDesc: '',
        metaDescLen: 0,
        canonical: null,
        metaRobots: null,
        lang: null,
        h1Count: 0,
        h1Text: [],
        headingCounts: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
        words: 0,
        imagesTotal: 0,
        missingAlt: 0,
        linksInternal: 0,
        linksExternal: 0,
        schema: 0,
        issuesList: [],
        allIssues: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  const scored = pages.filter((p) => typeof p.score === 'number') as Array<SitePageResult & { score: number }>;
  const avgScore = scored.length ? Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length) : null;
  const minScore = scored.length ? Math.min(...scored.map((p) => p.score)) : null;
  const maxScore = scored.length ? Math.max(...scored.map((p) => p.score)) : null;

  // Common issues rollup (normalized so "Title too long (62 chars)" groups),
  // tracking the worst severity and a representative fix per issue.
  const counts = new Map<string, { issue: string; pages: number; severity: string; fix?: string }>();
  for (const p of pages) {
    const firstByKey = new Map<string, { severity: string; message: string; fix?: string }>();
    for (const it of p.issuesList) {
      const k = issueKey(it.message);
      if (!firstByKey.has(k)) firstByKey.set(k, it);
    }
    for (const [k, it] of firstByKey) {
      const cur = counts.get(k);
      if (cur) {
        cur.pages++;
        cur.severity = worseSeverity(cur.severity, it.severity);
        if (!cur.fix && it.fix) cur.fix = it.fix;
      } else {
        counts.set(k, { issue: it.message, pages: 1, severity: it.severity, fix: it.fix });
      }
    }
  }
  const sevRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const commonIssues = [...counts.values()].sort((a, b) => b.pages - a.pages || (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));

  return {
    site: origin,
    source,
    pagesInSitemap: total,
    pagesAudited: pages.length,
    truncated: total > pages.length,
    summary: {
      avgScore,
      minScore,
      maxScore,
      pagesWithErrors: pages.filter((p) => p.errors > 0).length,
      pagesWithWarnings: pages.filter((p) => p.warnings > 0).length,
      totalIssues: pages.reduce((s, p) => s + p.issues, 0),
      missingTitle: pages.filter((p) => p.status && !p.title).length,
      missingMetaDesc: pages.filter((p) => p.status && p.metaDescLen === 0).length,
      missingH1: pages.filter((p) => p.status && p.h1Count === 0).length,
      noSchema: pages.filter((p) => p.status && p.schema === 0).length,
    },
    commonIssues,
    pages,
  };
}
