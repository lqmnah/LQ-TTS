import { test as base, expect } from '@playwright/test';
import { isSpeculativePrefetch, isTargetOrigin } from '../harness/guard-rules.mjs';
import { accessHeaders } from '../target.mjs';

// Explained, expected aborts: media elements cancel range requests when their source changes, the EventSource
// is closed when a job finishes or the page navigates, a superseded debounced estimate is aborted on purpose,
// Chromium reports file downloads as aborted navigations, and it reports a fetch answered 204 No Content as
// aborted even though the answer arrived (reproduced with a bare node server, so it is not the app).
const answeredNoContent = new WeakSet();

function explainedAbort(request, errorText) {
  if (errorText !== 'net::ERR_ABORTED') return false;
  const url = request.url();
  return answeredNoContent.has(request)
    || ['media', 'eventsource'].includes(request.resourceType())
    || /\/api\/jobs\/estimate$/.test(url)
    || /\/api\/jobs\/[^/]+\/files\//.test(url)
    || /\/api\/jobs\/[^/]+\/events$/.test(url);
}

/** Full request headers (Sec-Purpose is only in the extra-info set); falls back to the provisional ones. */
async function requestHeaders(request) {
  const provisional = request.headers();
  const full = await Promise.race([
    request.allHeaders().catch(() => provisional),
    new Promise((resolve) => setTimeout(() => resolve(provisional), 2_000)),
  ]);
  return { ...provisional, ...full };
}

/**
 * Sends the Cloudflare Access service token with target-origin requests only (page loads, fetch, EventSource,
 * downloads). No-op when the target needs no token. Use it on every context the tests create.
 */
export async function routeAccess(context, baseURL) {
  const access = accessHeaders();
  if (Object.keys(access).length === 0) return;
  const origin = new URL(baseURL).origin;
  await context.route((url) => isTargetOrigin(url.href, origin), (route) => route.continue({ headers: { ...route.request().headers(), ...access } }));
}

export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    await routeAccess(context, baseURL);
    await use(context);
  },
  guard: [async ({ page }, use, testInfo) => {
    const problems = [];
    const expected = [];
    const explainedUrls = new Set();
    const consoleLines = [];
    const pending = [];
    // Speculative prefetches are the browser's, not the app's (see harness/guard-rules.mjs); their failures and
    // the matching "Failed to load resource" console lines are explained.
    const unlessSpeculative = (request, problem) => {
      pending.push(requestHeaders(request).then((headers) => {
        if (isSpeculativePrefetch(headers)) explainedUrls.add(request.url());
        else problems.push(problem);
      }));
    };
    const watch = (p) => {
      p.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') consoleLines.push({ text: `console.${msg.type()}: ${msg.text()} @ ${msg.location().url}`, msg: msg.text(), url: msg.location().url });
      });
      p.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
      p.on('requestfailed', (req) => {
        const errorText = req.failure()?.errorText ?? 'unknown';
        if (!explainedAbort(req, errorText)) unlessSpeculative(req, `requestfailed: ${req.method()} ${req.url()} ${errorText}`);
      });
      p.on('response', (res) => {
        if (res.status() === 204) answeredNoContent.add(res.request());
        if (res.status() < 400) return;
        if (expected.some((fn) => fn(res))) explainedUrls.add(res.url());
        else unlessSpeculative(res.request(), `http ${res.status()}: ${res.request().method()} ${res.url()}`);
      });
    };
    watch(page);
    await use({ watch, expect: (fn) => expected.push(fn), problems });
    await Promise.all(pending);
    // Chromium logs every 4xx/5xx as "Failed to load resource"; that line is explained when its response was.
    for (const line of consoleLines) {
      if (!(line.msg.startsWith('Failed to load resource:') && explainedUrls.has(line.url))) problems.push(line.text);
    }
    await testInfo.attach('console-network.json', { body: JSON.stringify(problems, null, 2), contentType: 'application/json' });
    expect(problems, 'console and network must be clean (SOP G5)').toEqual([]);
  }, { auto: true }],
});

/** GET /api/me answers 401 while nobody is signed in: that is how the app learns it is anonymous. */
export const anonymousProbe = (res) => res.status() === 401 && res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/me';

export { expect };
