/**
 * src/seo/pagespeed.ts — Core Web Vitals + Lighthouse via Google PageSpeed Insights.
 *
 * Calls the public PageSpeed Insights (PSI) v5 API. Works WITHOUT a key (subject
 * to Google's anonymous rate limits); if `PAGESPEED_API_KEY` (or
 * `GOOGLE_PAGESPEED_API_KEY`) is set, it's sent to raise the quota.
 *
 * Returns two flavors of data:
 *   - Lab metrics  — Lighthouse synthetic run (always present on success).
 *   - Field data   — real-user CrUX percentiles (present only if Google has
 *                    enough traffic data for the URL/origin).
 */
import { fetchText, normalizeUrl } from './http';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** Strategies PSI supports. */
export type Strategy = 'mobile' | 'desktop';

/** A single resolved metric value. */
export interface MetricValue {
  value: number | null;
  display: string | null;
}

/** A real-user (CrUX) metric: percentile + Google's FAST/AVERAGE/SLOW bucket. */
export interface FieldMetric {
  percentile: number | null;
  category: string | null;
}

function apiKey(): string | undefined {
  return process.env.PAGESPEED_API_KEY || process.env.GOOGLE_PAGESPEED_API_KEY || undefined;
}

/** Pull a lab metric (numericValue + displayValue) from a Lighthouse audit. */
function labMetric(audits: Record<string, any>, id: string): MetricValue {
  const a = audits?.[id];
  return {
    value: typeof a?.numericValue === 'number' ? a.numericValue : null,
    display: typeof a?.displayValue === 'string' ? a.displayValue : null,
  };
}

/** Pull a CrUX field metric from loadingExperience.metrics. */
function fieldMetric(metrics: Record<string, any> | undefined, id: string): FieldMetric {
  const m = metrics?.[id];
  return {
    percentile: typeof m?.percentile === 'number' ? m.percentile : null,
    category: typeof m?.category === 'string' ? m.category : null,
  };
}

/** The lab half of a result: Lighthouse score + Core Web Vitals + top opportunities. */
export interface LighthouseLab {
  performanceScore: number | null;
  lab: {
    firstContentfulPaint: MetricValue;
    largestContentfulPaint: MetricValue;
    cumulativeLayoutShift: MetricValue;
    totalBlockingTime: MetricValue;
    speedIndex: MetricValue;
    timeToInteractive: MetricValue;
  };
  opportunities: Array<{ id: string; title: string; estimatedSavingsMs: number }>;
  fetchedAt: string | null;
  finalUrl: string | null;
}

/**
 * Parse a Lighthouse result object (`lighthouseResult` from PSI, or `runner.lhr`
 * from a local Lighthouse run — same shape) into score + lab CWV + opportunities.
 * Shared so the hosted (PSI) and local engines produce identical output.
 */
export function parseLighthouse(lh: Record<string, any>): LighthouseLab {
  const audits: Record<string, any> = lh.audits ?? {};
  const perfScoreRaw = lh.categories?.performance?.score;
  const performanceScore = typeof perfScoreRaw === 'number' ? Math.round(perfScoreRaw * 100) : null;

  const lab = {
    firstContentfulPaint: labMetric(audits, 'first-contentful-paint'),
    largestContentfulPaint: labMetric(audits, 'largest-contentful-paint'),
    cumulativeLayoutShift: labMetric(audits, 'cumulative-layout-shift'),
    totalBlockingTime: labMetric(audits, 'total-blocking-time'),
    speedIndex: labMetric(audits, 'speed-index'),
    timeToInteractive: labMetric(audits, 'interactive'),
  };

  const opportunities = Object.values(audits)
    .filter((a: any) => a?.details?.type === 'opportunity' && typeof a?.details?.overallSavingsMs === 'number' && a.details.overallSavingsMs > 0)
    .map((a: any) => ({ id: a.id, title: a.title, estimatedSavingsMs: Math.round(a.details.overallSavingsMs) }))
    .sort((x, y) => y.estimatedSavingsMs - x.estimatedSavingsMs)
    .slice(0, 5);

  return {
    performanceScore,
    lab,
    opportunities,
    fetchedAt: lh.fetchTime ?? null,
    finalUrl: lh.finalDisplayedUrl ?? lh.finalUrl ?? null,
  };
}

// ── Detailed (GTmetrix-style) extraction ──────────────────────────────────────

