import type { ThresholdsFile } from './types.ts';
import { ConfigError } from './load.ts';

/**
 * The page size of the lists the browser shows (FR-053, owner decision of 2026-11-01): the size a list starts with and the
 * sizes the owner can choose from. Both are rows of the thresholds file (C13), read once at start; a row that cannot be
 * used stops the application with its key named, like every other configuration error.
 */

/** The largest page the API serves (contracts/api.md), so no offered size may exceed it. */
const largestPage = 1000;

/** The sizes of a page: the default one and the choices, which always contain it. */
export type PageSettings = {
  pageSize: number;
  pageSizes: number[];
};

/** Reads `ui.page_size` and `ui.page_size_options`; the options are whole numbers in ascending order and include the default. */
export function pageSettings(thresholds: ThresholdsFile): PageSettings {
  const pageSize = thresholds.values['ui.page_size']?.value;
  const options = thresholds.values['ui.page_size_options']?.value;
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize)) {
    throw new ConfigError('config/thresholds.json: "ui.page_size" must be a whole number.');
  }
  if (typeof options !== 'string') {
    throw new ConfigError('config/thresholds.json: "ui.page_size_options" must be a comma-separated list such as "10,20,50".');
  }
  const pageSizes = options.split(',').map((item) => Number(item.trim()));
  if (pageSizes.some((size) => !Number.isInteger(size) || size < 1 || size > largestPage) || pageSizes.some((size, index) => index > 0 && size <= (pageSizes[index - 1] ?? 0))) {
    throw new ConfigError(`config/thresholds.json: "ui.page_size_options" must list whole numbers from 1 to ${largestPage} in ascending order.`);
  }
  if (!pageSizes.includes(pageSize)) {
    throw new ConfigError('config/thresholds.json: "ui.page_size" must be one of "ui.page_size_options".');
  }
  return { pageSize, pageSizes };
}
