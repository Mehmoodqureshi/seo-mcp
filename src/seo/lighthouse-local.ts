/**
 * src/seo/lighthouse-local.ts — run Lighthouse on-box, no PSI quota, no API key.
 *
 * The Google PageSpeed Insights API is just hosted Lighthouse + CrUX. This runs
 * the SAME Lighthouse engine locally against a headless Chrome, so we get the lab
 * half (score + Core Web Vitals + opportunities) without Google's rate limits.
 *
 * CrUX field data is Google-only real-user data, so `field` is always null here.
 *
 * `lighthouse` and `chrome-launcher` are OPTIONAL dependencies, loaded lazily so
 * the default (PSI) path stays lightweight and the package installs fine without
 * a Chrome on the host. We use a Function-wrapped dynamic import so the CommonJS
 * compile target doesn't downlevel it to require() (lighthouse is ESM-only).
 */
import { normalizeUrl } from './http';
import { parseLighthouse, type Strategy } from './pagespeed';

// Real ESM dynamic import that survives tsc's CommonJS downleveling.
const esmImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

let cachedHint: string | undefined;
function missingDepHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(msg)) {
    return 'Local Lighthouse needs the optional deps: run `npm i lighthouse chrome-launcher`.';
  }
  if (/no.*chrome|chrome.*not.*found|ECONNREFUSED|spawn/i.test(msg)) {
    return 'Could not launch Chrome. Install Google Chrome/Chromium on this host (chrome-launcher auto-detects it).';
  }
  return cachedHint ?? msg;
}

/**
 * Run Lighthouse locally for a URL. Returns the same shape as `pageSpeed()` so
 * the PDF renderer and audit_page need no changes. `field` is always null.
 * Never throws — surfaces failures as `{ ok: false, error, ... }`.
 */
export async function pageSpeedLocal(rawUrl: string, strategy: Strategy = 'mobile') {
  const url = normalizeUrl(rawUrl);
  const strat: Strategy = strategy === 'desktop' ? 'desktop' : 'mobile';

  let chrome: any;
  try {
    const { launch } = await esmImport('chrome-launcher');
    const lighthouseMod = await esmImport('lighthouse');
    const lighthouse = lighthouseMod.default ?? lighthouseMod;

    chrome = await launch({ chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'] });

    const flags = { port: chrome.port, onlyCategories: ['performance'], output: 'json' as const };
    // Lighthouse's default config is mobile (Moto-G4 + 4G throttling). For desktop
    // we hand it the bundled desktop preset so metrics match PSI's desktop strategy.
    let config: any;
    if (strat === 'desktop') {
      const desktop = await esmImport('lighthouse/core/config/desktop-config.js');
      config = desktop.default ?? desktop;
    }

    const runner = await lighthouse(url, flags, config);
    const lhr = runner?.lhr;
    if (!lhr) {
      return { url, strategy: strat, ok: false as const, source: 'local-lighthouse' as const, error: 'Lighthouse returned no result.' };
    }

    const parsed = parseLighthouse(lhr);
    return {
      url: parsed.finalUrl ?? url,
      strategy: strat,
      ok: true as const,
      source: 'local-lighthouse' as const,
      usedApiKey: false,
      performanceScore: parsed.performanceScore,
      lab: parsed.lab,
      field: null,
      opportunities: parsed.opportunities,
      fetchedAt: parsed.fetchedAt,
      note: 'Lab metrics from local Lighthouse — no CrUX field data, and scores vary with this host’s CPU/network (not standardized like PSI).',
    };
  } catch (err) {
    return {
      url,
      strategy: strat,
      ok: false as const,
      source: 'local-lighthouse' as const,
      error: err instanceof Error ? err.message : String(err),
      hint: missingDepHint(err),
    };
  } finally {
    if (chrome?.kill) {
      try {
        await chrome.kill();
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
