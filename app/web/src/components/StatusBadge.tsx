import React from 'react';
import { translateName } from '../t.ts';
import type { Lang } from '../t.ts';

/**
 * A document's status as a labelled badge. The status itself is kept in a data attribute, which the stylesheet colours
 * by meaning: the badge never relies on colour alone, because the label is always there.
 */
export function StatusBadge({ status, lang }: { status: string; lang: Lang }): React.JSX.Element {
  return (
    <span className="badge" data-status={status}>
      {translateName(lang, 'status', status)}
    </span>
  );
}
