import { ApiError } from '../api/client.ts';
import { translate } from './t.ts';
import type { Lang } from './t.ts';

/**
 * The text a failed request shows in place of its result. The message of the API's error shape is English and technical and
 * is not shown (contracts/api.md): the owner sees what failed in the active language and, for a refused request, its status.
 */
export function errorText(lang: Lang, error: unknown): string {
  return error instanceof ApiError ? translate(lang, 'error.request', { status: error.status }) : translate(lang, 'error.page');
}
