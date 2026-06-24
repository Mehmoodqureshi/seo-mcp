/**
 * src/mcp/tools.ts — the SEO tool surface.
 *
 * `TOOL_DEFINITIONS` advertises each tool's JSON-schema; `TOOL_HANDLERS` maps
 * names to handlers. `dispatchToolCall` is a never-throw firewall that turns any
 * Error into an `isError` text result. `registerTools()` wires both onto the SDK
 * `Server` via the ListTools / CallTool request handlers.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  auditPage,
  checkRobots,
  checkSitemap,
  extractSchema,
  findBrokenLinks,
  keywordIdeas,
} from '../seo/audit';
import { pageSpeed } from '../seo/pagespeed';
import { pageSpeedLocal } from '../seo/lighthouse-local';
import { auditSite } from '../seo/site';
import { renderAuditPdf, renderSiteAuditPdf } from '../seo/pdf';

type JsonSchema = { type: 'object'; properties: Record<string, unknown>; required: string[] };
const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
});

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'audit_page',
    description:
      'Full on-page SEO audit of a URL: title, meta description, canonical, robots, viewport, Open Graph/Twitter, heading outline, word count, image alt coverage, internal/external link counts, structured-data presence, plus a list of issues and a 0–100 score. Free, no API key. Set pagespeed=true to also attach PageSpeed Insights performance metrics. After presenting the results, ASK THE USER whether they want a professionally formatted PDF report; if they say yes, call export_audit_pdf with the same url (and same pagespeed/strategy).',
    inputSchema: obj(
      {
        url: { type: 'string', description: 'Page URL (https:// optional)' },
        pagespeed: { type: 'boolean', description: 'Also run PageSpeed Insights and attach performance metrics (default false)' },
        strategy: { type: 'string', description: 'PageSpeed strategy when pagespeed=true: "mobile" (default) or "desktop"' },
        detail: { type: 'boolean', description: 'When pagespeed=true, also attach the full GTmetrix-style detail layer under pagespeed.detail (all category scores, diagnostics, resource breakdown, suggestions, passed checks). Default false.' },
      },
      ['url'],
    ),
  },
  {
    name: 'export_audit_pdf',
    description:
      'Generate a professionally laid-out PDF report of an on-page SEO audit (score badge, summary cards, severity-colored issue list, metadata, content/structure, social tags, and optional PageSpeed metrics). Re-runs the audit for the URL and writes a .pdf to disk, returning the file path. Use this after audit_page when the user asks for a PDF report.',
    inputSchema: obj(
      {
        url: { type: 'string', description: 'Page URL to audit and export (https:// optional)' },
        path: { type: 'string', description: 'Output file path (default: ./seo-audit-<host>-<date>.pdf in the current directory). ".pdf" is appended if missing.' },
        pagespeed: { type: 'boolean', description: 'Also run PageSpeed and include performance metrics in the report (default false). When true, BOTH Mobile and Desktop are included in the same PDF unless a single "strategy" is specified.' },
        strategy: { type: 'string', description: 'Limit the PageSpeed section to one strategy: "mobile" or "desktop". Omit to include BOTH in the same file (default).' },
        detail: { type: 'boolean', description: 'Include the full GTmetrix-style detail in the PDF (category scores, diagnostics, resource weight, prioritized suggestions, passed checks). Defaults to true when pagespeed=true.' },
      },
      ['url'],
    ),
  },
  {
    name: 'audit_site',
    description:
      'Site-wide on-page SEO audit: discovers the site\'s URLs from its sitemap (resolving a sitemap index into child sitemaps), runs the on-page audit on each page (keyless, concurrency-limited), and returns site-level aggregates — average/min/max score, pages with errors, site-wide gaps (missing titles/meta/H1/schema), a rollup of the most common issues, and a per-page table. PageSpeed is NOT run per page (too slow across many URLs). Use audit_page or pagespeed for deep per-page performance.',
    inputSchema: obj(
      {
        url: { type: 'string', description: 'Any URL on the site (https:// optional)' },
        max: { type: 'number', description: 'Maximum number of pages to audit (default 50)' },
      },
      ['url'],
    ),
  },
  {
    name: 'export_site_pdf',
    description:
      'Run a site-wide audit and write a professionally formatted multi-page PDF report (overall average-score badge, summary cards, coverage, common-issues rollup, a per-page results table sorted worst-first, and a full per-page details section — metadata, structure, and each page\'s specific issues). Returns the file path.',
    inputSchema: obj(
      {
        url: { type: 'string', description: 'Any URL on the site (https:// optional)' },
        max: { type: 'number', description: 'Maximum number of pages to audit (default 50)' },
        path: { type: 'string', description: 'Output file path (default: ./seo-site-audit-<host>-<date>.pdf). ".pdf" appended if missing.' },
        details: { type: 'boolean', description: 'Include the full per-page details section (one card per page with metadata, structure, and issues). Default true; set false for a summary-only report.' },
      },
      ['url'],
    ),
  },
  {
    name: 'check_robots',
    description: "Fetch and parse a site's /robots.txt — user-agent groups, allow/disallow rules, and declared sitemaps.",
    inputSchema: obj({ url: { type: 'string', description: 'Any URL on the site' } }, ['url']),
  },
  {
    name: 'check_sitemap',
    description: 'Discover and summarize a sitemap (via /sitemap.xml or robots.txt): index vs urlset, URL count, and a sample of URLs.',
    inputSchema: obj({ url: { type: 'string', description: 'Any URL on the site' } }, ['url']),
  },
  {
    name: 'extract_schema',
    description: 'Extract JSON-LD structured data from a page and list the schema.org @types found (plus any microdata itemtypes and JSON-LD parse errors).',
    inputSchema: obj({ url: { type: 'string', description: 'Page URL' } }, ['url']),
  },
  {
    name: 'find_broken_links',
    description: 'Check the links on a page with HEAD requests and report any that return 4xx/5xx or are unreachable.',
    inputSchema: obj(
      { url: { type: 'string', description: 'Page URL' }, max: { type: 'number', description: 'Max links to check (default 50)' } },
      ['url'],
    ),
  },
  {
    name: 'keyword_ideas',
    description: 'Get related keyword/query ideas for a seed term via Google Suggest (free; related queries only, no search volume).',
    inputSchema: obj(
      { seed: { type: 'string', description: 'Seed keyword or phrase' }, lang: { type: 'string', description: 'Language code, e.g. "en" (default)' } },
      ['seed'],
    ),
  },
  {
    name: 'pagespeed',
    description:
      'Run Lighthouse for performance score (0–100), lab Core Web Vitals (LCP, CLS, TBT, FCP, Speed Index, TTI), and top improvement opportunities. Default engine is Google PageSpeed Insights (hosted; adds real-user CrUX field data when available; keyless but rate-limited — set PAGESPEED_API_KEY to raise the quota), and it auto-falls-back to a LOCAL Lighthouse run if PSI is over quota. Set local=true to force the local engine (no key, no quota; needs Chrome on the host; no CrUX field data; runs headless Chrome silently).',
    inputSchema: obj(
      {
        url: { type: 'string', description: 'Page URL' },
        strategy: { type: 'string', description: '"mobile" (default) or "desktop"' },
        local: { type: 'boolean', description: 'Force the local Lighthouse engine instead of Google PSI (no API key/quota; requires Chrome installed; lab metrics only). Default false.' },
        detail: { type: 'boolean', description: 'Return the full GTmetrix-style detail: all four category scores (Performance, Accessibility, Best Practices, SEO), diagnostics (server response, DOM size, page weight, request count), resource breakdown, prioritized suggestions with descriptions, and passed best-practice checks. Default false.' },
      },
      ['url'],
    ),
  },
];

type Args = Record<string, unknown>;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const str = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${k}" is required and must be a non-empty string`);
  return v;
};

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Run PageSpeed for one strategy: PSI by default (auto-falling back to local
 * Lighthouse on quota errors), or local directly when `local` is set.
 * Shared by the `pagespeed` tool and the both-strategies PDF export.
 */
