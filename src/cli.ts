#!/usr/bin/env node
/**
 * src/cli.ts — seo-mcp entry point.
 *
 * Boots the stdio MCP server. All diagnostics go to stderr; stdout is reserved
 * for the JSON-RPC stream.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMcpServer, stopMcpServer, logErr } from './mcp/server';

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'seo-mcp — an SEO MCP server (stdio).',
        '',
        'Tools: audit_page, export_audit_pdf, check_robots, check_sitemap, extract_schema, find_broken_links, keyword_ideas, pagespeed',
        '',
        'Usage: seo-mcp            # run as an MCP stdio server (launched by an MCP host)',
        '       seo-mcp --version',
        '',
        'Env:   PAGESPEED_API_KEY # optional — raises the PageSpeed Insights quota (the pagespeed tool also works keyless)',
        '',
      ].join('\n'),
    );
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(version() + '\n');
    return;
  }

  const shutdown = async () => {
    await stopMcpServer();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await startMcpServer(version());
}

main().catch((err) => {
  logErr(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
