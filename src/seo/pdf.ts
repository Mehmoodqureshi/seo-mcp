/**
 * src/seo/pdf.ts — render an audit result to a professionally laid-out PDF.
 *
 * Uses PDFKit (pure JS, no headless browser) so the report stays keyless and the
 * package stays light. `renderAuditPdf` streams a Letter-size document to disk
 * and resolves with the absolute output path.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import type { auditPage } from './audit';
import type { SiteAuditResult } from './site';

/** The shape returned by `auditPage` (inferred, so this never drifts). */
export type AuditResult = Awaited<ReturnType<typeof auditPage>>;

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  brand: '#4f46e5',
  brandDark: '#3730a3',
  ink: '#111827',
  body: '#374151',
  muted: '#6b7280',
  faint: '#9ca3af',
  line: '#e5e7eb',
  panel: '#f9fafb',
  white: '#ffffff',
  error: '#dc2626',
  warning: '#d97706',
  info: '#2563eb',
  success: '#16a34a',
} as const;

const PAGE = { size: 'LETTER' as const, width: 612, height: 792, margin: 50 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;
const BOTTOM = PAGE.height - 56; // leave room for the footer

type Severity = 'error' | 'warning' | 'info';
const severityColor = (s: Severity): string => (s === 'error' ? C.error : s === 'warning' ? C.warning : C.info);
const scoreColor = (n: number): string => (n >= 80 ? C.success : n >= 50 ? C.warning : C.error);
const scoreLabel = (n: number): string => (n >= 80 ? 'GOOD' : n >= 50 ? 'NEEDS WORK' : 'POOR');

type Doc = InstanceType<typeof PDFDocument>;

/**
 * Render `audit` to a PDF at `outPath` (or a sensible default next to the cwd).
 * Resolves with the absolute path written.
 */
export function renderAuditPdf(audit: AuditResult, outPath?: string): Promise<string> {
  const target = resolveOutPath(audit.url, outPath);
  mkdirSync(dirname(target), { recursive: true });

  const doc = new PDFDocument({ size: PAGE.size, margin: PAGE.margin, bufferPages: true, info: { Title: `SEO Audit — ${audit.url}`, Author: 'seo-mcp' } });
  const stream = createWriteStream(target);
  doc.pipe(stream);

  drawHeader(doc, audit);
  drawSummaryCards(doc, audit);
  drawIssues(doc, audit);
  drawMetadata(doc, audit);
  drawContentStructure(doc, audit);
  drawSocial(doc, audit);
  // Performance: render one section per PageSpeed report. A report carries its
  // own strategy, so a single PDF can hold both Mobile and Desktop.
  const reports = collectPageSpeedReports(audit);
  reports.forEach((ps, i) => {
    if (i > 0) {
      // Each additional strategy starts on its own page for a clean split.
      doc.addPage();
      doc.y = PAGE.margin;
      doc.x = PAGE.margin;
    }
    drawPageSpeed(doc, ps);
  });
  drawFooters(doc);

  doc.end();
  return new Promise<string>((res, rej) => {
    stream.on('finish', () => res(target));
    stream.on('error', rej);
  });
}

// ── Output path ────────────────────────────────────────────────────────────--
function resolveOutPath(url: string, outPath?: string): string {
  if (outPath && outPath.trim()) {
    const p = outPath.trim();
    const withExt = p.toLowerCase().endsWith('.pdf') ? p : `${p}.pdf`;
    return isAbsolute(withExt) ? withExt : resolve(process.cwd(), withExt);
  }
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/^www\./, '') || 'page';
  } catch {
    /* keep default */
  }
  const date = new Date().toISOString().slice(0, 10);
  const safe = host.replace(/[^a-z0-9.-]/gi, '_');
  return join(process.cwd(), `seo-audit-${safe}-${date}.pdf`);
}

// ── Header band + score badge ─────────────────────────────────────────────────
function drawHeader(doc: Doc, a: AuditResult): void {
  const h = 118;
  doc.save().rect(0, 0, PAGE.width, h).fill(C.brand);
  doc.rect(0, h, PAGE.width, 4).fill(C.brandDark).restore();

  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(22).text('SEO AUDIT REPORT', PAGE.margin, 34);

  doc.font('Helvetica').fontSize(11).fillColor('#e0e7ff');
  doc.text(truncate(a.url, 64), PAGE.margin, 66, { width: CONTENT_W - 140, lineBreak: false });
  doc.fontSize(9).fillColor('#c7d2fe').text(`Generated ${formatDate(new Date())}`, PAGE.margin, 86);

  // Score badge on the right.
  const bw = 112;
  const bx = PAGE.width - PAGE.margin - bw;
  const by = 26;
  const bh = 66;
  doc.roundedRect(bx, by, bw, bh, 8).fill(C.white);
  doc.fillColor(scoreColor(a.score)).font('Helvetica-Bold').fontSize(30).text(String(a.score), bx, by + 9, { width: bw - 36, align: 'center' });
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(8)
    .text('/ 100', bx + bw - 40, by + 22, { width: 32, align: 'left' });
  doc.fillColor(scoreColor(a.score)).font('Helvetica-Bold').fontSize(8).text(scoreLabel(a.score), bx, by + 46, { width: bw, align: 'center' });

  doc.y = h + 22;
  doc.x = PAGE.margin;
}

