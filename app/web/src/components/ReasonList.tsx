import React from 'react';
import { reasonText } from '../labels.ts';
import type { Meta, StoredReason } from '../model.ts';
import type { Lang } from '../t.ts';

/** What the list of reasons takes: the stored reasons, the type of their document (for field labels) and the page's language. */
type ReasonListProps = {
  meta: Meta;
  reasons: StoredReason[];
  typeName: string | null;
  lang: Lang;
};

/**
 * The reasons of a document as messages in the active language, one per line. Each message is a string made from the
 * reasons file's template and the stored parameters, and it is set as the text of its element: a fragment of the document
 * that ends up in a message is never read as markup (FR-055).
 */
export function ReasonList({ meta, reasons, typeName, lang }: ReasonListProps): React.JSX.Element | null {
  if (reasons.length === 0) {
    return null;
  }
  return (
    <ul className="reasons">
      {reasons.map((reason, index) => (
        <li key={`${reason.code}-${index}`}>{reasonText(meta, reason, typeName, lang)}</li>
      ))}
    </ul>
  );
}
