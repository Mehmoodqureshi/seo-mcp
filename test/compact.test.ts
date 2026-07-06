import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactSiteAudit } from '../src/seo/compact';
import type { SiteAuditResult, SitePageResult } from '../src/seo/site';

function mkPage(url: string, score: number, issues = 2): SitePageResult {
  return {
    url,
    status: 200,
    score,
    issues,
    errors: score < 70 ? 1 : 0,
    warnings: 1,
    title: 'T',
    titleLen: 1,
    metaDesc: 'D',
    metaDescLen: 1,
    canonical: null,
    metaRobots: null,
    lang: 'en',
    h1Count: 1,
    h1Text: ['heading text that would bloat the payload'],
    headingCounts: { h1: 1, h2: 2, h3: 0, h4: 0, h5: 0, h6: 0 },
    words: 500,
    imagesTotal: 3,
    missingAlt: 0,
    linksInternal: 10,
    linksExternal: 2,
    schema: 1,
    issuesList: [
      { severity: 'warning', message: 'Meta description is 12 chars (<50 is short)', fix: 'Expand it.' },
      { severity: 'info', message: 'No canonical link', fix: 'Add one.' },
    ],
    allIssues: ['Meta description is 12 chars (<50 is short)', 'No canonical link'],
  };
}

function fakeSite(pages: SitePageResult[]): SiteAuditResult {
  return {
    site: 'https://ex.com',
    source: 'sitemap',
    pagesInSitemap: pages.length,
    pagesAudited: pages.length,
    truncated: false,
    summary: {
      avgScore: 78,
      minScore: 60,
      maxScore: 95,
      pagesWithErrors: 1,
      pagesWithWarnings: pages.length,
      totalIssues: pages.reduce((s, p) => s + p.issues, 0),
      missingTitle: 0,
      missingMetaDesc: 1,
      missingH1: 0,
      noSchema: 0,
    },
    commonIssues: [
      { issue: 'No canonical link', pages: 3, severity: 'info', fix: 'Add one.' },
      { issue: 'Meta description is # chars (<50 is short)', pages: 2, severity: 'warning' },
    ],
    pages,
  };
}

test('compactSiteAudit slims per-page rows to score/counts only', () => {
  const c = compactSiteAudit(fakeSite([mkPage('https://ex.com/a', 95)]));
  const row = c.pages[0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), ['errors', 'issues', 'score', 'status', 'url', 'warnings']);
  assert.equal(row.issuesList, undefined);
  assert.equal(row.allIssues, undefined);
  assert.equal(row.h1Text, undefined);
  assert.equal(c.detail, false);
});

test('compactSiteAudit sorts pages worst-first, nulls last', () => {
  const pages = [mkPage('https://ex.com/a', 95), mkPage('https://ex.com/c', 60), mkPage('https://ex.com/b', 80)];
  const nullPage = { ...mkPage('https://ex.com/err', 0), score: null };
  const c = compactSiteAudit(fakeSite([...pages, nullPage]));
  assert.deepEqual(c.pages.map((p) => p.score), [60, 80, 95, null]);
});

test('compactSiteAudit preserves site-level aggregates', () => {
  const c = compactSiteAudit(fakeSite([mkPage('https://ex.com/a', 95)]));
  assert.equal(c.site, 'https://ex.com');
  assert.equal(c.summary.avgScore, 78);
  assert.ok(Array.isArray(c.commonIssues));
});

test('compactSiteAudit caps and flags an oversized common-issues list', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ issue: `issue ${i}`, pages: 30 - i, severity: 'info' }));
  const site = { ...fakeSite([mkPage('https://ex.com/a', 95)]), commonIssues: many };
  const c = compactSiteAudit(site);
  assert.equal(c.commonIssues.length, 20);
  assert.equal(c.commonIssuesTruncated, true);
});
