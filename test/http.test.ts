import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, originOf, mapPool, fetchText, clearHttpCache } from '../src/seo/http';
import { countingFetch } from './helpers';

test('normalizeUrl adds https:// and trims', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('  http://a.com  '), 'http://a.com');
  assert.equal(normalizeUrl('https://b.com/x'), 'https://b.com/x');
});

test('originOf returns scheme://host[:port]', () => {
  assert.equal(originOf('https://a.com/x?y=1'), 'https://a.com');
  assert.equal(originOf('http://a.com:8080/p'), 'http://a.com:8080');
});

test('mapPool preserves input order and caps concurrency', async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  let active = 0;
  let maxActive = 0;
  const out = await mapPool(items, 3, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, items.map((n) => n * 2));
  assert.ok(maxActive <= 3, `concurrency exceeded limit: ${maxActive}`);
  assert.ok(maxActive > 1, 'expected some parallelism');
});

test('fetchText caches identical GETs within the TTL', async () => {
  clearHttpCache();
  const { restore, state } = countingFetch();
  try {
    await fetchText('https://cache-me.com');
    await fetchText('https://cache-me.com');
    assert.equal(state.calls, 1);
  } finally {
    restore();
    clearHttpCache();
  }
});

test('fetchText coalesces concurrent identical GETs into one request', async () => {
  clearHttpCache();
  const { restore, state } = countingFetch('<html></html>', 10);
  try {
    await Promise.all([
      fetchText('https://coalesce.com'),
      fetchText('https://coalesce.com'),
      fetchText('https://coalesce.com'),
    ]);
    assert.equal(state.calls, 1);
  } finally {
    restore();
    clearHttpCache();
  }
});

test('distinct URLs are fetched independently', async () => {
  clearHttpCache();
  const { restore, state } = countingFetch();
  try {
    await fetchText('https://a.com');
    await fetchText('https://b.com');
    assert.equal(state.calls, 2);
  } finally {
    restore();
    clearHttpCache();
  }
});

test('clearHttpCache forces a refetch', async () => {
  clearHttpCache();
  const { restore, state } = countingFetch();
  try {
    await fetchText('https://z.com');
    clearHttpCache();
    await fetchText('https://z.com');
    assert.equal(state.calls, 2);
  } finally {
    restore();
    clearHttpCache();
  }
});