// ── Summary stat cards ─────────────────────────────────────────────────────-─
function drawSummaryCards(doc: Doc, a: AuditResult): void {
  const errors = a.issues.filter((i) => i.severity === 'error').length;
  const warnings = a.issues.filter((i) => i.severity === 'warning').length;
  const cards: Array<{ label: string; value: string; color?: string }> = [
    { label: 'HTTP STATUS', value: String(a.status), color: a.status >= 200 && a.status < 300 ? C.success : C.error },
    { label: 'ERRORS', value: String(errors), color: errors ? C.error : C.success },
    { label: 'WARNINGS', value: String(warnings), color: warnings ? C.warning : C.success },
    { label: 'WORDS', value: formatNum(a.wordCount) },
    { label: 'LOAD', value: `${a.fetchMs} ms` },
  ];
  const gap = 10;
  const w = (CONTENT_W - gap * (cards.length - 1)) / cards.length;
  const h = 52;
  const y = doc.y;
  cards.forEach((c, i) => {
    const x = PAGE.margin + i * (w + gap);
    doc.roundedRect(x, y, w, h, 6).fill(C.panel);
    doc.roundedRect(x, y, w, h, 6).lineWidth(0.5).stroke(C.line);
    doc.fillColor(c.color ?? C.ink).font('Helvetica-Bold').fontSize(16).text(c.value, x, y + 10, { width: w, align: 'center' });
    doc.fillColor(C.faint).font('Helvetica-Bold').fontSize(6.5).text(c.label, x, y + 33, { width: w, align: 'center', characterSpacing: 0.5 });
  });
  doc.y = y + h + 16;
}

// ── Issues ────────────────────────────────────────────────────────────────-─-
function drawIssues(doc: Doc, a: AuditResult): void {
  sectionHeading(doc, `Issues (${a.issues.length})`);
  if (a.issues.length === 0) {
    paragraph(doc, 'No issues detected — nice work.', C.success);
    return;
  }
  const order: Severity[] = ['error', 'warning', 'info'];
  const sorted = [...a.issues].sort((x, y) => order.indexOf(x.severity as Severity) - order.indexOf(y.severity as Severity));
  for (const issue of sorted) {
    ensureSpace(doc, 30);
    const sev = issue.severity as Severity;
    const color = severityColor(sev);
    const tx = PAGE.margin + 62;
    const tw = CONTENT_W - 62;
    const y = doc.y;
    // severity pill
    const pillW = 52;
    doc.roundedRect(PAGE.margin, y, pillW, 14, 7).fill(color);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(7).text(sev.toUpperCase(), PAGE.margin, y + 4, { width: pillW, align: 'center', characterSpacing: 0.5 });
    // message
    doc.fillColor(C.body).font('Helvetica-Bold').fontSize(10).text(issue.message, tx, y + 1, { width: tw });
    // recommended fix
    if (issue.fix) {
      doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(`Fix: ${issue.fix}`, tx, doc.y + 1, { width: tw });
    }
    doc.y = Math.max(doc.y, y + 16) + 6;
  }
  doc.moveDown(0.4);
}

// ── Metadata table ────────────────────────────────────────────────────────-─-
function drawMetadata(doc: Doc, a: AuditResult): void {
  sectionHeading(doc, 'Page Metadata');
  kv(doc, 'Title', a.title.text || '—', a.title.text ? `${a.title.length} chars` : undefined);
  kv(doc, 'Meta description', a.metaDescription.text || '—', a.metaDescription.text ? `${a.metaDescription.length} chars` : undefined);
  kv(doc, 'Canonical', a.canonical ?? '—');
  kv(doc, 'Meta robots', a.metaRobots ?? '—');
  kv(doc, 'Viewport', a.viewport ?? '—');
  kv(doc, 'Charset', a.charset ?? '—');
  kv(doc, 'Language', a.lang ?? '—');
  if (a.redirected) kv(doc, 'Redirected', `yes → ${a.url}`);
  doc.moveDown(0.4);
}

// ── Content & structure ───────────────────────────────────────────────────-─-
function drawContentStructure(doc: Doc, a: AuditResult): void {
  sectionHeading(doc, 'Content & Structure');
  const h = a.headings.counts;
  kv(doc, 'Headings', `H1: ${h.h1}   H2: ${h.h2}   H3: ${h.h3}   H4: ${h.h4}   H5: ${h.h5}   H6: ${h.h6}`);
  if (a.headings.h1.length) kv(doc, 'H1 text', a.headings.h1.map((t) => `“${truncate(t, 70)}”`).join('  •  '));
  kv(doc, 'Word count', formatNum(a.wordCount));
  kv(doc, 'Images', `${a.images.total} total · ${a.images.missingAlt} missing alt`);
  kv(doc, 'Links', `${a.links.internal} internal · ${a.links.external} external · ${a.links.total} total`);
  kv(doc, 'Structured data', a.structuredDataBlocks ? `${a.structuredDataBlocks} JSON-LD block(s)` : 'none');
  if (a.hreflang.length) kv(doc, 'hreflang', a.hreflang.join(', '));
  doc.moveDown(0.4);
}

// ── Social previews ───────────────────────────────────────────────────────-─-
function drawSocial(doc: Doc, a: AuditResult): void {
  const og = Object.entries(a.openGraph);
  const tw = Object.entries(a.twitter);
  if (!og.length && !tw.length) return;
  sectionHeading(doc, 'Social Sharing');
  if (og.length) for (const [k, v] of og) kv(doc, k, truncate(v, 90));
  if (tw.length) for (const [k, v] of tw) kv(doc, k, truncate(v, 90));
  doc.moveDown(0.4);
}

/**
 * Gather the PageSpeed reports to render. Supports both `pagespeedReports` (an
 * array — used to put Mobile + Desktop in one file) and the legacy single
 * `pagespeed` field. De-dupes and keeps a Mobile-then-Desktop order.
 */
function collectPageSpeedReports(a: AuditResult): any[] {
  const obj = a as { pagespeedReports?: any[]; pagespeed?: any };
  const list = Array.isArray(obj.pagespeedReports) ? obj.pagespeedReports.filter(Boolean) : obj.pagespeed ? [obj.pagespeed] : [];
  const order: Record<string, number> = { mobile: 0, desktop: 1 };
  return [...list].sort((x, y) => (order[x?.strategy] ?? 9) - (order[y?.strategy] ?? 9));
}

