import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path/posix';
import { isEdrpou, isUaIban } from '../../app/src/shared/checksums.ts';
import { vatOf, vatSumHolds } from '../../app/src/shared/values.ts';
import { fixtures } from './data.ts';
import type { Fixture, FixtureType, Writing } from './data.ts';

/**
 * The fixtures generator (C17, FR-044): turns the data object of `data.ts` and the HTML templates into the eleven
 * synthetic documents, `manifest.json` and one `expected/<sha256>.json` per document, in the inbox. It is a one-off
 * program of the `fixtures` image: no network, a read-only root, scratch space on tmpfs.
 *
 * The output is a function of the data, the templates and the tools in the image, so two runs give the same bytes. The
 * generator never overwrites: a file already in the inbox is left alone when the new bytes are identical, and a
 * difference stops the run and names the file, unless `--replace` is given. That makes a second run a real check of
 * determinism, not a rewrite.
 */

/** Fixed clock of the generated documents: 2026-03-01T00:00:00Z. Every tool that stamps a date is told this one. */
const sourceDateEpoch = '1772323200';

/** The largest time one external tool may take, and the most output the generator keeps from one. */
const toolTimeoutMs = 180_000;
const toolOutputLimit = 4 * 1024 * 1024;

/** The settings of the scans: the resolution of the rendered page, then the distortions that make it look scanned (R8). */
const scan = { dpi: 200, rotateDegrees: { png: 1, jpg: -0.8 }, blur: '0x0.4', noiseAttenuate: 0.2, noiseSeed: 7, jpegQuality: 80 };

/** The A4 page of the templates in pixels at the scan resolution, as `pdftoppm` rounds it (595.304 x 841.89 pt). */
const scanPage = { width: Math.ceil((595.304 * scan.dpi) / 72), height: Math.ceil((841.89 * scan.dpi) / 72) };

/** Where the generator reads and writes; both come from the environment of the compose service (contracts/compose.md). */
const inboxDir = process.env['READER_INBOX_DIR'] ?? '/inbox';
const schemasDir = process.env['READER_SCHEMAS_DIR'] ?? '/schemas';
const templatesDir = path.join(import.meta.dirname, 'templates');

/** The result of one external tool: its standard output, as bytes. */
export type ToolResult = { stdout: Buffer };

/**
 * Runs one external tool under its own timeout, in its own process group so a timeout kills the descendants too (the
 * rule of AGENTS.md for child processes). It resolves only on exit code 0; any other end is an `Error` carrying the
 * command and the tail of its standard error, never a swallowed failure.
 */
