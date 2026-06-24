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
  drawPageSpeed(doc, audit);
  drawFooters(doc, audit);

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
    paragraph(doc, 'No issues detected — nice work. ✔', C.success);
    return;
  }
  const order: Severity[] = ['error', 'warning', 'info'];
  const sorted = [...a.issues].sort((x, y) => order.indexOf(x.severity as Severity) - order.indexOf(y.severity as Severity));
  for (const issue of sorted) {
    ensureSpace(doc, 26);
    const sev = issue.severity as Severity;
    const color = severityColor(sev);
    const y = doc.y;
    // severity pill
    const pillW = 52;
    doc.roundedRect(PAGE.margin, y, pillW, 14, 7).fill(color);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(7).text(sev.toUpperCase(), PAGE.margin, y + 4, { width: pillW, align: 'center', characterSpacing: 0.5 });
    // message
    const tx = PAGE.margin + pillW + 10;
    doc.fillColor(C.body).font('Helvetica').fontSize(10);
    const textH = doc.heightOfString(issue.message, { width: CONTENT_W - pillW - 10 });
    doc.text(issue.message, tx, y + 1, { width: CONTENT_W - pillW - 10 });
    doc.y = y + Math.max(18, textH + 6);
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

// ── PageSpeed (optional) ──────────────────────────────────────────────────-─-
function drawPageSpeed(doc: Doc, a: AuditResult): void {
  const ps = (a as { pagespeed?: any }).pagespeed;
  if (!ps) return;
  sectionHeading(doc, `PageSpeed Insights (${ps.strategy ?? ''})`);
  if (!ps.ok) {
    paragraph(doc, `PageSpeed unavailable: ${ps.error ?? 'unknown error'}`, C.muted);
    return;
  }
  if (typeof ps.performanceScore === 'number') {
    const y = doc.y;
    doc.fillColor(C.body).font('Helvetica-Bold').fontSize(11).text('Performance score', PAGE.margin, y);
    doc.fillColor(scoreColor(ps.performanceScore)).font('Helvetica-Bold').fontSize(11).text(`${ps.performanceScore} / 100`, PAGE.margin, y, { width: CONTENT_W, align: 'right' });
    doc.y = y + 18;
  }
  const lab = ps.lab ?? {};
  const metric = (m: any): string => m?.display ?? '—';
  kv(doc, 'LCP (lab)', metric(lab.largestContentfulPaint));
  kv(doc, 'CLS (lab)', metric(lab.cumulativeLayoutShift));
  kv(doc, 'TBT (lab)', metric(lab.totalBlockingTime));
  kv(doc, 'FCP (lab)', metric(lab.firstContentfulPaint));
  kv(doc, 'Speed Index', metric(lab.speedIndex));
  if (Array.isArray(ps.opportunities) && ps.opportunities.length) {
    doc.moveDown(0.2);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text('Top opportunities', PAGE.margin, doc.y);
    doc.moveDown(0.2);
    for (const o of ps.opportunities) kv(doc, truncate(o.title, 60), `~${formatNum(o.estimatedSavingsMs)} ms`);
  }
  doc.moveDown(0.4);
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
function drawFooters(doc: Doc, a: AuditResult): void {
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