// ── Performance / PageSpeed (optional) ────────────────────────────────────-─-
function drawPageSpeed(doc: Doc, ps: any): void {
  if (!ps) return;
  const engine = ps.source === 'local-lighthouse' ? 'Local Lighthouse' : 'Google PageSpeed Insights';
  const strat = ps.strategy ? ps.strategy.charAt(0).toUpperCase() + ps.strategy.slice(1) : '';
  sectionHeading(doc, `Performance — ${strat} · ${engine}`);
  if (!ps.ok) {
    paragraph(doc, `Performance data unavailable: ${ps.error ?? 'unknown error'}`, C.muted);
    return;
  }

  const detail = ps.detail;

  // 1) Category scores (Performance / Accessibility / Best Practices / SEO).
  if (Array.isArray(detail?.categories) && detail.categories.length) {
    drawCategoryScores(doc, detail.categories);
  } else if (typeof ps.performanceScore === 'number') {
    drawCategoryScores(doc, [{ id: 'performance', title: 'Performance', score: ps.performanceScore }]);
  }

  // 2) Core Web Vitals (lab).
  subHeading(doc, 'Core Web Vitals (lab)');
  drawVitals(doc, ps.lab ?? {});

  // 3) Real-user field data (CrUX), if present.
  if (ps.field) {
    subHeading(doc, 'Real-User Experience (CrUX field data)');
    const f = ps.field;
    if (f.overallCategory) kv(doc, 'Overall', String(f.overallCategory));
    const fieldRow = (label: string, m: any): void => {
      if (m && (m.category || typeof m.percentile === 'number')) {
        const p = typeof m.percentile === 'number' ? ` (${formatNum(m.percentile)})` : '';
        kv(doc, label, `${m.category ?? '—'}${p}`);
      }
    };
    fieldRow('LCP', f.largestContentfulPaint);
    fieldRow('INP', f.interactionToNextPaint);
    fieldRow('CLS', f.cumulativeLayoutShift);
    fieldRow('FCP', f.firstContentfulPaint);
    fieldRow('TTFB', f.timeToFirstByte);
  }

  // 4) Diagnostics — server response, DOM size, page weight, request count.
  if (Array.isArray(detail?.diagnostics) && detail.diagnostics.length) {
    subHeading(doc, 'Diagnostics');
    for (const d of detail.diagnostics) kv(doc, d.label, d.value);
  }

  // 5) Page weight by resource type.
  if (Array.isArray(detail?.resources) && detail.resources.length) {
    subHeading(doc, 'Page Weight by Resource');
    drawResourceTable(doc, detail.resources);
  }

  // 6) Top opportunities (time savings).
  if (Array.isArray(ps.opportunities) && ps.opportunities.length) {
    subHeading(doc, 'Top Opportunities (estimated savings)');
    drawOpportunities(doc, ps.opportunities);
  }

  // 7) Suggestions — failing/weak audits, grouped by category, with guidance.
  if (Array.isArray(detail?.suggestions) && detail.suggestions.length) {
    subHeading(doc, `Suggestions (${detail.suggestions.length})`);
    drawFindings(doc, detail.suggestions);
  }

  // 8) Best practices already followed (passed checks).
  if (Array.isArray(detail?.passed) && detail.passed.length) {
    const total = detail.passedCount ?? detail.passed.length;
    subHeading(doc, `Passed Audits (${total})`);
    drawPassedList(doc, detail.passed, total);
  }

  doc.moveDown(0.4);
}

interface Cat {
  id: string;
  title: string;
  score: number | null;
}

/** A row of category score chips (Performance / Accessibility / Best Practices / SEO). */
function drawCategoryScores(doc: Doc, cats: Cat[]): void {
  const gap = 10;
  const w = (CONTENT_W - gap * (cats.length - 1)) / cats.length;
  const h = 56;
  ensureSpace(doc, h + 10);
  const y = doc.y;
  cats.forEach((c, i) => {
    const x = PAGE.margin + i * (w + gap);
    const col = c.score == null ? C.muted : scoreColor(c.score);
    doc.roundedRect(x, y, w, h, 6).fill(C.panel);
    doc.roundedRect(x, y, w, h, 6).lineWidth(0.5).stroke(C.line);
    doc.fillColor(col).font('Helvetica-Bold').fontSize(20).text(c.score == null ? '—' : String(c.score), x, y + 9, { width: w, align: 'center' });
    doc.fillColor(C.faint).font('Helvetica-Bold').fontSize(7).text(c.title.toUpperCase(), x, y + 36, { width: w, align: 'center', characterSpacing: 0.4 });
  });
  doc.y = y + h + 12;
}

/** Core Web Vitals with per-metric GOOD/NEEDS-WORK/POOR status. */
function drawVitals(doc: Doc, lab: any): void {
  const rows: Array<{ key: string; label: string }> = [
    { key: 'largestContentfulPaint', label: 'LCP — Largest Contentful Paint' },
    { key: 'cumulativeLayoutShift', label: 'CLS — Cumulative Layout Shift' },
    { key: 'totalBlockingTime', label: 'TBT — Total Blocking Time' },
    { key: 'firstContentfulPaint', label: 'FCP — First Contentful Paint' },
    { key: 'speedIndex', label: 'Speed Index' },
    { key: 'timeToInteractive', label: 'Time to Interactive' },
  ];
  for (const r of rows) {
    const m = lab[r.key];
    if (!m) continue;
    const st = vitalStatus(r.key, typeof m.value === 'number' ? m.value : null);
    kvStatus(doc, r.label, m.display ?? '—', st);
  }
}

