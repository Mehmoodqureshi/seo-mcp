/**
 * src/seo/compact.ts — token-efficient projection of a site-wide audit.
 *
 * A full `SiteAuditResult` carries every page's issue list, H1 text and metadata.
 * Returned verbatim from the `audit_site` tool, a 50-page crawl can flood an MCP
 * host's context window. `compactSiteAudit` keeps the site-level aggregates and
 * a slim, worst-first per-page table (score + issue counts only), and points the
 * caller at `detail=true` / `export_site_pdf` when the full breakdown is wanted.
 * The PDF exporter consumes the full `SiteAuditResult` directly, so nothing is
 * lost there.
 */
import type { SiteAuditResult, SitePageResult } from './site';

/** One slim per-page row: enough to triage, without the full issue/metadata payload. */
export interface CompactSitePage {
  url: string;
  status: number | null;
  score: number | null;
  issues: number;
  errors: number;
  warnings: number;
}

export interface CompactSiteAudit {
  site: string;
  source: string;
  pagesInSitemap: number;
  pagesAudited: number;
  truncated: boolean;
  summary: SiteAuditResult['summary'];
  commonIssues: SiteAuditResult['commonIssues'];
  /** Present and true only when `commonIssues` was capped. */
  commonIssuesTruncated?: boolean;
  pages: CompactSitePage[];
  detail: false;
  hint: string;
}

/** Cap the common-issues rollup so a pathological site can't blow up the payload. */
const MAX_COMMON_ISSUES = 20;

function slimPage(p: SitePageResult): CompactSitePage {
  return { url: p.url, status: p.status, score: p.score, issues: p.issues, errors: p.errors, warnings: p.warnings };
}

/** Project a full site audit into a compact, LLM-friendly shape (worst pages first). */
export function compactSiteAudit(site: SiteAuditResult): CompactSiteAudit {
  const commonIssues = site.commonIssues.slice(0, MAX_COMMON_ISSUES);
  const pages = [...site.pages]
    // Worst-scoring first; pages that failed to score (null) sort last.
    .sort((a, b) => (a.score ?? 101) - (b.score ?? 101))
    .map(slimPage);

  return {
    site: site.site,
    source: site.source,
    pagesInSitemap: site.pagesInSitemap,
    pagesAudited: site.pagesAudited,
    truncated: site.truncated,
    summary: site.summary,
    commonIssues,
    ...(site.commonIssues.length > commonIssues.length ? { commonIssuesTruncated: true } : {}),
    pages,
    detail: false,
    hint: "Compact view — per-page rows show score and issue counts only, sorted worst-first. Call audit_site again with detail=true for full per-page metadata and each page's specific issues, or export_site_pdf for a formatted report.",
  };
}
