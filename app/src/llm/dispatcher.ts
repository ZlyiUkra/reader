import type { ClassesFile } from '../config/types.ts';
import type { Logger } from '../shared/logger.ts';
import { LocalOnlyViolation, PromptOverBudget } from './port.ts';
import type { LlmAdapter, LlmPort, LlmRequest, LlmResponse } from './port.ts';
import type { ModelSettings } from './settings.ts';

/**
 * The dispatcher wraps the chosen adapter with the three rules every model call obeys (contracts/llm-port.md): a class
 * that may not leave never goes to a non-local adapter, a prompt that does not fit the context is refused before it is
 * sent, and only one call runs at a time (C7, constitution IV). These rules live here and not in the adapters so a new
 * adapter, the Claude one among them, cannot forget them.
 */
export type DispatcherDeps = {
  adapter: LlmAdapter;
  classes: ClassesFile;
  settings: ModelSettings;
  logger: Logger;
};

/**
 * Builds the port the pipeline uses. Both refusals are raised before anything is sent and before the call joins the
 * queue, so a refused call costs the queue nothing.
 */
export function createDispatcher(deps: DispatcherDeps): LlmPort {
  const { adapter, classes, settings, logger } = deps;

  /** The tail of the queue: every call starts after the previous one has finished, whatever its outcome. */
  let tail: Promise<unknown> = Promise.resolve();

  /**
   * Egress fails closed (FR-007): a class that is not in the closed list, or is in it without `may_leave`, is not sent to
   * an adapter that is not local. A local adapter takes any class, because nothing leaves the machine.
   */
  function gate(req: LlmRequest): void {
    if (adapter.local) {
      return;
    }
    const entry = classes.classes.find((candidate) => candidate.name === req.class);
    if (entry === undefined) {
      throw new LocalOnlyViolation(req.class, adapter.name, 'is not in the list of sensitivity classes');
    }
    if (!entry.may_leave) {
      throw new LocalOnlyViolation(req.class, adapter.name, 'may not leave the machine');
    }
  }

  /**
   * Estimates the prompt in tokens from its characters with the calibrated ratio and compares it with what the context
   * leaves after the generation cap. The wire schema is not counted: the server applies it as a grammar and does not put
   * it in the prompt. The chat template adds a few tokens of its own, which the ratio absorbs once the evaluation calibrates it.
   */
  function checkBudget(req: LlmRequest): void {
    const estimatedTokens = Math.ceil((req.system.length + req.user.length) / settings.charsPerToken);
    const availableTokens = settings.numCtx - req.numPredict;
    if (estimatedTokens > availableTokens) {
      logger.warn(
        { documentNumber: req.documentNumber, kind: req.kind, estimatedTokens, availableTokens },
        'The prompt does not fit the context window.',
      );
      throw new PromptOverBudget(estimatedTokens, availableTokens, settings.numCtx, req.numPredict);
    }
  }

  return {
    readiness: () => adapter.readiness(),

    async call(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      gate(req);
      checkBudget(req);
      const run = tail.then(() => {
        // A call that was aborted while it waited its turn never reaches the adapter.
        signal.throwIfAborted();
        return adapter.call(req, signal);
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
