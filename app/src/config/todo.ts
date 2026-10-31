/**
 * The named simplifications of the prototype (constitution XII): each departs from a decision, says what undoes it,
 * and stays visible at runtime as a startup WARN and as the `todo` list of `GET /api/health`, which the page header
 * shows. The single source is the Deferred Simplifications table of specs/001-local-prototype/spec.md; this list and
 * that table must stay identical, which `test/todo.test.ts` checks (T075).
 */
export type Simplification = {
  id: string;
  uk: string;
  en: string;
  trigger: { uk: string; en: string };
};

/** The thirteen named simplifications, in the order of the spec table. */
export const todoList: Simplification[] = [
  {
    id: 'runtime-runc',
    uk: 'Парсер працює під типовим середовищем контейнера (runc), без посиленого (gVisor).',
    en: 'The parser runs under the default container runtime (runc), not a hardened one (gVisor).',
    trigger: {
      uk: 'Перший несинтетичний документ, підключення нелокальної моделі або вихід прототипу за межі машини розробки.',
      en: 'The first non-synthetic document, a non-local model connected, or the prototype leaving the dev machine.',
    },
  },
  {
    id: 'no-invisible-text-stripping',
    uk: 'Невидимий текст не вилучається, TEXT_LAYER_MISMATCH не генерується.',
    en: 'Invisible text is not stripped and TEXT_LAYER_MISMATCH is not emitted.',
    trigger: {
      uk: 'Перший несинтетичний документ; перша перевірка цієї роботи: фікстура з невидимим IBAN.',
      en: 'The first non-synthetic document; the first acceptance check of that work is a fixture with an invisible IBAN.',
    },
  },
  {
    id: 'no-malware-scan',
    uk: 'Сканування на шкідливий код відсутнє; MALWARE зарезервовано.',
    en: 'There is no malware scan; MALWARE is reserved.',
    trigger: { uk: 'Перший несинтетичний документ.', en: 'The first non-synthetic document.' },
  },
  {
    id: 'model-in-volume',
    uk: 'Модель завантажується в том за тегом і перевіряється за дайджестом, а не вбудована в образ.',
    en: 'The model is pulled into a volume by tag and verified by digest, not baked into an image.',
    trigger: { uk: 'Перше розгортання поза машиною розробки.', en: 'The first deployment off the dev machine.' },
  },
  {
    id: 'single-worker',
    uk: 'Один воркер у процесі застосунку; повторне ставлення в чергу під час старту поверх оренди; без heartbeat.',
    en: 'A single in-process worker; boot requeue on top of the lease; no heartbeat.',
    trigger: { uk: 'Другий воркер або репліка.', en: 'A second worker or replica.' },
  },
  {
    id: 'no-migrations',
    uk: 'Без міграцій: перевірка версії схеми та скидання сховища.',
    en: 'No migrations: a schema version check plus a reset.',
    trigger: {
      uk: 'Перші дані, які не можна відтворити (ручні розмітки, реальні документи).',
      en: 'The first data that cannot be regenerated (hand labels, real documents).',
    },
  },
  {
    id: 'no-role-split',
    uk: 'Без розділення ролей і без плавного завершення роботи.',
    en: 'No role split and no graceful shutdown drain.',
    trigger: {
      uk: 'Kubernetes; модуль воркера бере власні залежності, а не екземпляр вебсервера.',
      en: 'Kubernetes; the worker module takes its own dependencies, never the web server instance.',
    },
  },
  {
    id: 'bbox-empty',
    uk: 'Рамка поля порожня.',
    en: 'The field bounding box is empty.',
    trigger: { uk: 'Інтерфейс перевірки.', en: 'The reviewer UI.' },
  },
  {
    id: 'no-label-proximity-rule',
    uk: 'Немає правила близькості мітки проти підміни значення.',
    en: 'There is no label-proximity rule against substitution.',
    trigger: { uk: 'Оцінювання показує підміни понад порогом.', en: 'The evaluation shows substitutions above the threshold.' },
  },
  {
    id: 'reserved-reasons',
    uk: 'LOW_CONFIDENCE і EXTRACTORS_DISAGREE не генеруються.',
    en: 'LOW_CONFIDENCE and EXTRACTORS_DISAGREE are not emitted.',
    trigger: { uk: 'Друга спроба видобування або другий екстрактор.', en: 'A second extraction attempt or a second extractor.' },
  },
  {
    id: 'no-review-form',
    uk: 'Форми ручної перевірки немає; NEEDS_REVIEW є кінцевим станом.',
    en: 'There is no human review form; NEEDS_REVIEW is a dead end.',
    trigger: { uk: 'Власник просить форму перевірки.', en: 'The owner asks for review.' },
  },
  {
    id: 'secrets-in-env',
    uk: 'Паролі бази даних передаються контейнерам змінними середовища (їх видно у docker inspect), а не файловими секретами.',
    en: 'Database passwords reach the containers as environment variables (visible in docker inspect), not as file-backed secrets.',
    trigger: {
      uk: 'Перше розгортання поза машиною розробки або другий користувач цієї машини.',
      en: 'The first deployment off the dev machine, or a second user of this machine.',
    },
  },
  {
    id: 'step-runs-completed-by-update',
    uk: 'Рядок step_runs дописується один раз оновленням finished_at, outcome і details; таблиця не лише для вставки.',
    en: 'A step_runs row is completed once by an update of finished_at, outcome and details; the table is not insert-only.',
    trigger: { uk: 'Перший несинтетичний документ.', en: 'The first non-synthetic document.' },
  },
];

/** The part of a pino or Fastify logger this module needs, so it does not depend on either. */
export type WarnLogger = {
  warn: (fields: object, message: string) => void;
};

/**
 * Logs one WARN per simplification at start (constitution XII). Only ids and English texts are logged: no document
 * data exists at this point and nothing here comes from the environment.
 */
export function logTodoWarnings(logger: WarnLogger): void {
  for (const item of todoList) {
    logger.warn({ simplification: item.id, trigger: item.trigger.en }, item.en);
  }
}