/** One Lighthouse category (Performance / Accessibility / Best Practices / SEO). */
export interface CategoryScore {
  id: string;
  title: string;
  score: number | null;
}

/** A labeled diagnostic value (server response, DOM size, page weight, …). */
export interface Diagnostic {
  label: string;
  value: string;
}

/** A resource-weight row from Lighthouse's resource summary. */
export interface ResourceRow {
  type: string;
  requests: number;
  bytes: number;
  display: string;
}

/** A scored Lighthouse audit, surfaced either as a suggestion or a passed check. */
export interface AuditFinding {
  id: string;
  title: string;
  description: string;
  category: string;
  score: number | null;
  displayValue: string | null;
}

/** The full GTmetrix-style detail layer extracted from a Lighthouse result. */
export interface LighthouseDetail {
  categories: CategoryScore[];
  diagnostics: Diagnostic[];
  resources: ResourceRow[];
  suggestions: AuditFinding[];
  passed: AuditFinding[];
  passedCount: number;
}

const CATEGORY_TITLES: Record<string, string> = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best Practices',
  seo: 'SEO',
};

/** Lighthouse "metric" audits — shown separately as CWV, excluded from findings. */
const METRIC_IDS = new Set([
  'first-contentful-paint',
  'largest-contentful-paint',
  'cumulative-layout-shift',
  'total-blocking-time',
  'speed-index',
  'interactive',
  'max-potential-fid',
  'first-meaningful-paint',
]);

