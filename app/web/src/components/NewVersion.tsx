import React from 'react';
import { assetsOf, isNewBuild } from '@shared/build.ts';
import { translate } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';

/** How often the page asks the server for its own HTML to see whether a newer build is served, in milliseconds. */
const checkEveryMs = 30000;

/** The built files this page was loaded from: what its own `<script>` and `<link>` elements name. */
function runningAssets(): string[] {
  const names = [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')].map(
    (element) => `${element.getAttribute('src') ?? ''}\n${element.getAttribute('href') ?? ''}`,
  );
  return assetsOf(names.join('\n'));
}

/**
 * A notice that a newer build of the page is being served, with a button that reloads it (FR-059). A page stays as it was
 * loaded while only its data is polled, so after a rebuild the owner would go on using the old code without knowing it. The
 * page asks for its own HTML every half minute and compares the built files it names with the ones it runs (`isNewBuild`);
 * a failed check is ignored, as the server may be restarting and the next check will see, and once a new build is seen the
 * checks stop, because the notice stays until the page is reloaded. Nothing is reloaded by itself: a reload would drop what
 * the owner is looking at.
 */
export function NewVersion({ lang }: { lang: Lang }): React.JSX.Element | null {
  const [available, setAvailable] = React.useState(false);

  React.useEffect(() => {
    const running = runningAssets();
    const timer = window.setInterval(() => void check(), checkEveryMs);

    /** Asks for the served HTML without the cache and compares it with the running build. */
    async function check(): Promise<void> {
      try {
        const response = await fetch('index.html', { cache: 'no-store' });
        if (response.ok && isNewBuild(running, await response.text())) {
          setAvailable(true);
          window.clearInterval(timer);
        }
      } catch {
        // The server may be restarting or the network away; the next check asks again.
      }
    }

    return () => window.clearInterval(timer);
  }, []);

  if (!available) {
    return null;
  }
  return (
    <div className="update" role="status">
      <span>{translate(lang, 'update.available')}</span>
      <button type="button" onClick={() => window.location.reload()}>
        {translate(lang, 'update.reload')}
      </button>
    </div>
  );
}