type Status = { label: string; color: string } | null;
function vitalStatus(key: string, v: number | null): Status {
  if (v == null) return null;
  const band = (good: number, ni: number): Status =>
    v <= good ? { label: 'GOOD', color: C.success } : v <= ni ? { label: 'NEEDS WORK', color: C.warning } : { label: 'POOR', color: C.error };
  switch (key) {
    case 'largestContentfulPaint':
      return band(2500, 4000);
    case 'cumulativeLayoutShift':
      return band(0.1, 0.25);
    case 'totalBlockingTime':
      return band(200, 600);
    case 'firstContentfulPaint':
      return band(1800, 3000);
    case 'speedIndex':
      return band(3400, 5800);
    case 'timeToInteractive':
      return band(3800, 7300);
    default:
      return null;
  }
}

/** Resource-weight table: Type | Requests | Size. */
function drawResourceTable(doc: Doc, rows: Array<{ type: string; requests: number; display: string }>): void {
  const c1 = PAGE.margin;
  const c2 = PAGE.margin + CONTENT_W * 0.6;
  const c3 = PAGE.margin + CONTENT_W * 0.8;
  ensureSpace(doc, 16);
  let y = doc.y;
  doc.fillColor(C.faint).font('Helvetica-Bold').fontSize(7.5);
  doc.text('RESOURCE TYPE', c1, y, { width: CONTENT_W * 0.6 });
  doc.text('REQUESTS', c2, y, { width: CONTENT_W * 0.2, align: 'right' });
  doc.text('TRANSFER SIZE', c3, y, { width: CONTENT_W * 0.2, align: 'right' });
  y += 12;
  doc.moveTo(c1, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(0.5).stroke(C.line);
  y += 4;
  for (const r of rows) {
    ensureSpace(doc, 14);
    if (doc.y > y) y = doc.y;
    const bold = /^total/i.test(r.type);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(C.body);
    doc.text(r.type, c1, y, { width: CONTENT_W * 0.6 });
    doc.text(formatNum(r.requests), c2, y, { width: CONTENT_W * 0.2, align: 'right' });
    doc.text(r.display, c3, y, { width: CONTENT_W * 0.2, align: 'right' });
    y += 14;
    doc.y = y;
  }
  doc.moveDown(0.2);
}

/** Opportunities as a title + right-aligned amber savings badge per row. */
function drawOpportunities(doc: Doc, opps: Array<{ title: string; estimatedSavingsMs: number }>): void {
  for (const o of opps) {
    ensureSpace(doc, 20);
    const y = doc.y;
    const badge = `~${formatNum(o.estimatedSavingsMs)} ms`;
    doc.font('Helvetica-Bold').fontSize(8);
    const badgeW = doc.widthOfString(badge) + 14;
    const bx = PAGE.width - PAGE.margin - badgeW;
    // title on the left (room left for the badge)
    doc.fillColor(C.body).font('Helvetica').fontSize(9.5).text(o.title, PAGE.margin, y + 2, { width: bx - PAGE.margin - 10 });
    const rowBottom = doc.y;
    // amber savings badge on the right
    doc.roundedRect(bx, y, badgeW, 15, 7).fill(C.warning);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8).text(badge, bx, y + 4, { width: badgeW, align: 'center' });
    doc.y = Math.max(rowBottom, y + 15) + 5;
  }
  doc.moveDown(0.1);
}

/** Passed checks as a tidy two-column bulleted list (no broken glyphs). */
function drawPassedList(doc: Doc, passed: Array<{ title: string }>, total: number): void {
  const colGap = 18;
  const colW = (CONTENT_W - colGap) / 2;
  const rowH = 13;
  const rows = Math.ceil(passed.length / 2);
  for (let r = 0; r < rows; r++) {
    ensureSpace(doc, rowH);
    const y = doc.y;
    for (let c = 0; c < 2; c++) {
      const idx = r * 2 + c;
      if (idx >= passed.length) break;
      const x = PAGE.margin + c * (colW + colGap);
      doc.fillColor(C.success).font('Helvetica-Bold').fontSize(8.5).text('•', x, y, { width: 8, lineBreak: false });
      doc.fillColor(C.body).font('Helvetica').fontSize(8.5).text(truncate(passed[idx].title, 58), x + 10, y, { width: colW - 10, lineBreak: false });
    }
    doc.y = y + rowH;
  }
  if (total > passed.length) {
    doc.fillColor(C.faint).font('Helvetica-Oblique').fontSize(8).text(`+ ${total - passed.length} more passed checks`, PAGE.margin, doc.y + 1, { width: CONTENT_W });
    doc.y += 12;
  }
  doc.moveDown(0.2);
}

/** Map a 0–100 audit score to a severity pill (lower = worse). */
function severityOf(score: number | null): { label: string; color: string } {
  if (score == null) return { label: 'REVIEW', color: C.muted };
  if (score === 0) return { label: 'FAILED', color: C.error };
  if (score < 50) return { label: 'POOR', color: C.error };
  return { label: 'IMPROVE', color: C.warning };
}

/** Grouped suggestions: per category, a severity pill + title + plain-English guidance. */
function drawFindings(doc: Doc, findings: Array<{ title: string; description: string; category: string; score: number | null; displayValue: string | null }>): void {
  const byCat = new Map<string, typeof findings>();
  for (const f of findings) {
    const list = byCat.get(f.category) ?? [];
    list.push(f);
    byCat.set(f.category, list);
  }
  for (const [cat, list] of byCat) {
    ensureSpace(doc, 18);
    doc.fillColor(C.brandDark).font('Helvetica-Bold').fontSize(9).text(cat.toUpperCase(), PAGE.margin, doc.y, { characterSpacing: 0.5 });
    doc.moveDown(0.2);
    const pillW = 58;
    for (const f of list) {
      const desc = f.description ? truncate(f.description, 260) : '';
      const titleLine = f.displayValue ? `${f.title} — ${f.displayValue}` : f.title;
      const sev = severityOf(f.score);
      doc.font('Helvetica').fontSize(9);
      const tx = PAGE.margin + pillW + 8;
      const tw = CONTENT_W - pillW - 8;
      const need = doc.heightOfString(titleLine, { width: tw }) + (desc ? doc.heightOfString(desc, { width: tw }) : 0) + 12;
      ensureSpace(doc, need);
      const y = doc.y;
      // severity pill (FAILED / IMPROVE) — clearer than a bare numeric score
      doc.roundedRect(PAGE.margin, y, pillW, 14, 7).fill(sev.color);
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(6.5).text(sev.label, PAGE.margin, y + 4, { width: pillW, align: 'center', characterSpacing: 0.3 });
      // title + description
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text(titleLine, tx, y, { width: tw });
      if (desc) doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(desc, tx, doc.y + 1, { width: tw });
      doc.y = Math.max(doc.y, y + 14) + 7;
    }
    doc.moveDown(0.2);
  }
}

