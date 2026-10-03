export class UpstreamUnavailable extends Error {
  constructor(service, cause, status = null) {
    super(`${service} unavailable${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'UpstreamUnavailable';
    this.service = service;
    this.cause = cause;
    this.status = status;
  }
}

export class UpstreamError extends Error {
  constructor(service, status, code, message, body) {
    super(message);
    this.name = 'UpstreamError';
    this.service = service;
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

function errorCode(data, status) {
  if (data?.error && typeof data.error === 'object' && typeof data.error.code === 'string') return data.error.code;
  if (typeof data?.error === 'string' && MACHINE_CODE.test(data.error)) return data.error;
  if (typeof data?.code === 'string') return data.code;
  return `http_${status}`;
}

export async function parseResponse(service, res) {
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new UpstreamUnavailable(service, err);
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (res.ok) return data;
  if (res.status >= 500) throw new UpstreamUnavailable(service, new Error(`HTTP ${res.status}`), res.status);
  const message = data?.message ?? data?.error?.message ?? (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
  throw new UpstreamError(service, res.status, errorCode(data, res.status), message, data);
}

export async function requestJson(service, url, { method = 'GET', token, body, headers = {}, timeoutMs = 10000 } = {}) {
  const allHeaders = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  };
  for (const key of Object.keys(allHeaders)) if (allHeaders[key] === undefined) delete allHeaders[key];
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: allHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new UpstreamUnavailable(service, err);
  }
  return parseResponse(service, res);
}
