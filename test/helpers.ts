/**
 * test/helpers.ts — a tiny fetch stub so the network layer can be exercised
 * offline. `stubFetch` swaps `globalThis.fetch` for a map of URL → canned
 * response and returns a restore function; every test clears the HTTP cache
 * around it so runs don't leak into each other.
 */

export interface StubEntry {
  body: string;
  status?: number;
  contentType?: string;
  redirected?: boolean;
  finalUrl?: string;
}

/** Build a minimal `fetch`-compatible Response for a canned entry. */
function fakeResponse(url: string, e: StubEntry) {
  const status = e.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: e.finalUrl ?? url,
    redirected: e.redirected ?? false,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? e.contentType ?? 'text/html' : null),
    },
    text: async () => e.body,
  };
}

/**
 * Replace global `fetch` with a lookup over `map` (unknown URLs → 404).
 * Returns a restore function to put the real `fetch` back.
 */
export function stubFetch(map: Record<string, StubEntry>): () => void {
  const original = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    const entry = map[url] ?? { body: '', status: 404 };
    return fakeResponse(url, entry) as unknown as Response;
  };
  return () => {
    (globalThis as unknown as { fetch: unknown }).fetch = original;
  };
}

/** A counting stub: every call increments `state.calls`; all URLs return `body`. */
export function countingFetch(body = '<html></html>', delayMs = 0): { restore: () => void; state: { calls: number } } {
  const original = globalThis.fetch;
  const state = { calls: 0 };
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    state.calls++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return fakeResponse(String(input), { body }) as unknown as Response;
  };
  return { restore: () => ((globalThis as unknown as { fetch: unknown }).fetch = original), state };
}
