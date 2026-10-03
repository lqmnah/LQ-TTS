// @ts-check
/** @typedef {import('./types.js').Me} Me */
/** @typedef {import('./types.js').LoginResult} LoginResult */
/** @typedef {import('./types.js').Health} Health */
/** @typedef {import('./types.js').Voice} Voice */
/** @typedef {import('./types.js').VoiceProfile} VoiceProfile */
/** @typedef {import('./types.js').Estimate} Estimate */
/** @typedef {import('./types.js').JobSettings} JobSettings */
/** @typedef {import('./types.js').JobSummary} JobSummary */
/** @typedef {import('./types.js').JobDetail} JobDetail */
/** @typedef {import('./types.js').Sentence} Sentence */
/** @typedef {import('./types.js').Credits} Credits */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, 0 when the server was unreachable
   * @param {string} code contract C2 error code, or 'network' / 'generic'
   * @param {string} message server message (diagnostic only; the UI shows localized text)
   * @param {{retryAfter?: number|null}} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = extra.retryAfter ?? null;
  }
}

/** @type {Record<number, string>} */
const STATUS_FALLBACK = {
  400: 'invalid_request',
  401: 'unauthorized',
  402: 'insufficient_credits',
  404: 'not_found',
  413: 'too_large',
  415: 'unsupported_audio',
  429: 'rate_limited',
};

/**
 * Codes after which the server has revoked the session (`requireAuth` → `accounts.fresh`).
 * On `/auth/*` the same codes are login answers, not a session ending.
 */
const SESSION_ENDED = new Set(['unauthorized', 'suspended', 'needs_verification']);

/** @type {((err: ApiError) => void) | null} */
let unauthorizedHandler = null;

/** Subscribe to session endings (401 unauthorized, 403 suspended / needs_verification outside /auth). @param {(err: ApiError) => void} fn */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
  return () => {
    if (unauthorizedHandler === fn) unauthorizedHandler = null;
  };
}

/** @param {string} path path below /api @param {ApiError} err */
function notify(path, err) {
  if (unauthorizedHandler && SESSION_ENDED.has(err.code) && !path.startsWith('/auth/')) unauthorizedHandler(err);
  return err;
}

/** @param {Response} res @returns {Promise<ApiError>} */
export async function toApiError(res) {
  /** @type {any} */
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const fallback = STATUS_FALLBACK[res.status] ?? (res.status >= 502 && res.status <= 504 ? 'network' : 'generic');
  const code = typeof e?.code === 'string' ? e.code : fallback;
  const header = Number(res.headers.get('Retry-After'));
  const retryAfter = Number.isFinite(e?.retryAfter) ? e.retryAfter : Number.isFinite(header) && header > 0 ? header : null;
  return new ApiError(res.status, code, typeof e?.message === 'string' ? e.message : '', { retryAfter });
}

/**
 * @param {string} path path below /api
 * @param {{method?: string, body?: unknown, signal?: AbortSignal}} [options]
 * @returns {Promise<any>}
 */
