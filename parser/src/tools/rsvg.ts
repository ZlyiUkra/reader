import { runTool } from './run.ts';
import type { ToolBudget } from './run.ts';

/**
 * Renders an SVG to a PNG of a fixed width with the height following the drawing, the same width as a page preview
 * (R8). `--keep-aspect-ratio` makes the width alone decide the size; the caller checks the result against the caps.
 */
export async function renderSvg(svg: string, png: string, widthPx: number, budget: ToolBudget): Promise<void> {
  await runTool('rsvg-convert', ['--format', 'png', '--width', String(widthPx), '--keep-aspect-ratio', '--output', png, svg], budget);
}

/** The version of librsvg from `rsvg-convert --version`, such as `2.54.7`. */
export async function rsvgVersion(budget: ToolBudget): Promise<string> {
  const { stdout } = await runTool('rsvg-convert', ['--version'], budget);
  return /version\s+(\S+)/.exec(stdout.toString('utf8'))?.[1] ?? 'unknown';
}
