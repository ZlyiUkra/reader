import { spawn } from 'node:child_process';

/**
 * Why a tool did not finish normally. The parser maps the first two to `TOO_LARGE` (a tool over its own time or memory
 * limit, no retry) and `exit` to `CORRUPT` (the file made the tool fail), as AGENTS.md and contracts/parser.md fix.
 */
export type ToolFailure = 'timeout' | 'memory' | 'exit' | 'output';

/** What a tool run is allowed: its time, the address space of the process, the output it may produce. */
export type ToolBudget = {
  timeoutS: number;
  memoryMb: number;
};

/** The result of a tool that ended with exit code 0. */
export type ToolResult = {
  stdout: Buffer;
  stderr: string;
  elapsedMs: number;
};

/** A tool that ended badly, with what the parser needs to name the reason: the tool, the kind and the tail of stderr. */
export class ToolError extends Error {
  tool: string;
  kind: ToolFailure;
  exitCode: number | null;
  stderr: string;
  elapsedMs: number;

  constructor(tool: string, kind: ToolFailure, detail: { exitCode: number | null; stderr: string; elapsedMs: number }) {
    super(`${tool} failed (${kind}${detail.exitCode === null ? '' : `, exit ${detail.exitCode}`}): ${detail.stderr.trim().slice(-300)}`);
    this.name = 'ToolError';
    this.tool = tool;
    this.kind = kind;
    this.exitCode = detail.exitCode;
    this.stderr = detail.stderr;
    this.elapsedMs = detail.elapsedMs;
  }
}

/** The most output one tool may produce before it is killed; the largest legitimate output is the text of one page. */
export const maxOutputBytes = 8 * 1024 * 1024;

/** The messages with which a tool refuses to go on when its memory limit is reached. */
const memoryFailure = /cannot allocate memory|bad_alloc|out of memory|memory allocation|not enough memory/i;

/**
 * Runs one external tool the way contracts/parser.md and AGENTS.md require: in its own process group (`detached`), so
 * that a timeout kills the whole group and not only the leader; under its own timeout; with its address space limited
 * by `ulimit -v` through `sh`, so a runaway allocation fails the tool instead of the container. It resolves only on exit
 * code 0 and otherwise throws a `ToolError`. A tool that cannot be started at all throws the plain error of `spawn`,
 * because that is the image's fault and not the document's.
 */
export function runTool(command: string, args: string[], budget: ToolBudget, env: Record<string, string> = {}): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn('/bin/sh', ['-c', 'ulimit -v "$0" && exec "$@"', String(budget.memoryMb * 1024), command, ...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp', LANG: 'C.UTF-8', ...env },
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderr = '';
    let killedBy: ToolFailure | null = null;
    const killGroup = (reason: ToolFailure): void => {
      killedBy ??= reason;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group is already gone; the close event reports how it ended.
        }
      }
    };
    const timer = setTimeout(() => killGroup('timeout'), budget.timeoutS * 1000);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        killGroup('output');
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Whatever the leader left behind in its group goes too, also after a normal exit.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Nothing left in the group.
        }
      }
      const elapsedMs = performance.now() - started;
      if (killedBy === null && code === 0) {
        resolve({ stdout: Buffer.concat(chunks), stderr, elapsedMs });
        return;
      }
      const kind: ToolFailure = killedBy ?? (memoryFailure.test(stderr) ? 'memory' : 'exit');
      reject(new ToolError(command, kind, { exitCode: code, stderr, elapsedMs }));
    });
  });
}
