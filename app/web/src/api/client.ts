/**
 * The page's only door to the server (contracts/api.md): every path is relative to `/api`, so the page works under
 * whatever origin serves it and never names a host. The request header below is what the app's `onRequest` hook
 * demands of state-changing requests (C15, research R11); it is sent on every call so no caller can forget it.
 */
const apiBase = 'api';
const requestHeaderName = 'X-Reader-Request';

/**
 * A non-2xx answer of the API. The `message` of the API's error shape is English and technical and is not shown to the
 * owner as is (contracts/api.md), so only the status travels here; views choose their own text.
 */
export class ApiError extends Error {
  status: number;

  constructor(status: number) {
    super(`API answered ${status}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Fetches `path` under `/api` with the same-origin marker header; a non-2xx answer is thrown as an `ApiError`. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(requestHeaderName, '1');
  const response = await fetch(`${apiBase}/${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  return response;
}

/** Fetches `path` and returns the parsed JSON as `unknown`; the caller narrows it before use, never casts it. */
export async function apiJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await apiFetch(path, init);
  return response.json();
}

/**
 * Polls `path` every `intervalMs` (the page polls, no websockets: C15) and hands each answer to `onData` after `parse`
 * has narrowed it; `parse` throws on a shape it does not accept, and that goes to `onError` like a network failure.
 * The next request is scheduled only after the previous one has finished, so a slow server never gets overlapping
 * requests. Returns the function that stops the polling and cancels the request in flight, for an effect cleanup.
 */
export function poll<T>(
  path: string,
  intervalMs: number,
  parse: (value: unknown) => T,
  onData: (data: T) => void,
  onError: (error: unknown) => void,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    try {
      onData(parse(await apiJson(path, { signal: controller.signal })));
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      onError(error);
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(tick, intervalMs);
    }
  };
  void tick();

  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