export function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch, TZ: 'UTC', ...env },
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL');
      }
    }, toolTimeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes <= toolOutputLimit) {
        out.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && outBytes <= toolOutputLimit) {
        resolve({ stdout: Buffer.concat(out) });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} ended with ${signal ?? `code ${code}`}${outBytes > toolOutputLimit ? ', output over the limit' : ''}: ${err.trim()}`));
    });
  });
}

/** The sha256 of some bytes, lower-case hex: the identity of a document everywhere in the system. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True for an object that is not an array; the guard every JSON read below starts from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the generator needs from a type schema of the registry: the fields, which are required, their kinds and the checks. */
type TypeSchema = {
  required: string[];
  fields: Map<string, { kind: string; allowed: string[] | null }>;
  checks: Array<Record<string, unknown>>;
};

/** Reads one registry file into `TypeSchema`, or throws naming what is wrong with it. */
function readSchema(name: string, raw: unknown): TypeSchema {
  if (!isRecord(raw) || !Array.isArray(raw['required']) || !isRecord(raw['properties']) || !isRecord(raw['x-reader'])) {
    throw new Error(`The schema of ${name} is not shaped like a registry type`);
  }
  const fields = new Map<string, { kind: string; allowed: string[] | null }>();
  for (const [field, property] of Object.entries(raw['properties'])) {
    const meta = isRecord(property) ? property['x-reader'] : undefined;
    if (!isRecord(property) || !isRecord(meta) || typeof meta['kind'] !== 'string') {
      throw new Error(`Field ${field} of ${name} has no x-reader kind`);
    }
    fields.set(field, { kind: meta['kind'], allowed: Array.isArray(property['enum']) ? property['enum'].map(String) : null });
  }
  const checks = raw['x-reader']['checks'];
  return {
    required: raw['required'].map(String),
    fields,
    checks: Array.isArray(checks) ? checks.filter(isRecord) : [],
  };
}

/** Loads the registry files `schemas/<type>.v<n>.json` for the three typed documents, the highest version of each. */
async function loadSchemas(): Promise<Map<FixtureType, TypeSchema>> {
  const names = await readdir(schemasDir);
  const schemas = new Map<FixtureType, TypeSchema>();
  for (const type of ['invoice', 'act', 'contract'] as const) {
    const versions = names
      .map((name) => ({ name, match: new RegExp(`^${type}\\.v(\\d+)\\.json$`).exec(name) }))
      .filter((entry) => entry.match !== null)
      .sort((a, b) => Number(b.match?.[1]) - Number(a.match?.[1]));
    const latest = versions[0];
    if (latest === undefined) {
      throw new Error(`No schema for ${type} in ${schemasDir}`);
    }
    schemas.set(type, readSchema(latest.name, JSON.parse(await readFile(path.join(schemasDir, latest.name), 'utf8')) as unknown));
  }
  return schemas;
}

/** True when `iso` is a real calendar date written `YYYY-MM-DD`. */
function isIsoDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) {
    return false;
  }
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso);
}

/** The reason codes and checks a typed fixture would meet, derived from its fields and the registry rules alone. */
function deriveCodes(fields: Fixture['fields'], schema: TypeSchema): string[] {
  const codes: string[] = [];
  if (schema.required.some((field) => fields[field] === undefined)) {
    codes.push('MISSING_REQUIRED_FIELD');
  }
  for (const check of schema.checks) {
    const value = (field: unknown): string | number | undefined => (typeof field === 'string' ? fields[field] : undefined);
    const rule = check['rule'];
    let holds = true;
    if (rule === 'vat_sum') {
      const [net, vat, gross, rate] = [value(check['net']), value(check['vat']), value(check['gross']), check['rate']];
      holds = typeof net !== 'number' || typeof vat !== 'number' || typeof gross !== 'number' || typeof rate !== 'number' || vatSumHolds(net, vat, gross, rate);
    } else if (rule === 'date_order') {
      const [earlier, later] = [value(check['earlier']), value(check['later'])];
      holds = typeof earlier !== 'string' || typeof later !== 'string' || earlier <= later;
    } else if (rule === 'edrpou') {
      const code = value(check['field']);
      holds = typeof code !== 'string' || isEdrpou(code);
    } else if (rule === 'iban_ua') {
      const code = value(check['field']);
      holds = typeof code !== 'string' || isUaIban(code);
    }
    if (!holds && !codes.includes('VALIDATION_FAILED')) {
      codes.push('VALIDATION_FAILED');
    }
  }
  return codes;
}

/**
 * Checks the data object against the registry before anything is written, so a fixture that disagrees with its schema
 * is a stop here and not a surprise at evaluation time: the shape of the set (FR-045), every field known to the schema
 * and of its kind, and the status and codes written in `data.ts` equal to what the registry rules derive from the same
 * fields (FR-047, C14). Every defect found is listed in one error.
 */
function verifyData(schemas: Map<FixtureType, TypeSchema>): void {
  const problems: string[] = [];
  const typed = fixtures.filter((fixture) => fixture.type !== 'none');
  if (fixtures.length !== 11 || typed.length !== 10) {
    problems.push(`The set has ${fixtures.length} documents and ${typed.length} typed ones; 11 and 10 are expected`);
  }
  if (new Set(fixtures.map((fixture) => fixture.file)).size !== fixtures.length || fixtures.some((fixture) => !/^[a-z0-9.-]+$/.test(fixture.file))) {
    problems.push('File names must be unique and made of a-z, 0-9, dot and hyphen');
  }
  for (const type of ['invoice', 'act', 'contract'] as const) {
    const ofType = fixtures.filter((fixture) => fixture.type === type);
    const lacking = ofType.filter((fixture) => fixture.expected.codes.includes('MISSING_REQUIRED_FIELD'));
    if (lacking.length !== 1) {
      problems.push(`${type}: ${lacking.length} documents lack a required field, exactly 1 is expected`);
    }
  }
  for (const fixture of typed) {
    const schema = schemas.get(fixture.type);
    if (schema === undefined) {
      continue;
    }
    for (const [field, value] of Object.entries(fixture.fields)) {
      const meta = schema.fields.get(field);
      const kind = meta?.kind;
      const valid =
        meta === undefined ? false
        : kind === 'date' ? typeof value === 'string' && isIsoDate(value)
        : kind === 'money' ? typeof value === 'number' && Number.isInteger(value) && value >= 0
        : kind === 'edrpou' ? typeof value === 'string' && isEdrpou(value)
        : kind === 'iban' ? typeof value === 'string' && isUaIban(value)
        : kind === 'enum' ? typeof value === 'string' && (meta.allowed?.includes(value) ?? false)
        : typeof value === 'string' && value.length > 0;
      if (!valid) {
        problems.push(`${fixture.file}: field ${field} is unknown to the schema or is not a valid ${kind ?? 'value'}`);
      }
    }
    const derived = deriveCodes(fixture.fields, schema);
    if (derived.join() !== fixture.expected.codes.join()) {
      problems.push(`${fixture.file}: data.ts expects [${fixture.expected.codes.join()}], the registry rules derive [${derived.join()}]`);
    }
    if ((derived.length === 0 ? 'ACCEPTED' : 'NEEDS_REVIEW') !== fixture.expected.status) {
      problems.push(`${fixture.file}: the expected status does not follow from the codes`);
    }
    const net = fixture.fields['totalNet'];
    const vat = fixture.fields['vat'];
    if (fixture.expected.codes.includes('VALIDATION_FAILED') && typeof net === 'number' && typeof vat === 'number' && Math.abs(vat - vatOf(net, 20)) < 100) {
      problems.push(`${fixture.file}: the VAT must be off by at least 1 UAH (FR-045)`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`The fixture data is inconsistent:\n- ${problems.join('\n- ')}`);
  }
}

/** The months in the genitive, as dates are written in running Ukrainian text (the same list the value parser reads). */
const monthsGenitive = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/** An ISO date as it is printed: day, month and year with dots, or with the month as a word in the genitive and `r.` after the year. */
function formatDate(iso: string, style: Writing['dates']): string {
  const [year = '', month = '', day = ''] = iso.split('-');
  return style === 'dotted' ? `${day}.${month}.${year}` : `${Number(day)} ${monthsGenitive[Number(month) - 1] ?? ''} ${year} р.`;
}

/** An amount in kopiyky as it is printed: thousands grouped with a space or a non-breaking space, comma, two decimals. */
function formatMoney(kopiyky: number, style: Writing['thousands']): string {
  const whole = String(Math.trunc(kopiyky / 100)).replace(/\B(?=(\d{3})+$)/g, style === 'space' ? ' ' : '\u00a0');
  return `${whole},${String(kopiyky % 100).padStart(2, '0')}`;
}

/** The text a field value takes on the page, by the kind the schema gives the field. */
function display(fixture: Fixture, schema: TypeSchema | undefined, field: string, value: string | number): string {
  const kind = schema?.fields.get(field)?.kind;
  if (kind === 'date' && typeof value === 'string') {
    return formatDate(value, fixture.writing.dates);
  }
  if (kind === 'money' && typeof value === 'number') {
    return formatMoney(value, fixture.writing.thousands);
  }
  if (field === 'currency' && kind === 'enum') {
    return value === 'UAH' && fixture.writing.currency === 'word' ? 'грн' : String(value);
  }
  return String(value);
}

/** HTML-escapes text for an element body. */
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Fills a template: `{{#field}}...{{/field}}` is kept when the field has a value and dropped when it has none, which is
 * how a field that is missing from a document disappears together with its label; `{{field}}` is replaced by the
 * escaped value. A placeholder outside a block with no value is an error, never a blank.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const blocks = template.replace(/\{\{#([A-Za-z]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, field: string, inner: string) => (values[field] === undefined ? '' : inner));
  return blocks.replace(/\{\{([A-Za-z]+)\}\}/g, (_match, field: string) => {
    const value = values[field];
    if (value === undefined) {
      throw new Error(`The template needs a value for ${field}`);
    }
    return escapeHtml(value);
  });
}

/** Where one run keeps its scratch files, and the LibreOffice profile shared by its conversions. */
type Context = { work: string; profile: string };

/** The names of the fields the template of a typed fixture must show, checked against the registry once per run. */
async function verifyTemplates(schemas: Map<FixtureType, TypeSchema>): Promise<void> {
  const problems: string[] = [];
  for (const [type, schema] of schemas) {
    const html = await readFile(path.join(templatesDir, `${type}.html`), 'utf8');
    for (const field of schema.fields.keys()) {
      if (!html.includes(`{{${field}}}`)) {
        problems.push(`${type}.html does not show the field ${field}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`The templates disagree with the registry:\n- ${problems.join('\n- ')}`);
  }
}

/** Renders the template of a fixture to an HTML file in the scratch folder and returns its path. */
async function writeHtml(fixture: Fixture, schemas: Map<FixtureType, TypeSchema>, context: Context): Promise<string> {
  const schema = fixture.type === 'none' ? undefined : schemas.get(fixture.type);
  const values: Record<string, string> = {};
  for (const [field, value] of Object.entries(fixture.fields)) {
    values[field] = display(fixture, schema, field, value);
  }
  const html = renderTemplate(await readFile(path.join(templatesDir, `${fixture.template}.html`), 'utf8'), values);
  const target = path.join(context.work, 'html', `${stemOf(fixture)}.html`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html, 'utf8');
  return target;
}

/** The file name without its extension. */
function stemOf(fixture: Fixture): string {
  return fixture.file.slice(0, fixture.file.lastIndexOf('.'));
}

/** The input and output filters of LibreOffice per target (research R8): the HTML is opened by Writer, except for the sheet. */
const conversions = {
  pdf: { infilter: 'HTML (StarWriter)', convertTo: 'pdf:writer_pdf_Export', extension: 'pdf' },
  docx: { infilter: 'HTML (StarWriter)', convertTo: 'docx:MS Word 2007 XML', extension: 'docx' },
  doc: { infilter: 'HTML (StarWriter)', convertTo: 'doc:MS Word 97', extension: 'doc' },
  rtf: { infilter: 'HTML (StarWriter)', convertTo: 'rtf:Rich Text Format', extension: 'rtf' },
  xlsx: { infilter: 'calc_HTML_WebQuery', convertTo: 'xlsx:Calc MS Excel 2007 XML', extension: 'xlsx' },
} as const;

/** Converts an HTML file with LibreOffice into one of the office formats and returns the bytes of the result. */
async function soffice(html: string, target: keyof typeof conversions, context: Context): Promise<Buffer> {
  const conversion = conversions[target];
  const outDir = path.join(context.work, 'office', target);
  await mkdir(outDir, { recursive: true });
  await run('soffice', [
    '--headless',
    '--norestore',
    '--nologo',
    `-env:UserInstallation=file://${context.profile}`,
    `--infilter=${conversion.infilter}`,
    '--convert-to',
    conversion.convertTo,
    '--outdir',
    outDir,
    html,
  ]);
  const output = path.join(outDir, `${path.basename(html, '.html')}.${conversion.extension}`);
  try {
    return await readFile(output);
  } catch (error) {
    throw new Error(`soffice produced no ${conversion.extension} for ${html}`, { cause: error });
  }
}

/** The fixed clock as the 14 digits of a PDF date, `20260301000000`. */
const fixedPdfStamp = new Date(Number(sourceDateEpoch) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/**
 * Sets what differs from run to run in a PDF written by LibreOffice to fixed values: the creation and modification
 * dates become the fixed clock (LibreOffice 7.4 stamps the real time and does not read `SOURCE_DATE_EPOCH`), the
 * document id becomes zeros, because qpdf keeps the first half of an id it finds in its input, and so does the
 * `/DocChecksum` that LibreOffice adds to the trailer and that changes from run to run. Every replacement has the
 * length of what it replaces, so no offset of the file moves.
 */
export function fixPdfStamps(pdf: Buffer): Buffer {
  const text = pdf
    .toString('latin1')
    .replace(/(\/(?:CreationDate|ModDate) \(D:)\d{14}/g, `$1${fixedPdfStamp}`)
    .replace(/(\/DocChecksum \/)[0-9A-F]{32}/g, `$1${'0'.repeat(32)}`)
    .replace(/(\/ID \[)<([0-9a-f]+)><([0-9a-f]+)>(\])/g, (_match, open: string, first: string, second: string, close: string) => `${open}<${'0'.repeat(first.length)}><${'0'.repeat(second.length)}>${close}`);
  return Buffer.from(text, 'latin1');
}

/**
 * Makes a PDF byte-stable (R8) in two qpdf passes. The first unpacks the object streams, because LibreOffice keeps the
 * dates in a compressed one and they cannot be replaced there; the dates and the id are then fixed; the second pass derives
 * the document id from the content, which no longer holds a real time.
 */
async function normalizePdf(pdf: Buffer, context: Context, name: string): Promise<Buffer> {
  const dir = path.join(context.work, 'pdf');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.raw.pdf`), pdf);
  await run('qpdf', ['--object-streams=disable', '--remove-page-labels', path.join(dir, `${name}.raw.pdf`), path.join(dir, `${name}.plain.pdf`)]);
  await writeFile(path.join(dir, `${name}.dated.pdf`), fixPdfStamps(await readFile(path.join(dir, `${name}.plain.pdf`))));
  await run('qpdf', ['--deterministic-id', '--object-streams=disable', path.join(dir, `${name}.dated.pdf`), path.join(dir, `${name}.pdf`)]);
  return readFile(path.join(dir, `${name}.pdf`));
}

/** The text PDF of a fixture: LibreOffice's PDF export, then qpdf. Also the page the scans, the PNG, the JPG and the SVG come from. */
async function textPdf(fixture: Fixture, schemas: Map<FixtureType, TypeSchema>, context: Context): Promise<Buffer> {
  const html = await writeHtml(fixture, schemas, context);
  return normalizePdf(await soffice(html, 'pdf', context), context, stemOf(fixture));
}

/** The fixed clock as the two 16-bit fields of a zip entry: DOS time (hours, minutes, seconds / 2) and DOS date. */
export const fixedDosTime = (Number(fixedPdfStamp.slice(8, 10)) << 11) | (Number(fixedPdfStamp.slice(10, 12)) << 5) | (Number(fixedPdfStamp.slice(12, 14)) >> 1);
export const fixedDosDate = ((Number(fixedPdfStamp.slice(0, 4)) - 1980) << 9) | (Number(fixedPdfStamp.slice(4, 6)) << 5) | Number(fixedPdfStamp.slice(6, 8));

/**
 * Sets the modification time of every entry of a zip file (DOCX and XLSX are zip files) to the fixed clock. LibreOffice
 * writes the real time into each entry header, and nothing else in its OOXML output depends on the clock. The entries
 * are found through the central directory, not by searching for signatures, because compressed data may contain
 * any four bytes; both the central entry and its local header are patched, and no length changes.
 */
export function fixZipTimes(zip: Buffer): Buffer {
  const out = Buffer.from(zip);
  const end = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) {
    throw new Error('Not a zip file: no end-of-directory record');
  }
  let entry = out.readUInt32LE(end + 16);
  for (let index = 0; index < out.readUInt16LE(end + 10); index += 1) {
    const local = out.readUInt32LE(entry + 42);
    if (out.readUInt32LE(entry) !== 0x02014b50 || out.readUInt32LE(local) !== 0x04034b50) {
      throw new Error('Not a zip file: a directory entry does not point at a local header');
    }
    out.writeUInt16LE(fixedDosTime, entry + 12);
    out.writeUInt16LE(fixedDosDate, entry + 14);
    out.writeUInt16LE(fixedDosTime, local + 10);
    out.writeUInt16LE(fixedDosDate, local + 12);
    entry += 46 + out.readUInt16LE(entry + 28) + out.readUInt16LE(entry + 30) + out.readUInt16LE(entry + 32);
  }
  return out;
}

/** Renders the first page of a PDF to a PNG at the scan resolution and returns its path. */
async function renderPage(pdf: Buffer, context: Context, name: string): Promise<string> {
  const input = path.join(context.work, 'raster', `${name}.pdf`);
  await mkdir(path.dirname(input), { recursive: true });
  await writeFile(input, pdf);
  const base = path.join(context.work, 'raster', name);
  await run('pdftoppm', ['-png', '-r', String(scan.dpi), '-singlefile', input, base]);
  return `${base}.png`;
}

/**
 * Makes a rendered page look scanned or photographed: a small rotation on a white ground cropped back to the page
 * size, a blur and Gaussian noise from a fixed seed, metadata stripped (FR-046, R8). ImageMagick is held to one thread,
 * because its noise generator is seeded per thread and a second thread would make the result depend on scheduling.
 */
async function degrade(png: string, context: Context, name: string, format: 'png' | 'jpg'): Promise<Buffer> {
  const output = path.join(context.work, 'raster', `${name}.degraded.${format}`);
  const quality = format === 'jpg' ? ['-quality', String(scan.jpegQuality), '-sampling-factor', '4:2:0'] : ['-define', 'png:exclude-chunk=all'];
  await run('convert', [
    '-limit', 'thread', '1',
    png,
    '-background', 'white',
    '-rotate', String(scan.rotateDegrees[format]),
    '-gravity', 'center', '-crop', `${scanPage.width}x${scanPage.height}+0+0`, '+repage',
    '-blur', scan.blur,
    '-seed', String(scan.noiseSeed), '-attenuate', String(scan.noiseAttenuate), '+noise', 'Gaussian',
    '-strip',
    ...quality,
    output,
  ]);
  return readFile(output);
}

/**
 * The scanned PDF: the degraded page as the only content of a PDF, without dates (`img2pdf --nodate`), then qpdf. The
 * page size is given as A4 because the PNG carries no resolution and img2pdf would assume 96 dpi.
 */
async function scannedPdf(fixture: Fixture, schemas: Map<FixtureType, TypeSchema>, context: Context): Promise<Buffer> {
  const name = stemOf(fixture);
  const page = await renderPage(await textPdf(fixture, schemas, context), context, name);
  const degraded = path.join(context.work, 'raster', `${name}.degraded.png`);
  await degrade(page, context, name, 'png');
  const output = path.join(context.work, 'raster', `${name}.scan.pdf`);
  await run('img2pdf', ['--nodate', '--pagesize', 'A4', '--output', output, degraded]);
  return normalizePdf(await readFile(output), context, `${name}.scan`);
}

/** The SVG of a page: cairo's rendering of the text PDF, so the text is drawn as shapes and only OCR can read it. */
async function svgOf(fixture: Fixture, schemas: Map<FixtureType, TypeSchema>, context: Context): Promise<Buffer> {
  const name = stemOf(fixture);
  const input = path.join(context.work, 'svg', `${name}.pdf`);
  const output = path.join(context.work, 'svg', `${name}.svg`);
  await mkdir(path.dirname(input), { recursive: true });
  await writeFile(input, await textPdf(fixture, schemas, context));
  await run('pdftocairo', ['-svg', input, output]);
  return readFile(output);
}

/** Builds the file of one fixture in its format. */
async function build(fixture: Fixture, schemas: Map<FixtureType, TypeSchema>, context: Context): Promise<Buffer> {
  switch (fixture.format) {
    case 'pdf':
      return textPdf(fixture, schemas, context);
    case 'pdf-scan':
      return scannedPdf(fixture, schemas, context);
    case 'png':
    case 'jpg':
      return degrade(await renderPage(await textPdf(fixture, schemas, context), context, stemOf(fixture)), context, stemOf(fixture), fixture.format);
    case 'svg':
      return svgOf(fixture, schemas, context);
    case 'docx':
    case 'xlsx':
      return fixZipTimes(await soffice(await writeHtml(fixture, schemas, context), fixture.format, context));
    case 'doc':
    case 'rtf':
      return soffice(await writeHtml(fixture, schemas, context), fixture.format, context);
  }
}

/** One built document with its identity. */
export type Built = { fixture: Fixture; bytes: Buffer; sha256: string };

/** The `expected/<sha256>.json` of a fixture: the instance of the type schema, the expected status and the codes (FR-047). */
function expectedFile(built: Built): string {
  const { fixture } = built;
  return `${JSON.stringify({ file: fixture.file, sha256: built.sha256, type: fixture.type, format: fixture.format, instance: fixture.type === 'none' ? null : fixture.fields, status: fixture.expected.status, codes: fixture.expected.codes }, null, 2)}\n`;
}

/** The `manifest.json`: one row per fixture, `[{file, sha256, type, format, expected}]` (data-model.md). */
function manifestFile(built: Built[]): string {
  const rows = [...built]
    .sort((a, b) => a.fixture.file.localeCompare(b.fixture.file, 'en'))
    .map((entry) => ({ file: entry.fixture.file, sha256: entry.sha256, type: entry.fixture.type, format: entry.fixture.format, expected: `expected/${entry.sha256}.json` }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** What placing a file in the inbox did. */
export type Placement = 'written' | 'unchanged';

/**
 * Puts bytes at a relative path under the inbox without destroying anything: a new file is written, an identical one is
 * left as it is, a different one stops the run unless `replace` was asked for. Existing data is never replaced by
 * default (AGENTS.md, General).
 */
export async function place(relative: string, bytes: Uint8Array, replace: boolean): Promise<Placement> {
  const target = path.join(inboxDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  let existing: Buffer | null = null;
  try {
    existing = await readFile(target);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (existing !== null && Buffer.compare(existing, bytes) === 0) {
    return 'unchanged';
  }
  if (existing !== null && !replace) {
    throw new Error(`${target} exists with different content (${sha256(existing).slice(0, 12)} now, ${sha256(bytes).slice(0, 12)} generated); nothing was replaced, pass --replace to replace it`);
  }
  await writeFile(target, bytes);
  return 'written';
}

/** Generates the set and places it in the inbox; prints one line per file. */
async function main(): Promise<void> {
  const replace = process.argv.includes('--replace');
  const schemas = await loadSchemas();
  verifyData(schemas);
  await verifyTemplates(schemas);
  const work = await mkdtemp(path.join(tmpdir(), 'fixtures-'));
  const context: Context = { work, profile: path.join(work, 'lo-profile') };
  const built: Built[] = [];
  for (const fixture of fixtures) {
    const bytes = await build(fixture, schemas, context);
    built.push({ fixture, bytes, sha256: sha256(bytes) });
  }
  const outcomes: string[] = [];
  for (const entry of built) {
    const placed = await place(entry.fixture.file, entry.bytes, replace);
    await place(`expected/${entry.sha256}.json`, Buffer.from(expectedFile(entry), 'utf8'), replace);
    outcomes.push(`${placed.padEnd(9)} ${entry.sha256.slice(0, 12)} ${entry.fixture.format.padEnd(8)} ${entry.fixture.expected.status.padEnd(12)} ${entry.fixture.file}`);
  }
  const manifest = await place('manifest.json', Buffer.from(manifestFile(built), 'utf8'), replace);
  console.log(outcomes.join('\n'));
  console.log(`${manifest.padEnd(9)} manifest.json (${built.length} documents, the set sha256 ${sha256(Buffer.from(manifestFile(built), 'utf8')).slice(0, 12)})`);
  await rm(work, { recursive: true });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
