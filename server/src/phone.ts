/**
 * A recipient is identified by a "key":
 *  - bare international digits for a normal number, e.g. "919812345678"
 *  - "<digits>@lid" for a member whose number WhatsApp hides (privacy LID). We can still message them by that id.
 */

/** Normalise a phone number to bare international digits. 10-digit numbers are assumed to be Indian. */
export function normalizePhone(input: string): string {
  let digits = input.replace(/@.*$/, '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  return digits;
}

export function isValidPhone(digits: string): boolean {
  return /^\d{10,15}$/.test(digits);
}

export function normalizeRecipient(input: string): string {
  const value = input.trim();
  if (/@lid$/i.test(value)) return `${value.replace(/@.*$/, '').replace(/\D/g, '')}@lid`;
  return normalizePhone(value);
}

export function isValidRecipient(key: string): boolean {
  return /^\d{5,20}@lid$/.test(key) || isValidPhone(key);
}

export function toChatId(key: string): string {
  return key.endsWith('@lid') ? key : `${key}@c.us`;
}
