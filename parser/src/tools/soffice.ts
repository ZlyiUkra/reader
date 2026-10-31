import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path/posix';
import { runTool } from './run.ts';
import type { ToolBudget } from './run.ts';

/** The office formats the parser converts, by content type, with the extension LibreOffice is given (R8). */
export const officeExtensions: Record<string, string> = {
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * Converts an office document to PDF with LibreOffice in the job's own folder and returns the path of the PDF, or null
 * when LibreOffice produced nothing, which it does for a file it cannot load while still exiting with 0. The original
 * is copied to a name with the extension that its content type implies, because it lives read-only under a name without
 * one; each job has its own `UserInstallation` profile, so no state is shared between jobs (C8, C9).
 */
export async function convertToPdf(input: string, extension: string, workDir: string, budget: ToolBudget): Promise<string | null> {
  const source = path.join(workDir, `source.${extension}`);
  const outDir = path.join(workDir, 'converted');
  await mkdir(outDir, { recursive: true });
  await copyFile(input, source);
  await runTool(
    'soffice',
    ['--headless', '--norestore', '--nologo', `-env:UserInstallation=file://${path.join(workDir, 'lo')}`, '--convert-to', 'pdf', '--outdir', outDir, source],
    budget,
  );
  const produced = (await readdir(outDir)).filter((name) => name === 'source.pdf');
  return produced.length === 1 ? path.join(outDir, 'source.pdf') : null;
}

/** The version of LibreOffice from `soffice --version`, such as `7.4.7` (the first three numbers of the build). */
export async function sofficeVersion(workDir: string, budget: ToolBudget): Promise<string> {
  const { stdout } = await runTool('soffice', ['--headless', `-env:UserInstallation=file://${path.join(workDir, 'lo')}`, '--version'], budget);
  return /LibreOffice\s+(\d+\.\d+\.\d+)/.exec(stdout.toString('utf8'))?.[1] ?? 'unknown';
}
