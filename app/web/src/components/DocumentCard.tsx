import React from 'react';
import { ApiError, apiJson } from '../api/client.ts';
import { usePolledAnswer } from '../api/usePolledAnswer.ts';
import { ReasonList } from './ReasonList.tsx';
import { StatusBadge } from './StatusBadge.tsx';
import { errorText } from '../i18n/errors.ts';
import { fieldLabel, typeLabel, typeOf, valueText } from '../i18n/display.ts';
import { parseDocumentDetail, parseRaw } from '../api/answers.ts';
import type { DetailField, DocumentDetail, Meta, RawCall } from '../api/answers.ts';
import { translate, translateName } from '../i18n/t.ts';
import type { Lang } from '../i18n/t.ts';

/** What the card takes: the page's language, what it derives from the registry, and the number of the document to show. */
type DocumentCardProps = {
  lang: Lang;
  meta: Meta;
  number: number;
};

/** The fields in the order of the registry's type, which is the order the owner reads a document in; unknown ones last. */
function inRegistryOrder(meta: Meta, typeName: string | null, fields: DetailField[]): DetailField[] {
  const order = typeOf(meta, typeName)?.fields.map((field) => field.name) ?? [];
  const rank = (name: string): number => {
    const at = order.indexOf(name);
    return at === -1 ? order.length : at;
  };
  return [...fields].sort((a, b) => rank(a.name) - rank(b.name));
}

/** A model call as plain text: the request and the response, pretty-printed, exactly as stored. */
function rawText(call: RawCall): string {
  return `${JSON.stringify(call.rawRequest, null, 2)}\n\n${JSON.stringify(call.rawResponse, null, 2)}`;
}

/**
 * The "model request and response" block, collapsed until the owner opens it. The raw data is fetched on opening and not
 * before, from the route that serves one document at a time, and it is shown inside `<pre>` as text: it is the model's own
 * output and may contain anything, so it is never given to the browser as markup (FR-053a, FR-055).
 */
function RawBlock({ lang, number }: { lang: Lang; number: number }): React.JSX.Element {
  const [calls, setCalls] = React.useState<RawCall[] | null>(null);
  const [failure, setFailure] = React.useState<unknown>(null);

  /** Fetches the calls the first time the block opens; later openings show what is already there. */
  function onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void {
    if (!event.currentTarget.open || calls !== null) {
      return;
    }
    setFailure(null);
    apiJson(`documents/${number}/raw`)
      .then((data) => setCalls(parseRaw(data)))
      .catch(setFailure);
  }

  return (
    <details onToggle={onToggle} className="raw">
      <summary>{translate(lang, 'detail.raw')}</summary>
      {failure === null ? null : <p role="alert" className="notice">{errorText(lang, failure)}</p>}
      {calls === null && failure === null ? <p className="muted">{translate(lang, 'common.loading')}</p> : null}
      {calls?.length === 0 ? <p className="muted">{translate(lang, 'detail.raw.empty')}</p> : null}
      {calls?.map((call) => (
        <div key={call.id}>
          <h4>{translate(lang, 'detail.raw.call', { kind: translateName(lang, 'kind', call.kind), attempt: call.attempt, doneReason: call.doneReason ?? '' })}</h4>
          <pre>{rawText(call)}</pre>
        </div>
      ))}
    </details>
  );
}

/**
 * The card of one document (FR-053, FR-055, FR-060), shown in a window above the list it was opened from: its fields with
 * the typed value, the fragment the model quoted and the page it was found on; the pages as lazily loaded previews; the
 * steps with their attempts and durations; the model that ran; the reasons as messages; and the collapsed raw block. The
 * data is polled every two seconds so a document that is still in the pipeline fills in as it goes. Nothing taken from a
 * document is set as markup: values, fragments, names and messages are all text of their elements. The window keys the card
 * by the document's number, so opening another document never shows the previous one's data for a moment.
 */
