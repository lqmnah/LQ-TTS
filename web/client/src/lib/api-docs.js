// Code shown on /developers. Kept out of the dictionaries: code is not translated. Every name, header, code and limit
// here mirrors web/server (routes/v1.js, http/api-auth.js, services/api-jobs.js, services/webhooks.js,
// services/webhook-security.js, lib/errors.js); change both together.

export const BASE_URL = 'https://tts.lq-studio.com';

/** [method, path, dictionary key under docs.endpoint.*] */
export const ENDPOINTS = [
  ['GET', '/v1/voices', 'voices'],
  ['POST', '/v1/estimate', 'estimate'],
  ['POST', '/v1/tts', 'create'],
  ['GET', '/v1/tts/{jobId}', 'get'],
  ['GET', '/v1/tts/{jobId}/files/{name}', 'file'],
  ['DELETE', '/v1/tts/{jobId}', 'delete'],
];

/** [code, HTTP status (or statuses)]; the text is docs.error.<code>. */
export const ERRORS = [
  ['invalid_request', '400, 415'], ['invalid_webhook_url', 400], ['unauthorized', 401], ['insufficient_credits', 402],
  ['plan_required', 403], ['suspended', 403], ['needs_verification', 403], ['not_found', 404], ['voice_not_ready', 409],
  ['idempotency_conflict', 409], ['busy', 409], ['too_large', 413], ['too_many_jobs', 429], ['rate_limited', 429],
  ['internal_error', 500], ['lqstudio_unavailable', 503], ['engine_unavailable', 503],
];

const files = {
  mp3: '/v1/tts/JOB_ID/files/final.mp3',
  srt: '/v1/tts/JOB_ID/files/subtitles.srt',
};
const createdAt = '2026-10-04T08:00:00.000Z';

// Exactly the bytes the server sends: compact JSON. The signature below is real for this body, t=1760000000 and the
// webhook secret "whsec_test", so a reader can check their verifier against it.
const webhookRaw = JSON.stringify({ event: 'job.done', jobId: 'JOB_ID', status: 'done', credits: 1, files, createdAt });

export const SAMPLES = {
  auth: `curl ${BASE_URL}/v1/voices \\
  -H "Authorization: Bearer $LQTTS_KEY"`,
  create: `curl ${BASE_URL}/v1/tts \\
  -H "Authorization: Bearer $LQTTS_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042" \\
  -d '{"voiceId":"VOICE_ID","text":"Halo, ini voiceover dari API.","formats":["mp3","srt"],"webhookUrl":"https://example.com/lqtts-hook"}'`,
  createAnswer: `HTTP/1.1 202 Accepted

${JSON.stringify({ jobId: 'JOB_ID', credits: 1, status: 'queued' }, null, 2)}`,
  poll: `curl ${BASE_URL}/v1/tts/JOB_ID \\
  -H "Authorization: Bearer $LQTTS_KEY"`,
  pollAnswer: `HTTP/1.1 200 OK

${JSON.stringify({
    jobId: 'JOB_ID', status: 'done', progress: { done: 1, total: 1 }, credits: 1, errorCode: null, files, createdAt,
  }, null, 2)}`,
  download: `curl -o voiceover.mp3 ${BASE_URL}/v1/tts/JOB_ID/files/final.mp3 \\
  -H "Authorization: Bearer $LQTTS_KEY"`,
  webhookBody: `POST /lqtts-hook HTTP/1.1
Host: example.com
Content-Type: application/json
User-Agent: LQ-TTS-Webhooks/1
LQTTS-Event: job.done
LQTTS-Delivery: 1842
LQTTS-Signature: t=1760000000,v1=c24661daac2a5f47b1d30e3c56ce65a4fb4820595d0c251bd2458e9457d7c3d3

${webhookRaw}`,
  verifyNode: `import crypto from 'node:crypto';

// rawBody: the request body exactly as received (string or Buffer), before JSON.parse.
export function verifyLqttsWebhook(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(signatureHeader ?? '').split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  const given = Buffer.from(String(parts.v1 ?? ''));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}`,
  verifyPython: `import hashlib
import hmac
import time


# raw_body: the request body exactly as received (bytes), before json.loads.
def verify_lqtts_webhook(raw_body: bytes, signature_header: str, secret: str, tolerance_seconds: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in (signature_header or "").split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs(time.time() - t) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.encode(), parts.get("v1", "").encode())`,
};