export async function request(path, { method = 'GET', body, signal } = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') headers['X-Requested-With'] = 'lq-tts';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw notify(path, await toApiError(res));
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;

export const api = {
  /** @param {string} identifier @param {string} password @returns {Promise<LoginResult>} */
  login: (identifier, password) => request('/auth/login', { method: 'POST', body: { identifier, password } }),
  /** Same answers as login except `need_2fa`. @param {string} challenge @param {string} code @returns {Promise<LoginResult>} */
  verify2fa: (challenge, code) => request('/auth/2fa', { method: 'POST', body: { challenge, code } }),
  /** @returns {Promise<null>} */
  logout: () => request('/auth/logout', { method: 'POST' }),
  /** @returns {Promise<Me>} */
  me: () => request('/me'),
  /** @param {'id'|'en'} lang @returns {Promise<Me>} */
  setLang: (lang) => request('/me', { method: 'PATCH', body: { lang } }),
  /** @returns {Promise<Health>} */
  health: () => request('/health'),
  /** @returns {Promise<Voice[]>} */
  voices: () => request('/voices'),
  /** Active VO Profiles; `status` is null while the engine cannot be reached. @returns {Promise<VoiceProfile[]>} */
  voiceProfiles: () => request('/voice-profiles'),
  /** @param {string} id @returns {Promise<null>} */
  deleteVoice: (id) => request(`/voices/${enc(id)}`, { method: 'DELETE' }),
  /** @param {string} text @param {AbortSignal} [signal] @returns {Promise<Estimate>} */
  estimate: (text, signal) => request('/jobs/estimate', { method: 'POST', body: { text }, signal }),
  /** @param {string} voiceId @param {string} text @param {JobSettings} settings @returns {Promise<{id:string, credits:number, estimatedSeconds:number}>} */
  createJob: (voiceId, text, settings) => request('/jobs', { method: 'POST', body: { voiceId, text, settings } }),
  /**
   * `before` is the opaque `nextBefore` cursor from the previous page; pass it back unchanged, never build or parse it.
   * @param {{limit?: number, before?: string|null}} [query]
   * @returns {Promise<{items: JobSummary[], nextBefore: string|null}>}
   */
  jobs: ({ limit = 20, before = null } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    return request(`/jobs?${params}`);
  },
  /** @param {string} id @returns {Promise<JobDetail>} */
  job: (id) => request(`/jobs/${enc(id)}`),
  /** @param {string} id @returns {Promise<Sentence[]>} */
  sentences: (id) => request(`/jobs/${enc(id)}/sentences`),
  /** @param {string} id @param {number} idx @param {{text?: string, style?: string}} changes @returns {Promise<{revision:number, credits:number}>} */
  regenerate: (id, idx, changes) => request(`/jobs/${enc(id)}/sentences/${idx}/regenerate`, { method: 'POST', body: changes }),
  /** 409 `not_regeneratable` while a previous change is still being settled. @param {string} id @returns {Promise<{status:'cancel_requested'}>} */
  cancelJob: (id) => request(`/jobs/${enc(id)}/cancel`, { method: 'POST' }),
  /** @param {string} id @returns {Promise<null>} */
  deleteJob: (id) => request(`/jobs/${enc(id)}`, { method: 'DELETE' }),
  /** @returns {Promise<Credits>} */
  credits: () => request('/credits'),
};

/**
 * Contract C2 + plan 2B: text fields first, `audio` last (the server checks consent, name and limit before the file part).
 * @param {{file: File, name: string, language: string, transcript: string, consent: boolean}} fields
 */
export function buildVoiceForm({ file, name, language, transcript, consent }) {
  const form = new FormData();
  form.append('name', name);
  form.append('language', language);
  if (transcript) form.append('transcript', transcript);
  form.append('consent', consent ? 'true' : 'false');
  form.append('audio', file, file.name);
  return form;
}

/**
 * Upload with real progress (fetch cannot report upload progress).
 * 409 `voice_not_ready` here means another upload of this user is still in progress.
 * @param {{file: File, name: string, language: string, transcript: string, consent: boolean}} fields
 * @param {{onProgress?: (percent: number) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<{id: string, status: string}>}
 */
export function createVoice(fields, { onProgress, signal } = {}) {
  const form = buildVoiceForm(fields);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Upload aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const detach = () => signal?.removeEventListener('abort', onAbort);
    xhr.open('POST', '/api/voices');
    xhr.setRequestHeader('X-Requested-With', 'lq-tts');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = async () => {
      detach();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : null);
        } catch {
          reject(new ApiError(xhr.status, 'generic', 'unexpected response'));
        }
        return;
      }
      const res = new Response(xhr.responseText || null, {
        status: xhr.status,
        headers: {
          'Content-Type': xhr.getResponseHeader('Content-Type') ?? 'text/plain',
          'Retry-After': xhr.getResponseHeader('Retry-After') ?? '',
        },
      });
      reject(notify('/voices', await toApiError(res)));
    };
    xhr.onerror = () => {
      detach();
      reject(new ApiError(0, 'network', 'upload failed'));
    };
    xhr.onabort = () => {
      detach();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(form);
  });
}

export const urls = {
  /** @param {string} id */
  voicePreview: (id) => `/api/voices/${enc(id)}/preview`,
  /** `v` busts the browser cache after a regenerate (same path, new take). @param {string} jobId @param {number} idx @param {number} version */
  sentenceAudio: (jobId, idx, version) => `/api/jobs/${enc(jobId)}/sentences/${idx}/audio?v=${version}`,
  /** @param {string} jobId @param {string} name @param {number} [revision] */
  file: (jobId, name, revision) => `/api/jobs/${enc(jobId)}/files/${enc(name)}${revision ? `?revision=${revision}` : ''}`,
  /** @param {string} jobId */
  events: (jobId) => `/api/jobs/${enc(jobId)}/events`,
};

const EVENT_TYPES = /** @type {const} */ (['sentence_done', 'job_done', 'job_failed']);

/**
 * Live job events. The browser reconnects by itself after a drop; the reducer treats replayed events idempotently.
 * @param {string} jobId
 * @param {{onEvent: (event: any) => void, onOpen?: () => void, onError?: (info: {closed: boolean}) => void}} handlers `closed`: the browser gave up and will not reconnect.
 * @returns {() => void} close
 */
export function openJobEvents(jobId, { onEvent, onOpen, onError }) {
  const source = new EventSource(urls.events(jobId), { withCredentials: true });
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      let data;
      try {
        data = JSON.parse(/** @type {MessageEvent} */ (event).data);
      } catch {
        return;
      }
      onEvent({ ...data, type });
    });
  }
  source.onopen = () => onOpen?.();
  source.onerror = () => onError?.({ closed: source.readyState === EventSource.CLOSED });
  return () => source.close();
}
