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

/**
 * Run PageSpeed Insights for a URL.
 * Never throws on a PSI error response — surfaces it in the result instead.
 */
export async function pageSpeed(rawUrl: string, strategy: Strategy = 'mobile') {
  const url = normalizeUrl(rawUrl);
  const strat: Strategy = strategy === 'desktop' ? 'desktop' : 'mobile';

  const params = new URLSearchParams({ url, strategy: strat, category: 'performance' });
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
  const audits: Record<string, any> = lh.audits ?? {};
  const perfScoreRaw = lh.categories?.performance?.score;
  const performanceScore = typeof perfScoreRaw === 'number' ? Math.round(perfScoreRaw * 100) : null;

  // Lab (synthetic) Core Web Vitals + key timings.
  const lab = {
    firstContentfulPaint: labMetric(audits, 'first-contentful-paint'),
    largestContentfulPaint: labMetric(audits, 'largest-contentful-paint'),
    cumulativeLayoutShift: labMetric(audits, 'cumulative-layout-shift'),
    totalBlockingTime: labMetric(audits, 'total-blocking-time'),
    speedIndex: labMetric(audits, 'speed-index'),
    timeToInteractive: labMetric(audits, 'interactive'),
  };

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

  // Top improvement opportunities (audits Lighthouse flags as recoverable time).
  const opportunities = Object.values(audits)
    .filter((a: any) => a?.details?.type === 'opportunity' && typeof a?.details?.overallSavingsMs === 'number' && a.details.overallSavingsMs > 0)
    .map((a: any) => ({ id: a.id, title: a.title, estimatedSavingsMs: Math.round(a.details.overallSavingsMs) }))
    .sort((x, y) => y.estimatedSavingsMs - x.estimatedSavingsMs)
    .slice(0, 5);

  return {
    url: lh.finalUrl ?? url,
    strategy: strat,
    ok: true,
    usedApiKey: Boolean(key),
    performanceScore,
    lab,
    field,
    opportunities,
    fetchedAt: lh.fetchTime ?? null,
    note: field ? undefined : 'No CrUX field data for this URL (not enough real-user traffic) — lab metrics only.',
  };
}
