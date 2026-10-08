/**
 * One error shape for the whole package. Every failure a user can cause (a
 * missing export, a mistyped recovery code, a tampered file, an unknown guid)
 * reaches the MCP client as a stable `code`, a sentence the model can relay, and
 * a `hint` naming the next step. The underlying protocol or crypto code goes in
 * `detail`, so a bug report can name the exact check that failed without putting
 * it in the sentence a lawyer reads.
 */
'use strict';

class LibraryError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
    this.hint = options.hint || '';
    this.detail = options.detail || '';
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON() {
    const value = { code: this.code, message: this.message };
    if (this.hint) value.hint = this.hint;
    if (this.detail) value.detail = this.detail;
    return value;
  }
}

function fail(code, message, options) {
  throw new LibraryError(code, message, options);
}

/** Wraps anything thrown into a LibraryError. */
function asLibraryError(error) {
  if (error instanceof LibraryError) return error;
  return new LibraryError(
    'internal_error',
    error?.message ? String(error.message) : 'Unexpected failure.',
    { detail: error?.code ? String(error.code) : '', cause: error }
  );
}

module.exports = { LibraryError, fail, asLibraryError };
