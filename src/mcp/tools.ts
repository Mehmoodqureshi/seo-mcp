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
import { renderAuditPdf } from '../seo/pdf';

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
        pagespeed: { type: 'boolean', description: 'Also run PageSpeed Insights and include performance metrics in the report (default false)' },
        strategy: { type: 'string', description: 'PageSpeed strategy when pagespeed=true: "mobile" (default) or "desktop"' },
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

export const TOOL_HANDLERS: Record<string, (a: Args) => Promise<ToolResult>> = {
  audit_page: async (a) => {
    const audit = await auditPage(str(a, 'url'), { pagespeed: a.pagespeed === true, strategy: a.strategy === 'desktop' ? 'desktop' : 'mobile' });
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
    const audit = await auditPage(url, { pagespeed: a.pagespeed === true, strategy: a.strategy === 'desktop' ? 'desktop' : 'mobile' });
    const path = await renderAuditPdf(audit, typeof a.path === 'string' ? a.path : undefined);
    return jsonResult({ ok: true, path, url: audit.url, score: audit.score, issues: audit.issues.length, message: `PDF report written to ${path}` });
  },
  check_robots: async (a) => jsonResult(await checkRobots(str(a, 'url'))),
  check_sitemap: async (a) => jsonResult(await checkSitemap(str(a, 'url'))),
  extract_schema: async (a) => jsonResult(await extractSchema(str(a, 'url'))),
  find_broken_links: async (a) => jsonResult(await findBrokenLinks(str(a, 'url'), typeof a.max === 'number' ? a.max : 50)),
  keyword_ideas: async (a) => jsonResult(await keywordIdeas(str(a, 'seed'), typeof a.lang === 'string' ? a.lang : 'en')),
  pagespeed: async (a) => {
    const url = str(a, 'url');
    const strategy = a.strategy === 'desktop' ? 'desktop' : 'mobile';
    if (a.local === true) return jsonResult(await pageSpeedLocal(url, strategy));

    const psi = await pageSpeed(url, strategy);
    const psiError = (psi as { error?: string }).error ?? '';
    // Auto-fall-back to local Lighthouse when PSI fails on quota / rate limiting.
    if (psi.ok === false && /quota|rate.?limit|RESOURCE_EXHAUSTED|\b429\b/i.test(psiError)) {
      const local = await pageSpeedLocal(url, strategy);
      return jsonResult({ ...local, fellBackFrom: 'psi', psiError });
    }
    return jsonResult(psi);
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
