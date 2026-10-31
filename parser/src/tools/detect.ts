import { runTool } from './run.ts';
import type { ToolBudget } from './run.ts';

/**
 * The content type of a file by what is inside it, never by its name (FR-010): `file --mime-type -b`. The answer is
 * checked against a plain pattern before it is used, so odd output of the tool cannot reach a command line or a manifest.
 */
export async function detectMime(path: string, budget: ToolBudget): Promise<string> {
  const { stdout } = await runTool('file', ['--mime-type', '-b', path], budget);
  const answer = stdout.toString('utf8').split('\n')[0]?.trim() ?? '';
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(answer) ? answer : 'application/octet-stream';
}