// ── Shared drawing helpers ────────────────────────────────────────────────-─-
function sectionHeading(doc: Doc, title: string): void {
  ensureSpace(doc, 34);
  doc.moveDown(0.2);
  const y = doc.y;
  doc.rect(PAGE.margin, y + 1, 4, 13).fill(C.brand);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12.5).text(title, PAGE.margin + 12, y);
  const ly = doc.y + 4;
  doc.moveTo(PAGE.margin, ly).lineTo(PAGE.width - PAGE.margin, ly).lineWidth(0.5).stroke(C.line);
  doc.y = ly + 8;
}

/** A smaller heading used for subsections inside a section. */
function subHeading(doc: Doc, title: string): void {
  ensureSpace(doc, 22);
  doc.moveDown(0.3);
  doc.fillColor(C.brandDark).font('Helvetica-Bold').fontSize(10).text(title, PAGE.margin, doc.y);
  doc.moveDown(0.2);
}

/** A key/value row with a colored status pill on the right (for Core Web Vitals). */
function kvStatus(doc: Doc, label: string, value: string, status: { label: string; color: string } | null): void {
  ensureSpace(doc, 16);
  const y = doc.y;
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8.5).text(label.toUpperCase(), PAGE.margin, y + 2, { width: CONTENT_W * 0.55 });
  doc.fillColor(C.body).font('Helvetica-Bold').fontSize(9.5).text(value, PAGE.margin + CONTENT_W * 0.55, y, { width: CONTENT_W * 0.2, align: 'right' });
  if (status) {
    const pillW = 74;
    const px = PAGE.width - PAGE.margin - pillW;
    doc.roundedRect(px, y, pillW, 14, 7).fill(status.color);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(7).text(status.label, px, y + 4, { width: pillW, align: 'center', characterSpacing: 0.4 });
  }
  doc.y = y + 18;
}

const LABEL_W = 130;
function kv(doc: Doc, label: string, value: string, note?: string): void {
  doc.font('Helvetica').fontSize(9.5);
  const valW = CONTENT_W - LABEL_W - 10;
  const valH = doc.heightOfString(value, { width: valW });
  ensureSpace(doc, valH + 6);
  const y = doc.y;
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8.5).text(label.toUpperCase(), PAGE.margin, y + 1, { width: LABEL_W - 8 });
  doc.fillColor(C.body).font('Helvetica').fontSize(9.5).text(value, PAGE.margin + LABEL_W, y, { width: valW });
  if (note) doc.fillColor(C.faint).font('Helvetica-Oblique').fontSize(8).text(note, PAGE.margin + LABEL_W, doc.y, { width: valW });
  doc.y = Math.max(doc.y, y + valH) + 5;
}

function paragraph(doc: Doc, text: string, color: string = C.body): void {
  ensureSpace(doc, 20);
  doc.fillColor(color).font('Helvetica').fontSize(10).text(text, PAGE.margin, doc.y, { width: CONTENT_W });
  doc.moveDown(0.4);
}

/** Add a page if the next block of height `need` would overflow the footer area. */
function ensureSpace(doc: Doc, need: number): void {
  if (doc.y + need > BOTTOM) {
    doc.addPage();
    doc.y = PAGE.margin;
    doc.x = PAGE.margin;
  }
}

