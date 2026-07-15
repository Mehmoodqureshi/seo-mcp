import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPage, checkRobots } from '../src/seo/audit';
import { clearHttpCache } from '../src/seo/http';
import { stubFetch } from './helpers';

const GOOD_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>A decent page title about widgets and gadgets</title>
    <meta name="description" content="${'A useful, keyword-rich description of the page. '.repeat(3)}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="canonical" href="https://ex.com/">
  </head>
  <body>
    <h1>Main heading</h1>
    <p>${'word '.repeat(350)}</p>
    <img src="a.png" alt="a picture">
    <a href="/internal">internal</a>
    <a href="https://other.com/x">external</a>
    <script type="application/ld+json">{"@type":"WebPage","name":"x"}</script>
  </body>
</html>`;

test('auditPage parses a well-formed page and scores it high', async () => {
  clearHttpCache();
  const restore = stubFetch({ 'https://ex.com/': { body: GOOD_PAGE } });
  try {
    const a = await auditPage('https://ex.com/');
    assert.equal(a.title.text, 'A decent page title about widgets and gadgets');
    assert.equal(a.headings.counts.h1, 1);
    assert.equal(a.links.internal, 1);
    assert.equal(a.links.external, 1);
    assert.equal(a.structuredDataBlocks, 1);
    assert.equal(a.images.total, 1);
    assert.equal(a.images.missingAlt, 0);
    assert.ok(a.wordCount >= 300, `wordCount was ${a.wordCount}`);
    assert.ok(a.score >= 90, `score was ${a.score}`);
  } finally {
    restore();
    clearHttpCache();
  }
});

test('auditPage flags missing title, h1, and meta description', async () => {
  clearHttpCache();
  const restore = stubFetch({
    'https://bad.com/': { body: '<!doctype html><html><head></head><body><p>thin</p></body></html>' },
  });
  try {
    const a = await auditPage('https://bad.com/');
    const messages = a.issues.map((i) => i.message).join(' | ');
    assert.match(messages, /Missing <title>/);
    assert.match(messages, /No <h1>/);
    assert.match(messages, /Missing meta description/);
    assert.ok(
      a.issues.some((i) => i.severity === 'error'),
      'expected at least one error-severity issue',
    );
    assert.ok(a.score < 80, `score was ${a.score}`);
  } finally {
    restore();
    clearHttpCache();
  }
});

test('auditPage treats a self-referencing canonical as self and does not warn', async () => {
  clearHttpCache();
  const restore = stubFetch({ 'https://ex.com/': { body: GOOD_PAGE } });
  try {
    const a = await auditPage('https://ex.com/');
    assert.equal(a.canonicalUrl, 'https://ex.com/');
    assert.equal(a.canonicalSelf, true);
    assert.ok(!a.issues.some((i) => /Canonical points to a different URL/.test(i.message)));
  } finally {
    restore();
    clearHttpCache();
  }
});

test('auditPage warns when the canonical points to a different page', async () => {
  clearHttpCache();
  const page = `<!doctype html><html lang="en"><head>
    <title>Widgets page with a perfectly reasonable title</title>
    <link rel="canonical" href="https://ex.com/other-page">
  </head><body><h1>Hi</h1></body></html>`;
  const restore = stubFetch({ 'https://ex.com/page': { body: page } });
  try {
    const a = await auditPage('https://ex.com/page');
    assert.equal(a.canonicalUrl, 'https://ex.com/other-page');
    assert.equal(a.canonicalSelf, false);
    assert.match(a.issues.map((i) => i.message).join(' | '), /Canonical points to a different URL/);
    assert.ok(a.issues.some((i) => i.severity === 'warning' && /Canonical points/.test(i.message)));
  } finally {
    restore();
    clearHttpCache();
  }
});

test('auditPage ignores trailing-slash/query differences in the canonical', async () => {
  clearHttpCache();
  const page = `<!doctype html><html lang="en"><head>
    <title>Widgets page with a perfectly reasonable title</title>
    <link rel="canonical" href="https://ex.com/page">
  </head><body><h1>Hi</h1></body></html>`;
  const restore = stubFetch({ 'https://ex.com/page/?utm_source=nl': { body: page } });
  try {
    const a = await auditPage('https://ex.com/page/?utm_source=nl');
    assert.equal(a.canonicalSelf, true);
    assert.ok(!a.issues.some((i) => /Canonical points to a different URL/.test(i.message)));
  } finally {
    restore();
    clearHttpCache();
  }
});

test('auditPage flags multiple conflicting canonical tags', async () => {
  clearHttpCache();
  const page = `<!doctype html><html lang="en"><head>
    <title>Widgets page with a perfectly reasonable title</title>
    <link rel="canonical" href="https://ex.com/page">
    <link rel="canonical" href="https://ex.com/other-page">
  </head><body><h1>Hi</h1></body></html>`;
  const restore = stubFetch({ 'https://ex.com/page': { body: page } });
  try {
    const a = await auditPage('https://ex.com/page');
    assert.equal(a.canonicalCount, 2);
    assert.match(a.issues.map((i) => i.message).join(' | '), /2 conflicting canonical URLs/);
    assert.ok(a.issues.some((i) => i.severity === 'warning' && /conflicting canonical/.test(i.message)));
  } finally {
    restore();
    clearHttpCache();
  }
});

test('auditPage does not flag duplicate identical canonical tags as conflicting', async () => {
  clearHttpCache();
  const page = `<!doctype html><html lang="en"><head>
    <title>Widgets page with a perfectly reasonable title</title>
    <link rel="canonical" href="https://ex.com/page">
    <link rel="canonical" href="https://ex.com/page">
  </head><body><h1>Hi</h1></body></html>`;
  const restore = stubFetch({ 'https://ex.com/page': { body: page } });
  try {
    const a = await auditPage('https://ex.com/page');
    assert.equal(a.canonicalCount, 2);
    assert.ok(!a.issues.some((i) => /conflicting canonical/.test(i.message)));
  } finally {
    restore();
    clearHttpCache();
  }
});

test('auditPage flags an invalid canonical href', async () => {
  clearHttpCache();
  const page = `<!doctype html><html lang="en"><head>
    <title>Widgets page with a perfectly reasonable title</title>
    <link rel="canonical" href="http://">
  </head><body><h1>Hi</h1></body></html>`;
  const restore = stubFetch({ 'https://ex.com/bad-canon': { body: page } });
  try {
    const a = await auditPage('https://ex.com/bad-canon');
    assert.equal(a.canonicalUrl, null);
    assert.match(a.issues.map((i) => i.message).join(' | '), /Canonical href is not a valid URL/);
  } finally {
    restore();
    clearHttpCache();
  }
});

test('auditPage reports a non-200 as an error', async () => {
  clearHttpCache();
  const restore = stubFetch({ 'https://gone.com/': { body: 'Not Found', status: 404 } });
  try {
    const a = await auditPage('https://gone.com/');
    assert.equal(a.status, 404);
    assert.match(a.issues.map((i) => i.message).join(' | '), /HTTP 404/);
  } finally {
    restore();
    clearHttpCache();
  }
});

test('checkRobots parses user-agent groups and sitemaps', async () => {
  clearHttpCache();
  const robots = [
    'User-agent: *',
    'Disallow: /admin',
    'Allow: /public',
    '',
    'User-agent: BadBot',
    'Disallow: /',
    '',
    'Sitemap: https://ex.com/sitemap.xml',
  ].join('\n');
  const restore = stubFetch({ 'https://ex.com/robots.txt': { body: robots, contentType: 'text/plain' } });
  try {
    const r = await checkRobots('https://ex.com/');
    assert.equal(r.found, true);
    assert.equal(r.groups?.length, 2);
    assert.ok(r.sitemaps?.includes('https://ex.com/sitemap.xml'));
    assert.ok(r.groups?.[0]?.disallow.includes('/admin'));
  } finally {
    restore();
    clearHttpCache();
  }
});
