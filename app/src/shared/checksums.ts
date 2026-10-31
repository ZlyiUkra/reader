/**
 * Check digits of the two identifiers the document types carry (research R12). They live in `shared/` because two
 * programs need them: the checks of the pipeline, which verify the codes found on a document, and the fixtures
 * generator, which has to produce codes that verify.
 */

/** The weights of the EDRPOU check digit, applied to the first seven digits. */
const edrpouWeights = [1, 2, 3, 4, 5, 6, 7];

/** The weights for codes from 30000000 to 59999999, a different series of the same register. */
const edrpouShiftedWeights = [7, 1, 2, 3, 4, 5, 6];

/** Weighted sum of seven digits, each weight raised by `extra`. */
function weightedSum(digits: number[], weights: number[], extra: number): number {
  return digits.reduce((sum, digit, index) => sum + digit * ((weights[index] ?? 0) + extra), 0);
}

/**
 * The eighth digit of an EDRPOU code computed from its first seven digits: the weighted sum modulo 11; when that is 10,
 * the sum is taken again with every weight raised by 2 and reduced modulo 11 and then modulo 10. The shifted weights
 * apply to codes in 30000000 to 59999999. The rule follows research R12, which took it from the python-stdnum
 * implementation and marks it unverified against an official source; the fixtures only need it to be self-consistent.
 */
export function edrpouCheckDigit(firstSeven: string): number {
  if (!/^[0-9]{7}$/.test(firstSeven)) {
    throw new RangeError('The first seven digits of an EDRPOU code are needed');
  }
  const digits = [...firstSeven].map(Number);
  const value = Number(firstSeven);
  const weights = value >= 3_000_000 && value <= 5_999_999 ? edrpouShiftedWeights : edrpouWeights;
  const first = weightedSum(digits, weights, 0) % 11;
  if (first < 10) {
    return first;
  }
  return (weightedSum(digits, weights, 2) % 11) % 10;
}

/** True when `value` is eight digits whose last digit is the check digit of the first seven. */
export function isEdrpou(value: string): boolean {
  return /^[0-9]{8}$/.test(value) && edrpouCheckDigit(value.slice(0, 7)) === Number(value[7]);
}

/** Replaces letters by numbers (A is 10, Z is 35) as the mod 97-10 rule of ISO 7064 demands. */
function expandLetters(text: string): string {
  return [...text].map((character) => (/[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character)).join('');
}

/** The remainder modulo 97 of a long string of digits, taken digit by digit so no integer outgrows the safe range. */
function mod97(digits: string): number {
  let remainder = 0;
  for (const digit of digits) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

/**
 * The two check digits of a Ukrainian IBAN, from the 6-digit bank code and the 19-character account: the bank code and
 * the account, then `UA00`, as numbers; `98 - (n mod 97)`, zero-padded (research R12).
 */
export function uaIbanCheckDigits(bankCode: string, account: string): string {
  if (!/^[0-9]{6}$/.test(bankCode) || !/^[0-9A-Z]{19}$/.test(account)) {
    throw new RangeError('A Ukrainian IBAN needs a 6-digit bank code and a 19-character account');
  }
  return String(98 - mod97(expandLetters(`${bankCode}${account}UA00`))).padStart(2, '0');
}

/** A complete Ukrainian IBAN, 29 characters, with valid check digits. */
export function uaIban(bankCode: string, account: string): string {
  return `UA${uaIbanCheckDigits(bankCode, account)}${bankCode}${account}`;
}

/**
 * True when `value` is a Ukrainian IBAN: 29 characters, `UA`, two check digits, a 6-digit bank code and a 19-character
 * account, and the number made by moving the first four characters to the end leaves remainder 1 modulo 97.
 */
export function isUaIban(value: string): boolean {
  return /^UA[0-9]{2}[0-9]{6}[0-9A-Z]{19}$/.test(value) && mod97(expandLetters(`${value.slice(4)}${value.slice(0, 4)}`)) === 1;
}
