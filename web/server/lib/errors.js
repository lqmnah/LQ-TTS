export const STATUS = Object.freeze({
  invalid_request: 400,
  consent_required: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  invalid_code: 401,
  insufficient_credits: 402,
  suspended: 403,
  needs_verification: 403,
  voice_limit_reached: 403,
  not_found: 404,
  not_regeneratable: 409,
  voice_not_ready: 409,
  too_large: 413,
  unsupported_audio: 415,
  rate_limited: 429,
  internal_error: 500,
  lqstudio_unavailable: 503,
  engine_unavailable: 503,
});

export class ApiError extends Error {
  constructor(code, message = code, { status, headers } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 500;
    this.headers = headers ?? {};
  }
}

export function errorHandler(log) {
  // Express recognises error middleware by its four parameters.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    let apiErr = err;
    if (!(err instanceof ApiError)) {
      if (err?.type === 'entity.parse.failed') apiErr = new ApiError('invalid_request', 'malformed JSON body');
      else if (err?.type === 'entity.too.large') apiErr = new ApiError('too_large', 'request body too large');
      else {
        log.error({ event: 'unhandled_error', path: req.path, error: String(err?.stack ?? err) }, 'unhandled error');
        apiErr = new ApiError('internal_error', 'internal error');
      }
    }
    res.set(apiErr.headers).status(apiErr.status).json({ error: { code: apiErr.code, message: apiErr.message } });
  };
}
