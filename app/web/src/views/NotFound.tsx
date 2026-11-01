import React from 'react';
import { defaultRoute } from '@shared/route.ts';
import { translate } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';
import { navigate } from '../router.ts';

/** What the not-found view takes: the page's language and the address as the owner typed it. */
type NotFoundProps = {
  lang: Lang;
  address: string;
};

/**
 * The page for an address that is none of the six (FR-067): the words that no such address exists, the address as typed
 * (set as text, whatever characters it holds) and one button to the default page, nothing else. No tab is pressed on it,
 * since it is none of the views.
 */
export function NotFound({ lang, address }: NotFoundProps): React.JSX.Element {
  return (
    <section className="stack">
      <p className="explain">{translate(lang, 'notFound.text')}</p>
      <p className="address mono">{address}</p>
      <div>
        <button type="button" onClick={() => navigate(defaultRoute)}>
          {translate(lang, 'notFound.home')}
        </button>
      </div>
    </section>
  );
}