export function DocumentCard({ lang, meta, number }: DocumentCardProps): React.JSX.Element {
  const { data: detail, failure } = usePolledAnswer(`documents/${number}`, parseDocumentDetail);

  if (failure instanceof ApiError && failure.status === 404) {
    return <p role="alert" className="notice">{translate(lang, 'detail.notFound', { number })}</p>;
  }
  if (detail === null) {
    return failure === null ? <p className="muted">{translate(lang, 'common.loading')}</p> : <p role="alert" className="notice">{errorText(lang, failure)}</p>;
  }

  const fields = inRegistryOrder(meta, detail.type, detail.fields);
  return (
    <section className="stack">
      {failure === null ? null : <p role="alert" className="notice">{errorText(lang, failure)}</p>}
      <header className="detail-head">
        <h2>{translate(lang, 'common.documentNumber', { number: detail.number })}</h2>
        <StatusBadge status={detail.status} lang={lang} />
      </header>
      <dl className="facts">
        <dt>{translate(lang, 'documents.col.name')}</dt>
        <dd>{detail.originalName ?? ''}</dd>
        <dt>{translate(lang, 'documents.col.class')}</dt>
        <dd>{translateName(lang, 'class', detail.documentClass)}</dd>
        <dt>{translate(lang, 'documents.col.type')}</dt>
        <dd>{detail.type === null ? translate(lang, 'common.none') : typeLabel(meta, detail.type, lang)}</dd>
        <dt>{translate(lang, 'detail.sha256')}</dt>
        <dd className="mono">{detail.sha256}</dd>
      </dl>

      {detail.reasons.length === 0 ? null : (
        <div>
          <h3>{translate(lang, 'detail.reasons')}</h3>
          <ReasonList meta={meta} reasons={detail.reasons} typeName={detail.type} lang={lang} />
        </div>
      )}

      <div>
        <h3>{translate(lang, 'detail.fields')}</h3>
        {fields.length === 0 ? (
          <p className="muted">{translate(lang, 'detail.fields.none')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{translate(lang, 'detail.col.field')}</th>
                  <th>{translate(lang, 'detail.col.value')}</th>
                  <th>{translate(lang, 'detail.col.fragment')}</th>
                  <th className="num">{translate(lang, 'detail.col.page')}</th>
                  <th>{translate(lang, 'detail.col.found')}</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => (
                  <tr key={field.name}>
                    <td>{fieldLabel(meta, detail.type, field.name, lang)}</td>
                    <td>{valueText(field.value)}</td>
                    <td>{field.verbatim === null ? '' : <span className="fragment">{field.verbatim}</span>}</td>
                    <td className="num">{field.page === null ? '' : field.page}</td>
                    <td>{translate(lang, field.found ? 'detail.found.yes' : field.verbatim === null ? 'detail.found.absent' : 'detail.found.no')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3>{translate(lang, 'detail.steps')}</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{translate(lang, 'detail.col.step')}</th>
                <th className="num">{translate(lang, 'detail.col.attempt')}</th>
                <th>{translate(lang, 'detail.col.outcome')}</th>
                <th className="num">{translate(lang, 'detail.col.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.steps.map((step, index) => (
                <tr key={`${step.step}-${step.attempt}-${index}`}>
                  <td>{translateName(lang, 'step', step.step)}</td>
                  <td className="num">{step.attempt}</td>
                  <td>{step.outcome === null ? translate(lang, 'detail.outcome.open') : translateName(lang, 'outcome', step.outcome)}</td>
                  <td className="num">{step.durationMs === null ? '' : translate(lang, 'detail.ms', { ms: step.durationMs.toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB') })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail.model === null ? null : (
        <div>
          <h3>{translate(lang, 'detail.model')}</h3>
          <dl className="facts">
            <dt>{translate(lang, 'detail.model.name')}</dt>
            <dd>{detail.model.name}</dd>
            <dt>{translate(lang, 'detail.model.digest')}</dt>
            <dd className="mono">{detail.model.digest}</dd>
            <dt>{translate(lang, 'detail.model.promptHash')}</dt>
            <dd className="mono">{detail.model.promptHash}</dd>
            <dt>{translate(lang, 'detail.model.schema')}</dt>
            <dd className="mono">{detail.model.schemaId ?? ''}</dd>
            <dt>{translate(lang, 'detail.model.tokens')}</dt>
            <dd>
              {detail.model.promptEvalCount ?? '-'} / {detail.model.evalCount ?? '-'}
            </dd>
            <dt>{translate(lang, 'detail.model.load')}</dt>
            <dd>{translate(lang, detail.model.cold ? 'detail.model.cold' : 'detail.model.warm')}</dd>
          </dl>
        </div>
      )}

      <RawBlock key={detail.number} lang={lang} number={detail.number} />

      <div>
        <h3>{translate(lang, 'detail.pages')}</h3>
        {detail.pages.length === 0 ? (
          <p className="muted">{translate(lang, 'detail.pages.none')}</p>
        ) : (
          detail.pages.map((page) => (
            <figure key={page.page} className="page-preview">
              <figcaption>
                {translate(lang, 'detail.page', { page: page.page, source: page.source === null ? '' : translateName(lang, 'source', page.source) })}
              </figcaption>
              <img
                loading="lazy"
                src={`api/documents/${detail.number}/pages/${page.page}.png`}
                width={page.width}
                height={page.height}
                alt={translate(lang, 'detail.page.alt', { page: page.page })}
              />
            </figure>
          ))
        )}
      </div>
    </section>
  );
}