async function runPagespeed(url: string, strategy: 'mobile' | 'desktop', detail: boolean, local: boolean): Promise<any> {
  if (local) return pageSpeedLocal(url, strategy, { detail });
  const psi = await pageSpeed(url, strategy, { detail });
  const psiError = (psi as { error?: string }).error ?? '';
  if (psi.ok === false && /quota|rate.?limit|RESOURCE_EXHAUSTED|\b429\b/i.test(psiError)) {
    const localResult = await pageSpeedLocal(url, strategy, { detail });
    return { ...localResult, fellBackFrom: 'psi', psiError };
  }
  return psi;
}

export const TOOL_HANDLERS: Record<string, (a: Args) => Promise<ToolResult>> = {
  audit_page: async (a) => {
    const audit = await auditPage(str(a, 'url'), { pagespeed: a.pagespeed === true, strategy: a.strategy === 'desktop' ? 'desktop' : 'mobile', detail: a.detail === true });
    return jsonResult({
      ...audit,
      pdfReport: {
        available: true,
        hint: 'A professionally formatted PDF report of this audit can be generated. Ask the user whether they want it; if yes, call export_audit_pdf with the same url.',
      },
    });
  },
  export_audit_pdf: async (a) => {
    const url = str(a, 'url');
    // Default the PDF to a detailed (GTmetrix-style) report when PageSpeed is on.
    const detail = a.detail !== false;
    // On-page audit once; PageSpeed is attached separately so we can include both
    // strategies in the same file.
    const audit = await auditPage(url, {});
    let reports: any[] = [];
    if (a.pagespeed === true) {
      const local = a.local === true;
      if (a.strategy === 'mobile' || a.strategy === 'desktop') {
        // Explicit single strategy requested.
        reports = [await runPagespeed(url, a.strategy, detail, local)];
      } else {
        // Default: both Mobile and Desktop in one report. Run SEQUENTIALLY — the
        // local Lighthouse engine uses global performance marks that collide if
        // two runs overlap in the same process (one would fail to gather).
        const mobile = await runPagespeed(url, 'mobile', detail, local);
        const desktop = await runPagespeed(url, 'desktop', detail, local);
        reports = [mobile, desktop];
      }
    }
    const full = reports.length ? { ...audit, pagespeedReports: reports } : audit;
    const path = await renderAuditPdf(full as typeof audit, typeof a.path === 'string' ? a.path : undefined);
    const strategies = reports.map((r) => r?.strategy).filter(Boolean).join(' + ');
    return jsonResult({ ok: true, path, url: audit.url, score: audit.score, issues: audit.issues.length, strategies: strategies || 'none', message: `PDF report written to ${path}` });
  },
  audit_site: async (a) => jsonResult(await auditSite(str(a, 'url'), { max: typeof a.max === 'number' ? a.max : 50 })),
  export_site_pdf: async (a) => {
    const site = await auditSite(str(a, 'url'), { max: typeof a.max === 'number' ? a.max : 50 });
    const path = await renderSiteAuditPdf(site, typeof a.path === 'string' ? a.path : undefined, { perPageDetails: a.details !== false });
    return jsonResult({ ok: true, path, site: site.site, pagesAudited: site.pagesAudited, avgScore: site.summary.avgScore, pagesWithErrors: site.summary.pagesWithErrors, perPageDetails: a.details !== false, message: `Site audit PDF written to ${path}` });
  },
  check_robots: async (a) => jsonResult(await checkRobots(str(a, 'url'))),
  check_sitemap: async (a) => jsonResult(await checkSitemap(str(a, 'url'))),
  extract_schema: async (a) => jsonResult(await extractSchema(str(a, 'url'))),
  find_broken_links: async (a) => jsonResult(await findBrokenLinks(str(a, 'url'), typeof a.max === 'number' ? a.max : 50)),
  keyword_ideas: async (a) => jsonResult(await keywordIdeas(str(a, 'seed'), typeof a.lang === 'string' ? a.lang : 'en')),
  pagespeed: async (a) => {
    const url = str(a, 'url');
    const strategy = a.strategy === 'desktop' ? 'desktop' : 'mobile';
    return jsonResult(await runPagespeed(url, strategy, a.detail === true, a.local === true));
  },
};

/** Never-throw firewall: any handler error becomes an `isError` text result. */
export async function dispatchToolCall(name: string, rawArgs: unknown): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return errorResult(`unknown tool: ${name}`);
  try {
    return await handler((rawArgs ?? {}) as Args);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/** Assert the catalog and the dispatch table describe the same tool set. */
function assertNoDrift(): void {
  const defs = new Set(TOOL_DEFINITIONS.map((d) => d.name));
  const handlers = new Set(Object.keys(TOOL_HANDLERS));
  for (const n of defs) if (!handlers.has(n)) throw new Error(`tool "${n}" is advertised but has no handler`);
  for (const n of handlers) if (!defs.has(n)) throw new Error(`handler "${n}" has no advertised definition`);
}

export function registerTools(server: Server): void {
  assertNoDrift();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => dispatchToolCall(req.params.name, req.params.arguments));
}
