import { edrpouCheckDigit, uaIban } from '../../app/src/shared/checksums.ts';

/**
 * A fictional company that the fixture documents name as a party. The names, the codes and the bank numbers are made
 * up; the EDRPOU and IBAN are computed here with the same functions the pipeline's checks use (`shared/checksums.ts`),
 * so a fixture never fails a checksum by accident and a code matching a real company would be a coincidence, not a
 * copy (constitution X, FR-046).
 */
export type Company = {
  name: string;
  edrpou: string;
  iban: string;
  city: string;
  address: string;
};

/** An EDRPOU code from its first seven digits: the seven digits and their check digit. */
function edrpou(firstSeven: string): string {
  return `${firstSeven}${edrpouCheckDigit(firstSeven)}`;
}

/**
 * The three companies, used in every combination of seller and buyer, contractor and customer, first and second
 * party. The first digits `99` and the bank codes `990001` to `990003` are chosen away from the ranges in use so the
 * numbers read as plausible and are not meant to be looked up anywhere.
 */
export const companies = {
  cherry: {
    name: 'ТОВ «Вишневий Прибій»',
    edrpou: edrpou('9910021'),
    iban: uaIban('990001', '0000026001234567890'),
    city: 'Дніпро',
    address: 'вул. Січових Стрільців, 14, офіс 7',
  },
  bee: {
    name: 'ПП «Золота Бджола»',
    edrpou: edrpou('9910345'),
    iban: uaIban('990002', '0000026009876543210'),
    city: 'Львів',
    address: 'просп. Свободи, 3, кв. 21',
  },
  crow: {
    name: 'ТОВ «Синя Ворона Логістик»',
    edrpou: edrpou('9910678'),
    iban: uaIban('990003', '0000026005551112223'),
    city: 'Харків',
    address: 'вул. Пушкінська, 88',
  },
} satisfies Record<string, Company>;
