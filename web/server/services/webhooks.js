import { Agent, request } from 'undici';
import { apiFiles } from './api-jobs.js';
import { LOOKUP_TIMEOUT_MS, WebhookUrlError, resolveWebhookUrl, signWebhook } from './webhook-security.js';

export const ATTEMPT_DELAYS_S = Object.freeze([0, 60, 300, 1800]); // after the event; the 4th failure drops it
export const DELIVERY_TIMEOUT_MS = 10_000;
export const MIN_RETRY_GAP_S = 30; // after downtime, retries still never come back to back
const LEASE_SLACK_MS = 15_000; // beyond the DNS bound and the request timeout: connect setup and the result write
const EVENTS = Object.freeze({ done: 'job.done', failed: 'job.failed' });
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_ABORTED']);

export const toDelivery = (r) => ({
  id: String(r.id), keyId: r.api_key_id, keyName: r.key_name, jobId: r.job_id, event: r.event, state: r.state,
  attempts: r.attempts, lastStatus: r.last_status, createdAt: r.created_at, finishedAt: r.finished_at,
});

export function createWebhooks(ctx, { timeoutMs = DELIVERY_TIMEOUT_MS, lookup } = {}) {
  const { pool, engine, jobsRepo, apiKeys, config, log } = ctx;

  /**
   * Records the webhook of an API job's first render reaching done or failed, at most once per job. The body is
   * frozen now: credits after settle/refund, files or errorCode from the engine when it answers. While a charge of
   * that render is still held the credits are not final, so nothing is recorded: the retried engine callback or the
   * reconciler that resolves the charge records it then.
   */
  async function onTerminal(jobId, { status, revision }) {
    if (revision !== 1 || !EVENTS[status]) return false;
    const job = await jobsRepo.get(jobId);
    if (!job || job.source !== 'api' || !job.webhook_url || !job.api_key_id) return false;
    const { rows: [pending] } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM webhook_deliveries WHERE job_id = $1) AS recorded,
              EXISTS (SELECT 1 FROM charges WHERE job_id = $1 AND state = 'held' AND revision <= $2) AS held`,
      [jobId, revision],
    );
    if (pending.recorded || pending.held) return false;
    let view = null;
    try {
      view = await engine.getJob(jobId);
    } catch {
      // the event, status and credits are enough
    }
    const row = await jobsRepo.own(job.user_id, jobId);
    const body = JSON.stringify({
      event: EVENTS[status],
      jobId,
      status,
      credits: row?.credits ?? 0,
      ...(status === 'failed' ? { errorCode: view?.error_code ?? null } : {}),
      ...(status === 'done' && view ? { files: apiFiles(jobId, view.files) ?? {} } : {}),
      createdAt: job.created_at,
    });
    const { rowCount } = await pool.query(
      `INSERT INTO webhook_deliveries (api_key_id, user_id, job_id, event, url, body)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (job_id) DO NOTHING`,
      [job.api_key_id, job.user_id, jobId, EVENTS[status], job.webhook_url, body],
    );
    if (rowCount > 0) kick();
    return rowCount > 0;
  }

  // One row at a time, leased for one whole delivery: the DNS check, the request, and slack for the result write.
  // A lease that runs out (a crashed process) makes the row due again.
  async function claimNext() {
    const { rows: [row] } = await pool.query(
      `UPDATE webhook_deliveries d SET sending_until = now() + make_interval(secs => $1::double precision / 1000)
       FROM api_keys k
       WHERE k.id = d.api_key_id
         AND d.id = (SELECT id FROM webhook_deliveries
                     WHERE state = 'pending' AND next_attempt_at <= now() AND (sending_until IS NULL OR sending_until < now())
                     ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING d.*, k.revoked_at AS key_revoked_at, k.webhook_secret_enc`,
      [LOOKUP_TIMEOUT_MS + timeoutMs + LEASE_SLACK_MS],
    );
    return row ?? null;
  }

  // Resolves and checks the URL again, then POSTs to exactly the checked address: the pinned lookup hands net/tls that
  // address, while the Host header and the TLS server name stay the URL's hostname. Never follows redirects.
  async function send(row) {
    let target;
    try {
      target = await resolveWebhookUrl(row.url, { allowLoopback: config.webhookAllowLoopback, ...(lookup ? { lookup } : {}) });
    } catch (err) {
      return { error: err instanceof WebhookUrlError ? `blocked: ${err.message}` : 'resolve_failed' };
    }
    const secret = apiKeys.webhookSecret({ id: row.api_key_id, webhook_secret_enc: row.webhook_secret_enc });
    const pinned = (_hostname, options, callback) => (options?.all
      ? callback(null, [{ address: target.address, family: target.family }])
      : callback(null, target.address, target.family));
    const agent = new Agent({ connect: { timeout: timeoutMs, lookup: pinned }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    try {
      const res = await request(target.url, {
        method: 'POST',
        dispatcher: agent,
        signal: AbortSignal.timeout(timeoutMs),
        body: row.body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'LQ-TTS-Webhooks/1',
          'lqtts-event': row.event,
          'lqtts-delivery': String(row.id),
          'lqtts-signature': signWebhook(secret, row.body),
        },
      });
      await res.body.dump().catch(() => {});
      return { status: res.statusCode, delivered: res.statusCode >= 200 && res.statusCode < 300 };
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || TIMEOUT_CODES.has(err?.code);
      return { error: timedOut ? 'timeout' : String(err?.code ?? 'connect_failed') };
    } finally {
      agent.destroy().catch(() => {});
    }
  }

  async function record(row, outcome) {
    if (outcome.delivered) {
      await pool.query(
        `UPDATE webhook_deliveries SET state = 'delivered', attempts = attempts + 1, last_status = $2, last_error = NULL,
           finished_at = now(), sending_until = NULL WHERE id = $1`,
        [row.id, outcome.status],
      );
      return;
    }
    const attempts = row.attempts + 1;
    const final = Boolean(outcome.drop) || attempts >= ATTEMPT_DELAYS_S.length;
    await pool.query(
      `UPDATE webhook_deliveries SET attempts = $2, last_status = $3, last_error = $4, sending_until = NULL,
         state = CASE WHEN $5::boolean THEN 'dropped' ELSE 'pending' END,
         finished_at = CASE WHEN $5::boolean THEN now() ELSE NULL END,
         next_attempt_at = CASE WHEN $5::boolean THEN next_attempt_at
           ELSE greatest(created_at + make_interval(secs => $6::double precision), now() + make_interval(secs => $7::double precision)) END
       WHERE id = $1`,
      [row.id, attempts, outcome.status ?? null, outcome.error ?? null, final, final ? 0 : ATTEMPT_DELAYS_S[attempts], MIN_RETRY_GAP_S],
    );
    if (final) {
      log.warn({ event: 'webhook_dropped', deliveryId: String(row.id), jobId: row.job_id, attempts, error: outcome.error ?? `HTTP ${outcome.status}` }, 'webhook delivery dropped');
    }
  }

  let stopped = false;
  async function pass() {
    let handled = 0;
    while (!stopped) {
      const row = await claimNext();
      if (!row) break;
      handled += 1;
      const outcome = row.key_revoked_at
        ? { drop: true, error: 'key_revoked' }
        : await send(row).catch((err) => {
          log.error({ event: 'webhooks_failed', deliveryId: String(row.id), error: String(err?.stack ?? err) }, 'webhook send failed');
          return { error: 'internal' };
        });
      await record(row, outcome);
    }
    return { handled };
  }

  // Passes run one at a time; every caller gets a pass that starts after its call.
  let chain = Promise.resolve();
  let waiting = null;
  function runOnce() {
    if (waiting) return waiting;
    const next = chain.then(() => {
      waiting = null;
      return pass();
    });
    waiting = next;
    chain = next.catch(() => {});
    return next;
  }
  const safeRun = () => runOnce().catch((err) =>
    log.error({ event: 'webhooks_failed', error: String(err?.stack ?? err) }, 'webhook pass failed'));
  // Only a started worker sends in the background; an unstarted one (tests, one-off scripts) waits for runOnce().
  let timer = null;
  function kick() {
    if (timer && !stopped) safeRun();
  }

  return {
    onTerminal,
    runOnce,
    kick,
    start({ intervalMs = 5000 } = {}) {
      stopped = false;
      timer = setInterval(safeRun, intervalMs);
      timer.unref();
      safeRun();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      await chain;
    },
    // The last 20 deliveries of each of the user's active keys, newest first.
    async listForUser(userId) {
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT d.*, k.name AS key_name,
                  row_number() OVER (PARTITION BY d.api_key_id ORDER BY d.created_at DESC, d.id DESC) AS rn
           FROM webhook_deliveries d JOIN api_keys k ON k.id = d.api_key_id
           WHERE k.user_id = $1 AND k.revoked_at IS NULL) x
         WHERE rn <= 20 ORDER BY created_at DESC, id DESC`,
        [userId],
      );
      return rows.map(toDelivery);
    },
  };
}
