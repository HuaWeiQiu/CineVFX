export class HttpError extends Error {
  constructor(status, code, message, { retriable = false, headers = undefined } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retriable = retriable;
    this.headers = headers;
  }

  toJSON() {
    const body = {
      code: this.code,
      message: this.message,
    };
    if (this.retriable) {
      body.retriable = true;
    } else if (this.retriable === false) {
      body.retriable = false;
    }
    return body;
  }
}

export function errorBody(code, message, retriable) {
  const body = { code, message };
  if (retriable !== undefined) {
    body.retriable = retriable;
  }
  return body;
}
