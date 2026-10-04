export const STATUS = Object.freeze({
  invalid_request: 400,
  consent_required: 400,
  invalid_webhook_url: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  invalid_code: 401,
  insufficient_credits: 402,
  suspended: 403,
  needs_verification: 403,
  voice_limit_reached: 403,
  plan_required: 403,
  key_limit_reached: 403,
  not_found: 404,
  not_regeneratable: 409,
  voice_not_ready: 409,
  idempotency_conflict: 409,
  busy: 409,
  too_large: 413,
  unsupported_audio: 415,
  rate_limited: 429,
  too_many_jobs: 429,
  internal_error: 500,
  lqstudio_unavailable: 503,
  engine_unavailable: 503,
});

export class ApiError extends Error {
  constructor(code, message = code, { status, headers, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 500;
    this.headers = headers ?? {};
    this.details = details ?? {};
  }
}

// body-parser failures by err.type: [code, message, status]. Anything else is a bug and logs as unhandled.
const BODY_ERRORS = Object.freeze({
  'entity.parse.failed': ['invalid_request', 'malformed JSON body', 400],
  'entity.too.large': ['too_large', 'request body too large', 413],
  'charset.unsupported': ['invalid_request', 'unsupported body charset or encoding', 415],
  'encoding.unsupported': ['invalid_request', 'unsupported body charset or encoding', 415],
  'request.aborted': ['invalid_request', 'request body was cut off', 400],
  'request.size.invalid': ['invalid_request', 'request body was cut off', 400],
});

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
      const known = BODY_ERRORS[err?.type];
      if (known) {
        apiErr = new ApiError(known[0], known[1], { status: known[2] });
      } else {
        log.error({ event: 'unhandled_error', path: req.path, error: String(err?.stack ?? err) }, 'unhandled error');
        apiErr = new ApiError('internal_error', 'internal error');
      }
    }
    res.set(apiErr.headers).status(apiErr.status).json({ error: { ...apiErr.details, code: apiErr.code, message: apiErr.message } });
  };
}
