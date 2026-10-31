/**
 * An error that carries the HTTP status and the code of the API's error shape (contracts/api.md). It lives in its own
 * module so route handlers can throw it without importing the server, which imports them.
 */
export class HttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
