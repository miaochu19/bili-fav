/** Expected input failures; keep details available behind CLI --debug. */
export class UserInputError extends Error {
  constructor(message, { hint, cause } = {}) {
    super(message, { cause });
    this.name = "UserInputError";
    this.hint = hint;
  }
}

export function cliError(err, { debug = false } = {}) {
  if (debug) return err?.stack || String(err);
  const message = [err?.message || String(err), err?.hint].filter(Boolean).join("；").replace(/\s*[\r\n]+\s*/g, " ");
  return `Error: ${message}`;
}