/** Footer on every page (drawn last so the page count is final). */
function drawFooters(doc: Doc): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Footers sit inside the bottom margin; zero it out so text() doesn't treat
    // the low y as an overflow and auto-append a blank page.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = PAGE.height - 38;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(0.5).stroke(C.line);
    doc.fillColor(C.faint).font('Helvetica').fontSize(8);
    doc.text('Generated by seo-mcp', PAGE.margin, y + 8, { width: CONTENT_W / 2, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, PAGE.margin + CONTENT_W / 2, y + 8, { width: CONTENT_W / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

// ── Site-wide report ──────────────────────────────────────────────────────-─-

/** Render a site-wide audit (many pages) to a single PDF. */
export function renderSiteAuditPdf(site: SiteAuditResult, outPath?: string, opts: { perPageDetails?: boolean } = {}): Promise<string> {
  const target = resolveSiteOutPath(site.site, outPath);
  mkdirSync(dirname(target), { recursive: true });

  const doc = new PDFDocument({ size: PAGE.size, margin: PAGE.margin, bufferPages: true, info: { Title: `Site SEO Audit — ${site.site}`, Author: 'seo-mcp' } });
  const stream = createWriteStream(target);
  doc.pipe(stream);

  drawSiteHeader(doc, site);
  drawSiteSummaryCards(doc, site);
  drawSiteCoverage(doc, site);
  drawCommonIssues(doc, site);
  drawPageTable(doc, site);
  if (opts.perPageDetails !== false) drawPageDetails(doc, site);
  drawPriorityPlan(doc, site);
  drawFooters(doc);

  doc.end();
  return new Promise<string>((res, rej) => {
    stream.on('finish', () => res(target));
    stream.on('error', rej);
  });
}

function resolveSiteOutPath(site: string, outPath?: string): string {
  if (outPath && outPath.trim()) {
    const p = outPath.trim();
    const withExt = p.toLowerCase().endsWith('.pdf') ? p : `${p}.pdf`;
    return isAbsolute(withExt) ? withExt : resolve(process.cwd(), withExt);
  }
  let host = 'site';
  try {
    host = new URL(site).hostname.replace(/^www\./, '') || 'site';
  } catch {
    /* keep default */
  }
  const date = new Date().toISOString().slice(0, 10);
  return join(process.cwd(), `seo-site-audit-${host.replace(/[^a-z0-9.-]/gi, '_')}-${date}.pdf`);
}

function drawSiteHeader(doc: Doc, s: SiteAuditResult): void {
  const h = 118;
  doc.save().rect(0, 0, PAGE.width, h).fill(C.brand);
  doc.rect(0, h, PAGE.width, 4).fill(C.brandDark).restore();
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(22).text('SITE-WIDE SEO AUDIT', PAGE.margin, 34);
  doc.font('Helvetica').fontSize(11).fillColor('#e0e7ff').text(truncate(s.site, 64), PAGE.margin, 66, { width: CONTENT_W - 140, lineBreak: false });
  doc.fontSize(9).fillColor('#c7d2fe').text(`${s.pagesAudited} pages · Generated ${formatDate(new Date())}`, PAGE.margin, 86);

  const avg = s.summary.avgScore ?? 0;
  const bw = 112;
  const bx = PAGE.width - PAGE.margin - bw;
  doc.roundedRect(bx, 26, bw, 66, 8).fill(C.white);
  doc.fillColor(scoreColor(avg)).font('Helvetica-Bold').fontSize(30).text(s.summary.avgScore == null ? '—' : String(avg), bx, 35, { width: bw - 36, align: 'center' });
  doc.fillColor(C.muted).font('Helvetica').fontSize(8).text('avg', bx + bw - 40, 48, { width: 32 });
  doc.fillColor(scoreColor(avg)).font('Helvetica-Bold').fontSize(8).text('AVG SCORE', bx, 72, { width: bw, align: 'center' });

  doc.y = h + 22;
  doc.x = PAGE.margin;
}

function drawSiteSummaryCards(doc: Doc, s: SiteAuditResult): void {
  const cards: Array<{ label: string; value: string; color?: string }> = [
    { label: 'PAGES AUDITED', value: String(s.pagesAudited) },
    { label: 'AVG SCORE', value: s.summary.avgScore == null ? '—' : String(s.summary.avgScore), color: s.summary.avgScore == null ? C.muted : scoreColor(s.summary.avgScore) },
    { label: 'SCORE RANGE', value: s.summary.minScore == null ? '—' : `${s.summary.minScore}–${s.summary.maxScore}` },
    { label: 'PAGES W/ ERRORS', value: String(s.summary.pagesWithErrors), color: s.summary.pagesWithErrors ? C.error : C.success },
    { label: 'TOTAL ISSUES', value: formatNum(s.summary.totalIssues) },
  ];
  const gap = 10;
  const w = (CONTENT_W - gap * (cards.length - 1)) / cards.length;
  const hgt = 52;
  const y = doc.y;
  cards.forEach((c, i) => {
    const x = PAGE.margin + i * (w + gap);
    doc.roundedRect(x, y, w, hgt, 6).fill(C.panel);
    doc.roundedRect(x, y, w, hgt, 6).lineWidth(0.5).stroke(C.line);
    doc.fillColor(c.color ?? C.ink).font('Helvetica-Bold').fontSize(16).text(c.value, x, y + 10, { width: w, align: 'center' });
    doc.fillColor(C.faint).font('Helvetica-Bold').fontSize(6.5).text(c.label, x, y + 33, { width: w, align: 'center', characterSpacing: 0.5 });
  });
  doc.y = y + hgt + 16;
}

function drawSiteCoverage(doc: Doc, s: SiteAuditResult): void {
  sectionHeading(doc, 'Coverage');
  kv(doc, 'Site', s.site);
  kv(doc, 'URL source', s.source);
  kv(doc, 'Pages in sitemap', String(s.pagesInSitemap));
  kv(doc, 'Pages audited', `${s.pagesAudited}${s.truncated ? `  (capped — ${s.pagesInSitemap - s.pagesAudited} more not audited)` : ''}`);
  const sitewide = [
    s.summary.missingTitle ? `${s.summary.missingTitle} missing title` : '',
    s.summary.missingMetaDesc ? `${s.summary.missingMetaDesc} missing meta description` : '',
    s.summary.missingH1 ? `${s.summary.missingH1} missing H1` : '',
    s.summary.noSchema ? `${s.summary.noSchema} without structured data` : '',
  ].filter(Boolean);
  if (sitewide.length) kv(doc, 'Site-wide gaps', sitewide.join(' · '));
  doc.moveDown(0.4);
}

function drawCommonIssues(doc: Doc, s: SiteAuditResult): void {
  if (!s.commonIssues.length) {
    sectionHeading(doc, 'Common Issues');
    paragraph(doc, 'No issues detected across the audited pages.', C.success);
    return;
  }
  sectionHeading(doc, `Common Issues (${s.commonIssues.length})`);
  // header
  ensureSpace(doc, 16);
  let y = doc.y;
  doc.fillColor(C.faint).font('Helvetica-Bold').fontSize(7.5);
  doc.text('ISSUE', PAGE.margin, y, { width: CONTENT_W - 90 });
  doc.text('PAGES AFFECTED', PAGE.margin + CONTENT_W - 90, y, { width: 90, align: 'right' });
  y += 12;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(0.5).stroke(C.line);
  y += 4;
  doc.y = y;
  for (const ci of s.commonIssues.slice(0, 18)) {
    ensureSpace(doc, 14);
    const yy = doc.y;
    const frac = ci.pages / Math.max(1, s.pagesAudited);
    const col = frac > 0.5 ? C.error : frac > 0.2 ? C.warning : C.body;
    doc.fillColor(col).font('Helvetica').fontSize(9).text(truncate(ci.issue, 78), PAGE.margin, yy, { width: CONTENT_W - 90 });
    doc.fillColor(col).font('Helvetica-Bold').fontSize(9).text(`${ci.pages} / ${s.pagesAudited}`, PAGE.margin + CONTENT_W - 90, yy, { width: 90, align: 'right' });
    doc.y = Math.max(doc.y, yy + 14);
  }
  doc.moveDown(0.4);
}

function drawPageTable(doc: Doc, s: SiteAuditResult): void {
  sectionHeading(doc, `Per-Page Results (${s.pagesAudited})`);
  const cScore = PAGE.margin;
  const cEW = PAGE.margin + 44;
  const cWords = PAGE.margin + 96;
  const cPath = PAGE.margin + 150;
  const headerRow = (): void => {
    ensureSpace(doc, 16);
    const y = doc.y;
    doc.fillColor(C.faint).font('Helvetica-Bold').fontSize(7.5);
    doc.text('SCORE', cScore, y, { width: 40 });
    doc.text('E / W', cEW, y, { width: 48 });
    doc.text('WORDS', cWords, y, { width: 48 });
    doc.text('PAGE', cPath, y, { width: PAGE.width - PAGE.margin - cPath });
    doc.y = y + 12;
    doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.width - PAGE.margin, doc.y).lineWidth(0.5).stroke(C.line);
    doc.y += 4;
  };
  headerRow();
  // worst pages first
  const rows = [...s.pages].sort((a, b) => (a.score ?? 999) - (b.score ?? 999));
  for (const p of rows) {
    if (doc.y + 14 > BOTTOM) {
      doc.addPage();
      doc.y = PAGE.margin;
      headerRow();
    }
    const y = doc.y;
    const path = pathOf(p.url, s.site);
    if (p.error) {
      doc.fillColor(C.error).font('Helvetica-Bold').fontSize(9).text('ERR', cScore, y, { width: 40 });
      doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(truncate(`${path} — ${p.error}`, 70), cPath, y, { width: PAGE.width - PAGE.margin - cPath });
      doc.y = y + 14;
      continue;
    }
    doc.fillColor(p.score == null ? C.muted : scoreColor(p.score)).font('Helvetica-Bold').fontSize(9.5).text(p.score == null ? '—' : String(p.score), cScore, y, { width: 40 });
    doc.fillColor(p.errors ? C.error : p.warnings ? C.warning : C.body).font('Helvetica').fontSize(9).text(`${p.errors} / ${p.warnings}`, cEW, y, { width: 48 });
    doc.fillColor(C.body).font('Helvetica').fontSize(9).text(formatNum(p.words), cWords, y, { width: 48 });
    doc.fillColor(C.body).font('Helvetica').fontSize(8.5).text(truncate(path, 72), cPath, y, { width: PAGE.width - PAGE.margin - cPath, lineBreak: false });
    doc.y = y + 14;
  }
}

function pathOf(url: string, site: string): string {
  try {
    const u = new URL(url);
    const p = (u.pathname + u.search) || '/';
    return p === '/' ? '/ (home)' : p;
  } catch {
    return url.replace(site, '') || url;
  }
}

/** One detail card per page: score, metadata, structure, and its issues. */
function drawPageDetails(doc: Doc, s: SiteAuditResult): void {
  sectionHeading(doc, `Per-Page Details (${s.pagesAudited})`);
  paragraph(doc, 'Each audited page in full — metadata, structure, and its specific issues. Ordered worst-score first.', C.muted);

  const rows = [...s.pages].sort((a, b) => (a.score ?? 999) - (b.score ?? 999));
  rows.forEach((p, i) => {
    drawPageDetailCard(doc, p, s.site, i + 1, rows.length);
  });
}

function drawPageDetailCard(doc: Doc, p: SiteAuditResult['pages'][number], site: string, index: number, total: number): void {
  ensureSpace(doc, 54);
  const path = pathOf(p.url, site);

  // Title bar: index, path, and a score chip on the right.
  const y = doc.y;
  const chipW = 46;
  const chipX = PAGE.width - PAGE.margin - chipW;
  const sc = p.score == null ? C.muted : scoreColor(p.score);
  doc.roundedRect(PAGE.margin, y, CONTENT_W, 20, 4).fill(C.panel);
  doc.fillColor(C.faint).font('Helvetica-Bold').fontSize(8).text(`${index}/${total}`, PAGE.margin + 8, y + 6, { width: 34, lineBreak: false });
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text(truncate(path, 74), PAGE.margin + 44, y + 6, { width: CONTENT_W - 44 - chipW - 10, lineBreak: false });
  doc.roundedRect(chipX, y + 3, chipW, 14, 7).fill(sc);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8).text(p.error ? 'ERR' : p.score == null ? '—' : String(p.score), chipX, y + 7, { width: chipW, align: 'center' });
  doc.y = y + 26;

  if (p.error) {
    kvSmall(doc, 'Error', p.error);
    drawDetailDivider(doc);
    return;
  }

  kvSmall(doc, 'Title', p.title || '—', p.title ? `${p.titleLen} chars` : undefined);
  kvSmall(doc, 'Meta description', p.metaDesc || '—', p.metaDesc ? `${p.metaDescLen} chars` : undefined);
  if (p.canonical) kvSmall(doc, 'Canonical', p.canonical);
  if (p.metaRobots) kvSmall(doc, 'Robots', p.metaRobots);
  const hc = p.headingCounts;
  kvSmall(doc, 'Headings', `H1:${hc.h1}  H2:${hc.h2}  H3:${hc.h3}  H4:${hc.h4}  H5:${hc.h5}  H6:${hc.h6}`);
  if (p.h1Text.length) kvSmall(doc, 'H1', p.h1Text.map((t) => `“${truncate(t, 60)}”`).join('  •  '));
  kvSmall(doc, 'Content', `${formatNum(p.words)} words · ${p.imagesTotal} images (${p.missingAlt} missing alt) · ${p.linksInternal} internal / ${p.linksExternal} external links · ${p.schema} schema block(s)`);

  // Issues for this page.
  if (p.issuesList.length) {
    ensureSpace(doc, 16);
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text(`ISSUES (${p.issuesList.length})`, PAGE.margin, doc.y, { characterSpacing: 0.5 });
    doc.y += 12;
    const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
    const sorted = [...p.issuesList].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    for (const issue of sorted) {
      const sev = issue.severity as Severity;
      const color = sev === 'error' ? C.error : sev === 'warning' ? C.warning : C.info;
      const itx = PAGE.margin + 52;
      const itw = CONTENT_W - 52;
      ensureSpace(doc, 16);
      const iy = doc.y;
      const pillW = 44;
      doc.roundedRect(PAGE.margin, iy, pillW, 12, 6).fill(color);
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(6.5).text(sev.toUpperCase(), PAGE.margin, iy + 3, { width: pillW, align: 'center', characterSpacing: 0.3 });
      doc.fillColor(C.body).font('Helvetica-Bold').fontSize(8.5).text(issue.message, itx, iy + 1, { width: itw });
      if (issue.fix) doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(`Fix: ${issue.fix}`, itx, doc.y, { width: itw });
      doc.y = Math.max(doc.y, iy + 13) + 4;
    }
  } else {
    doc.fillColor(C.success).font('Helvetica').fontSize(8.5).text('No issues — clean page.', PAGE.margin, doc.y, { width: CONTENT_W });
    doc.y += 12;
  }
  drawDetailDivider(doc);
}

/** Final action plan: site issues bucketed into Big / Medium / Small with fixes. */
function drawPriorityPlan(doc: Doc, s: SiteAuditResult): void {
  doc.addPage();
  doc.y = PAGE.margin;
  doc.x = PAGE.margin;
  sectionHeading(doc, 'Priority Recommendations');
  if (!s.commonIssues.length) {
    paragraph(doc, 'No issues found across the audited pages — no action needed.', C.success);
    return;
  }
  paragraph(doc, 'Every distinct issue found across the site, grouped by priority with the recommended fix. Tackle Big issues first.', C.muted);

  const total = s.pagesAudited;
  const big: typeof s.commonIssues = [];
  const medium: typeof s.commonIssues = [];
  const small: typeof s.commonIssues = [];
  for (const ci of s.commonIssues) {
    const frac = ci.pages / Math.max(1, total);
    if (ci.severity === 'error' || frac > 0.5) big.push(ci);
    else if (ci.severity === 'warning' || frac > 0.25) medium.push(ci);
    else small.push(ci);
  }
  drawPriorityGroup(doc, 'BIG ISSUES — fix first (high impact)', C.error, big, total);
  drawPriorityGroup(doc, 'MEDIUM ISSUES — worth addressing', C.warning, medium, total);
  drawPriorityGroup(doc, 'SMALL ISSUES — polish', C.info, small, total);
}

function drawPriorityGroup(doc: Doc, title: string, color: string, items: SiteAuditResult['commonIssues'], total: number): void {
  if (!items.length) return;
  ensureSpace(doc, 30);
  const y = doc.y;
  doc.roundedRect(PAGE.margin, y, CONTENT_W, 18, 4).fill(color);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(9).text(`${title}  (${items.length})`, PAGE.margin + 8, y + 5, { characterSpacing: 0.4 });
  doc.y = y + 24;
  for (const ci of items) {
    ensureSpace(doc, 24);
    const yy = doc.y;
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text(`• ${ci.issue}`, PAGE.margin, yy, { width: CONTENT_W - 72 });
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8.5).text(`${ci.pages} / ${total} pages`, PAGE.margin + CONTENT_W - 72, yy, { width: 72, align: 'right' });
    if (ci.fix) doc.fillColor(C.body).font('Helvetica').fontSize(8.5).text(`Fix: ${ci.fix}`, PAGE.margin + 12, doc.y + 1, { width: CONTENT_W - 12 });
    doc.y = doc.y + 7;
  }
  doc.moveDown(0.4);
}

/** Compact key/value used inside per-page detail cards. */
function kvSmall(doc: Doc, label: string, value: string, note?: string): void {
  const labelW = 96;
  const valW = CONTENT_W - labelW - 8;
  doc.font('Helvetica').fontSize(8.5);
  const valH = doc.heightOfString(value, { width: valW });
  ensureSpace(doc, valH + 4);
  const y = doc.y;
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7.5).text(label.toUpperCase(), PAGE.margin, y + 1, { width: labelW - 6 });
  doc.fillColor(C.body).font('Helvetica').fontSize(8.5).text(value, PAGE.margin + labelW, y, { width: valW });
  if (note) doc.fillColor(C.faint).font('Helvetica-Oblique').fontSize(7.5).text(note, PAGE.margin + labelW, doc.y, { width: valW });
  doc.y = Math.max(doc.y, y + valH) + 3;
}

function drawDetailDivider(doc: Doc): void {
  doc.y += 3;
  ensureSpace(doc, 7);
  doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.width - PAGE.margin, doc.y).lineWidth(0.5).stroke(C.line);
  doc.y += 6;
}

// ── Formatting ────────────────────────────────────────────────────────────-─-
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}
function formatDate(d: Date): string {
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
