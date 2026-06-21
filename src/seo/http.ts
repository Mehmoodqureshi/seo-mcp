/**
 * src/seo/http.ts — small fetch helpers shared by the SEO tools.
 *
 * Node 18+ ships a global `fetch`; we add a sane User-Agent, a timeout, and
 * redirect tracking so audits report the FINAL url.
 */

const UA =
  'Mozilla/5.0 (compatible; seo-mcp/0.1; +https://github.com/Mehmoodqureshi/seo-mcp)';

export interface FetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  redirected: boolean;
  elapsedMs: number;
}

/** Fetch a URL as text with a timeout. Never throws on HTTP status; throws only on network/timeout. */
export async function fetchText(url: string, timeoutMs = 15000): Promise<FetchResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType: res.headers.get('content-type') ?? '',
      body,
      redirected: res.redirected,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(t);
  }
}

/** HEAD a URL, returning just its status (used for broken-link checks). Falls back to GET if HEAD is blocked. */
export async function statusOf(url: string, timeoutMs = 10000): Promise<number> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
    }
    return res.status;
  } catch {
    return 0; // 0 = network error / unreachable
  } finally {
    clearTimeout(t);
  }
}

/** Normalize a user-supplied target into an absolute http(s) URL. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Return the scheme://host origin of a URL. */
export function originOf(url: string): string {
  return new URL(url).origin;
}