/** Turn Lighthouse's markdown-flavored copy into clean plain text for reports. */
function stripMarkdown(s: string): string {
  return (s || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/`([^`]+)`/g, '$1') // `code` → code
    .replace(/\s+/g, ' ')
    .trim();
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

/**
 * Extract the full detail layer (all category scores, diagnostics, resource
 * weight, and per-audit suggestions vs passed checks) from a Lighthouse result.
 * Present only when the run requested all categories; missing pieces degrade
 * gracefully to empty arrays.
 */
export function parseLighthouseDetail(lh: Record<string, any>): LighthouseDetail {
  const audits: Record<string, any> = lh.audits ?? {};
  const cats: Record<string, any> = lh.categories ?? {};

  // Category scores (0–100), in a stable, human order.
  const categories: CategoryScore[] = Object.keys(CATEGORY_TITLES)
    .filter((id) => cats[id])
    .map((id) => ({
      id,
      title: cats[id].title ?? CATEGORY_TITLES[id],
      score: typeof cats[id].score === 'number' ? Math.round(cats[id].score * 100) : null,
    }));

  // Map each audit → the (first) category that references it, for grouping.
  const auditCategory: Record<string, string> = {};
  for (const id of Object.keys(cats)) {
    const title = CATEGORY_TITLES[id] ?? cats[id].title ?? id;
    for (const ref of cats[id].auditRefs ?? []) {
      if (ref?.id && !auditCategory[ref.id]) auditCategory[ref.id] = title;
    }
  }

  // Diagnostics — the "page details" GTmetrix shows.
  const numeric = (id: string): number | null => (typeof audits[id]?.numericValue === 'number' ? audits[id].numericValue : null);
  const diagnostics: Diagnostic[] = [];
  const addDiag = (label: string, value: string | null): void => {
    if (value && value !== '—') diagnostics.push({ label, value });
  };
  addDiag('Server response time', audits['server-response-time']?.displayValue ?? null);
  addDiag('Main-thread work', audits['mainthread-work-breakdown']?.displayValue ?? null);
  addDiag('JS execution time', audits['bootup-time']?.displayValue ?? null);
  const dom = numeric('dom-size');
  addDiag('DOM elements', dom == null ? null : Math.round(dom).toLocaleString('en-US'));
  const totalBytes = numeric('total-byte-weight');
  addDiag('Total page size', totalBytes == null ? null : formatBytes(totalBytes));
  const reqItems = audits['network-requests']?.details?.items;
  addDiag('Network requests', Array.isArray(reqItems) ? String(reqItems.length) : null);

  // Resource weight breakdown (Script / Image / CSS / Font / …).
  const resources: ResourceRow[] = [];
  const rs = audits['resource-summary']?.details?.items;
  if (Array.isArray(rs)) {
    for (const it of rs) {
      const bytes = typeof it.transferSize === 'number' ? it.transferSize : 0;
      resources.push({
        type: String(it.label ?? it.resourceType ?? '—'),
        requests: typeof it.requestCount === 'number' ? it.requestCount : 0,
        bytes,
        display: formatBytes(bytes),
      });
    }
  }

  // Suggestions (failing/weak audits) vs passed checks (best practices followed).
  const suggestions: AuditFinding[] = [];
  const passed: AuditFinding[] = [];
  for (const id of Object.keys(audits)) {
    const a = audits[id];
    if (METRIC_IDS.has(id)) continue;
    const mode = a?.scoreDisplayMode;
    if (mode !== 'binary' && mode !== 'numeric' && mode !== 'metricSavings') continue;
    if (typeof a.score !== 'number') continue;
    const finding: AuditFinding = {
      id,
      title: a.title ?? id,
      description: stripMarkdown(a.description ?? ''),
      category: auditCategory[id] ?? 'Other',
      score: Math.round(a.score * 100),
      displayValue: typeof a.displayValue === 'string' ? stripMarkdown(a.displayValue) : null,
    };
    if (a.score >= 0.9) passed.push(finding);
    else suggestions.push(finding);
  }

  // Worst (and most impactful) first.
  suggestions.sort((x, y) => (x.score ?? 0) - (y.score ?? 0));

  return {
    categories,
    diagnostics,
    resources,
    suggestions: suggestions.slice(0, 20),
    passed: passed.slice(0, 40),
    passedCount: passed.length,
  };
}

/**
 * Run PageSpeed Insights for a URL.
 * Never throws on a PSI error response — surfaces it in the result instead.
 */
export async function pageSpeed(rawUrl: string, strategy: Strategy = 'mobile', opts: { detail?: boolean } = {}) {
  const url = normalizeUrl(rawUrl);
  const strat: Strategy = strategy === 'desktop' ? 'desktop' : 'mobile';

  const params = new URLSearchParams({ url, strategy: strat });
  // PSI accepts repeated `category` params. For a detailed report we ask for all
  // four (Performance + Accessibility + Best Practices + SEO); otherwise just perf.
  const categories = opts.detail ? ['performance', 'accessibility', 'best-practices', 'seo'] : ['performance'];
  for (const c of categories) params.append('category', c);
  const key = apiKey();
  if (key) params.set('key', key);

  // PSI runs a full Lighthouse pass server-side; it can be slow. Give it room.
  const res = await fetchText(`${PSI_ENDPOINT}?${params.toString()}`, 60000);

  let data: any;
  try {
    data = JSON.parse(res.body);
  } catch {
    return {
      url,
      strategy: strat,
      ok: false,
      error: `PSI returned non-JSON (HTTP ${res.status})`,
      usedApiKey: Boolean(key),
    };
  }

  if (!res.ok || data?.error) {
    const message = data?.error?.message ?? `HTTP ${res.status}`;
    return {
      url,
      strategy: strat,
      ok: false,
      error: message,
      usedApiKey: Boolean(key),
      note: key ? undefined : 'No API key set — anonymous requests are rate-limited. Set PAGESPEED_API_KEY to raise the quota.',
    };
  }

  const lh = data.lighthouseResult ?? {};
  const parsed = parseLighthouse(lh);

  // Field (CrUX real-user) data — may be absent for low-traffic URLs.
  const le = data.loadingExperience;
  const fieldMetrics = le?.metrics;
  const field = fieldMetrics
    ? {
        overallCategory: le.overall_category ?? null,
        largestContentfulPaint: fieldMetric(fieldMetrics, 'LARGEST_CONTENTFUL_PAINT_MS'),
        cumulativeLayoutShift: fieldMetric(fieldMetrics, 'CUMULATIVE_LAYOUT_SHIFT_SCORE'),
        interactionToNextPaint: fieldMetric(fieldMetrics, 'INTERACTION_TO_NEXT_PAINT'),
        firstContentfulPaint: fieldMetric(fieldMetrics, 'FIRST_CONTENTFUL_PAINT_MS'),
        timeToFirstByte: fieldMetric(fieldMetrics, 'EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
      }
    : null;

  return {
    url: parsed.finalUrl ?? url,
    strategy: strat,
    ok: true,
    source: 'psi' as const,
    usedApiKey: Boolean(key),
    performanceScore: parsed.performanceScore,
    lab: parsed.lab,
    field,
    opportunities: parsed.opportunities,
    ...(opts.detail ? { detail: parseLighthouseDetail(lh) } : {}),
    fetchedAt: parsed.fetchedAt,
    note: field ? undefined : 'No CrUX field data for this URL (not enough real-user traffic) — lab metrics only.',
  };
}
