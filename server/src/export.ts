import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FastifyReply } from 'fastify';
import type { Member } from './members.ts';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const devanagariFont = join(dirname(require.resolve('@fontsource/noto-sans-devanagari/package.json')), 'files', 'noto-sans-devanagari-devanagari-400-normal.woff');

const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ]/;

/** PDF fonts can't draw emoji or symbols; drop them so names don't show empty boxes. */
function pdfSafe(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Write a name, switching to the Devanagari font for Hindi/Marathi parts. */
function writeName(doc: PDFKit.PDFDocument, raw: string, x: number, y: number) {
  const name = pdfSafe(raw);
  const text = name.length > 42 ? `${name.slice(0, 41)}…` : name || '—';
  const runs = text.match(/[ऀ-ॿ꣠-ꣿ]+(?:[\sऀ-ॿ꣠-ꣿ]*[ऀ-ॿ꣠-ꣿ])?|[^ऀ-ॿ꣠-ꣿ]+/g) ?? [text];
  doc.x = x;
  doc.y = y;
  runs.forEach((run, i) => {
    doc.font(DEVANAGARI.test(run) ? 'devanagari' : 'regular').text(run, i === 0 ? x : undefined, i === 0 ? y : undefined, { continued: i < runs.length - 1, lineBreak: false });
  });
}

export interface ExportRow {
  name: string;
  phone: string; // recipient key, so a re-upload maps back to the same person
  hidden: boolean;
}

export function toRows(members: Member[]): ExportRow[] {
  return members.map((m) => ({ name: m.name ?? '', phone: m.phone, hidden: m.phone.endsWith('@lid') }));
}

function fileName(title: string, ext: string): string {
  const safe = title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'contacts';
  return `${safe}.${ext}`;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV that our own upload understands (name, phone). Excel opens it fine; BOM keeps non-English names intact. */
export function sendCsv(reply: FastifyReply, title: string, rows: ExportRow[]) {
  const lines = ['name,phone', ...rows.map((r) => `${csvCell(r.name)},${csvCell(r.hidden ? r.phone : `+${r.phone}`)}`)];
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName(title, 'csv'))}"`)
    .send(`﻿${lines.join('\r\n')}\r\n`);
}

export function sendPdf(reply: FastifyReply, title: string, rows: ExportRow[]) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: title } });
  doc.registerFont('regular', join(fontDir, 'DejaVuSans.ttf'));
  doc.registerFont('bold', join(fontDir, 'DejaVuSans-Bold.ttf'));
  doc.registerFont('devanagari', devanagariFont);

  const hiddenCount = rows.filter((r) => r.hidden).length;
  doc.font('bold').fontSize(16).text(title);
  doc.font('regular').fontSize(9).fillColor('#555')
    .text(`${rows.length} contacts · exported ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`)
    .text(hiddenCount ? `${hiddenCount} have their number hidden by WhatsApp (shown as an id).` : ' ');
  doc.moveDown(0.8);

  const x = { n: 40, name: 75, phone: 340 };
  const header = () => {
    doc.font('bold').fontSize(9).fillColor('#000');
    const y = doc.y;
    doc.text('#', x.n, y).text('Name', x.name, y).text('Phone', x.phone, y);
    doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#ccc').stroke();
    doc.moveDown(0.4);
  };
  header();
  doc.font('regular').fontSize(9);
  rows.forEach((r, i) => {
    if (doc.y > 790) {
      doc.addPage();
      header();
      doc.font('regular').fontSize(9);
    }
    const y = doc.y;
    doc.font('regular').fillColor('#000').text(String(i + 1), x.n, y, { width: 30, lineBreak: false });
    writeName(doc, r.name, x.name, y);
    doc.font('regular').fillColor(r.hidden ? '#888' : '#000').text(r.hidden ? `hidden (${r.phone})` : `+${r.phone}`, x.phone, y, { width: 215, lineBreak: false });
    doc.x = 40;
    doc.y = y + 14;
  });

  reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName(title, 'pdf'))}"`);
  doc.end();
  return reply.send(doc);
}

/** Parse an uploaded CSV: finds the phone and name columns by header, or guesses when there's no header. */
export function parseContactsCsv(text: string): Array<{ phone: string; name: string | null }> {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length === 0) return [];
  const looksLikePhone = (c: string | undefined) => !!c && (/@lid$/i.test(c.trim()) || /^[+\d\s().-]{7,}$/.test(c.trim()) && c.replace(/\D/g, '').length >= 7);
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = !rows[0].some(looksLikePhone);
  const body = hasHeader ? rows.slice(1) : rows;
  const width = Math.max(...rows.map((r) => r.length));

  // Phone column = the one where most cells look like a phone number (header words break ties),
  // so exports like Google Contacts ("Phone 1 - Type", "Phone 1 - Value") pick the right one.
  let phoneCol = -1;
  let best = 0;
  for (let i = 0; i < width; i++) {
    const hits = body.filter((r) => looksLikePhone(r[i])).length + (hasHeader && /phone|mobile|number|whatsapp|cell/.test(head[i] ?? '') ? 0.5 : 0);
    if (hits > best) { best = hits; phoneCol = i; }
  }
  if (phoneCol === -1 || best < 1) return [];

  let nameCol = -1;
  if (hasHeader) {
    nameCol = head.findIndex((h) => /^(name|full name|display name|contact name)$/.test(h));
    if (nameCol === -1) nameCol = head.findIndex((h, i) => i !== phoneCol && /name/.test(h));
  } else {
    nameCol = (body[0] ?? []).findIndex((c, i) => i !== phoneCol && /\p{L}/u.test(c) && !looksLikePhone(c));
  }
  return body
    .filter((r) => r[phoneCol]?.trim())
    .map((r) => ({ phone: r[phoneCol].trim(), name: nameCol >= 0 ? r[nameCol]?.trim() || null : null }));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}
