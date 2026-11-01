import React from 'react';
import { poll } from './client.ts';

/** How often the page asks again (C15: the page polls, no websockets), unless a caller needs another rhythm. */
const defaultEveryMs = 2000;

/** What the page has of an answer: the last good one, and the failure of the last try, if it failed. */
export type PolledAnswer<T> = { data: T | null; failure: unknown };

/**
 * The one way every view fetches an answer that changes (FR-064): ask `path` under `/api`, narrow the JSON with `parse`,
 * keep the last good answer, and ask again every two seconds. A try that fails leaves the last answer where it was and
 * reports the failure, because the next try may well succeed; a good answer clears it. `path` null asks nothing, and a
 * new `path` starts the asking afresh at once while the previous answer stays until the new one comes. With `once` the
 * asking stops after the first good answer, for what is fetched a single time at load (the registry's labels). `parse`
 * is read through a ref, so a caller may pass a new function on every render without restarting the poll.
 */
export function usePolledAnswer<T>(path: string | null, parse: (value: unknown) => T, options: { everyMs?: number; once?: boolean } = {}): PolledAnswer<T> {
  const everyMs = options.everyMs ?? defaultEveryMs;
  const once = options.once ?? false;
  const [data, setData] = React.useState<T | null>(null);
  const [failure, setFailure] = React.useState<unknown>(null);
  const parseRef = React.useRef(parse);
  parseRef.current = parse;

  React.useEffect(() => {
    if (path === null) {
      return undefined;
    }
    let stop: () => void = () => undefined;
    stop = poll(
      path,
      everyMs,
      (value) => parseRef.current(value),
      (answer) => {
        setData(answer);
        setFailure(null);
        if (once) {
          stop();
        }
      },
      setFailure,
    );
    return () => stop();
  }, [path, everyMs, once]);

  return { data, failure };
}
