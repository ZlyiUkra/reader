import React from 'react';
import type { Meta } from '../api/answers.ts';
import { translate, translateName } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';

/** What the types view takes: the page's language and what it derives from the registry, null while that is loading. */
type TypesProps = {
  lang: Lang;
  meta: Meta | null;
};

/**
 * The registered document types (FR-062, FR-063): for each, its label and schema and a table of its fields in the
 * registry's order with the label in the active language, the name, the kind and whether the field is required. These are
 * the rules the system reads documents by, and they come entirely from `GET /api/meta`: a schema file added to the registry
 * shows up here after a restart without any change to the page (constitution II). Every cell is text.
 */
export function Types({ lang, meta }: TypesProps): React.JSX.Element {
  if (meta === null) {
    return <p className="muted">{translate(lang, 'common.loading')}</p>;
  }
  return (
    <section className="stack">
      <p className="explain">{translate(lang, 'types.explain')}</p>
      {meta.types.map((type) => (
        <section key={type.name} className="stack">
          <h2>{type.labels[lang]}</h2>
          <p className="muted">{translate(lang, 'types.schema', { name: type.name, schema: type.schemaId })}</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{translate(lang, 'types.col.label')}</th>
                  <th>{translate(lang, 'types.col.name')}</th>
                  <th>{translate(lang, 'types.col.kind')}</th>
                  <th>{translate(lang, 'types.col.required')}</th>
                </tr>
              </thead>
              <tbody>
                {type.fields.map((field) => (
                  <tr key={field.name}>
                    <td className="words">{field.labels[lang]}</td>
                    <td className="mono">{field.name}</td>
                    <td>{translateName(lang, 'fieldKind', field.kind)}</td>
                    <td>{translate(lang, field.required ? 'types.required.yes' : 'types.required.no')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </section>
  );
}
