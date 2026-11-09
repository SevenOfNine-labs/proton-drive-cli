/** Creation date for test keys, an hour back: openpgp.js refuses to sign with a key created after the signing time. */
export function keyCreationDate(): Date {
  return new Date(Date.now() - 60 * 60 * 1000);
}
