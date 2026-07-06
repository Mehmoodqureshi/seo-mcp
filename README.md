# seo-mcp

[![CI](https://github.com/Mehmoodqureshi/seo-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mehmoodqureshi/seo-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40mehmoodqureshi%2Fseo-mcp?label=npm)](https://www.npmjs.com/package/@mehmoodqureshi/seo-mcp)
[![license](https://img.shields.io/npm/l/%40mehmoodqureshi%2Fseo-mcp?label=license)](LICENSE)

An **SEO MCP server** — a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI host a set of SEO tools. The MVP is **100% free and keyless**: on-page/technical audits, robots.txt, sitemaps, structured data, broken-link checks, and keyword ideas.

Built on the same proven scaffold as [`chrome-mcp`](https://github.com/Mehmoodqureshi/chrome-mcp): SDK `Server` → `StdioServerTransport`, a flat tool registry, and a never-throw dispatch firewall.

## Tools (all free, no API key)

| Tool | What it does |
|------|--------------|
| `audit_page` | Full on-page audit: title, meta description, canonical, robots, viewport, OG/Twitter, heading outline, word count, image alt coverage, link counts, structured-data presence → issues + 0–100 score. Pass `pagespeed: true` to also attach PageSpeed metrics |
| `check_robots` | Fetch & parse `/robots.txt` — UA groups, allow/disallow, declared sitemaps |
| `check_sitemap` | Discover & summarize a sitemap (index vs urlset, URL count, sample) |
| `extract_schema` | Pull JSON-LD structured data and list schema.org `@type`s (+ microdata, parse errors) |
| `find_broken_links` | HEAD-check links on a page; report 4xx/5xx/unreachable |
| `keyword_ideas` | Related queries for a seed term via Google Suggest (no volume) |
| `pagespeed` | Google PageSpeed Insights (Lighthouse): perf score, lab Core Web Vitals + real-user CrUX field data + top opportunities. Keyless (rate-limited); set `PAGESPEED_API_KEY` to raise the quota |

## Install & build

```bash
npm install
npm run build      # → dist/src/cli.js
```

## Use it as an MCP server

Add to your MCP host config (e.g. a project `.mcp.json`):

```json
{
  "mcpServers": {
    "seo-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/mehmoodqureshi/Work/seo-mcp/dist/src/cli.js"]
    }
  }
}
```

Then ask things like *"audit https://example.com for SEO"* or *"what does example.com's robots.txt block?"*.

## Quick smoke test (no MCP host needed)

```bash
node -e "require('./dist/src/seo/audit').auditPage('https://example.com').then(r=>console.log(JSON.stringify(r,null,2)))"
```

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm run build       # → dist/
```

CI (`.github/workflows/ci.yml`) runs typecheck → build on Node 18/20/22.

## PageSpeed (optional key)

The `pagespeed` tool works keyless but Google rate-limits anonymous requests. To raise the quota, grab a free [PageSpeed Insights API key](https://developers.google.com/speed/docs/insights/v5/get-started) and set it in your MCP host config:

```json
{
  "mcpServers": {
    "seo-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/mehmoodqureshi/Work/seo-mcp/dist/src/cli.js"],
      "env": { "PAGESPEED_API_KEY": "your-key-here" }
    }
  }
}
```

## Roadmap (needs a key — not in the free MVP)

- `serp_rank` — real SERP position checks (drive a browser, or a paid SERP API)
- `domain_authority` — OpenPageRank (free key) for an authority score
- `backlinks` — real backlink profiles (paid: Ahrefs / SEMrush / DataForSEO)

## License

MIT
