import http from 'node:http';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// In-memory stand-in for LQ-Studio's /api/internal/tts/* (contract C1), incl. the guard's behaviour.
export async function startFakeLqStudio({ port = 0, token, users = [] } = {}) {
  const state = {
    users: new Map(users.map((u) => [String(u.id), { tv: 0, ...u }])),
    ledger: [],
    settled: new Set(),
    refunded: new Set(),
    calls: [],
    down: false,
    rateLimited: false, // the login backoff: 429 with retryAfter
    guardRateLimited: false, // the internal-route guard's own limit: 429 without retryAfter
    failNext: new Map(),
    challenges: new Map(),
    holds: new Map(), // ref → { userId, charged } as first answered (replays answer the current balance)
    net(ref) {
      return this.ledger.filter((l) => l.ref === ref).reduce((sum, l) => sum + (l.type === 'deduct' ? l.amount : -l.amount), 0);
    },
    callsTo(path) {
      return this.calls.filter((c) => c.path === path);
    },
  };
  const pub = (u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, paid: u.paid, tv: u.tv });
  // Like the door's zod schema, which runs before the service.
  const invalidAmount = (res) => json(res, 400, { error: 'Jumlah tidak valid', code: 'validation', field: 'amount' });
  const byIdentifier = (identifier) => {
    const id = String(identifier ?? '').toLowerCase();
    return [...state.users.values()].find((u) => u.email.toLowerCase() === id || u.username.toLowerCase() === id);
  };
  const hasHold = (userId, ref) => state.holds.get(ref)?.userId === userId;
  let challengeSeq = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fake');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, state.down ? 503 : 200, { ok: !state.down });
      const prefix = '/api/internal/tts';
      if (!url.pathname.startsWith(prefix)) return json(res, 404, { error: 'not_found' });
      const path = url.pathname.slice(prefix.length);
      const body = req.method === 'POST' ? await readJson(req) : {};
      state.calls.push({ method: req.method, path, body, headers: req.headers });
      if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return json(res, 403, { ok: false, error: 'internal_route_not_public' });
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { ok: false, error: 'unauthorized' });
      if (state.guardRateLimited) return json(res, 429, { ok: false, error: 'rate_limited' });
      if (state.down) return json(res, 503, { error: 'unavailable' });
      const key = `${req.method} ${path.startsWith('/users/') ? '/users/:id' : path}`;
      const left = state.failNext.get(key) ?? 0;
      if (left > 0) {
        state.failNext.set(key, left - 1);
        return json(res, 503, { error: 'ledger_unavailable' });
      }

      if (req.method === 'POST' && path === '/auth/verify') {
        if (state.rateLimited) return json(res, 429, { error: 'rate_limited', retryAfter: 30 });
        const u = byIdentifier(body.identifier);
        if (!u || u.password !== body.password) return json(res, 401, { error: 'invalid_credentials' });
        if (u.suspended) return json(res, 403, { error: 'suspended' });
        if (!u.verified) return json(res, 200, { status: 'needs_verification' });
        if (u.totp) {
          const challenge = `ch:${u.id}:${++challengeSeq}`;
          state.challenges.set(challenge, u.id);
          return json(res, 200, { status: 'need_2fa', challenge });
        }
        return json(res, 200, { status: 'ok', user: pub(u) });
      }
      if (req.method === 'POST' && path === '/auth/verify-2fa') {
        // Same order as LQ-Studio's periksa2fa: unknown challenge, then suspension (challenge kept), then the code.
        const u = state.users.get(state.challenges.get(body.challenge) ?? '');
        if (!u) return json(res, 401, { error: 'invalid_code' });
        if (u.suspended) return json(res, 403, { error: 'suspended' });
        if (String(body.code) !== u.totp) return json(res, 401, { error: 'invalid_code' });
        state.challenges.delete(body.challenge);
        if (!u.verified) return json(res, 200, { status: 'needs_verification' });
        return json(res, 200, { status: 'ok', user: pub(u) });
      }
      if (req.method === 'GET' && path.startsWith('/users/')) {
        const u = state.users.get(decodeURIComponent(path.slice('/users/'.length)));
        if (!u) return json(res, 404, { error: 'not_found' });
        state.beforeGetUser?.(u); // test hook, e.g. bump tv between verify and this read
        return json(res, 200, { ...pub(u), balance: u.balance, suspended: u.suspended, verified: u.verified });
      }
      if (req.method === 'POST' && path === '/credits/hold') {
        if (!Number.isSafeInteger(body.amount) || body.amount <= 0) return invalidAmount(res);
        const u = state.users.get(String(body.userId));
        if (!u) return json(res, 404, { error: 'not_found' });
        if (u.suspended) return json(res, 403, { error: 'suspended' });
        const prior = state.holds.get(body.ref);
        if (prior && prior.userId !== u.id) return json(res, 409, { error: 'ref_conflict' });
        // A settled or refunded hold is terminal: its ref never takes credits again.
        if (prior && (state.settled.has(body.ref) || state.refunded.has(body.ref))) return json(res, 409, { error: 'ref_conflict' });
        if (prior) return json(res, 200, { holdId: body.ref, charged: prior.charged, balance: u.balance });
        if (u.balance < body.amount) return json(res, 402, { error: 'insufficient_credits', balance: u.balance });
        u.balance -= body.amount;
        state.ledger.push({ ref: body.ref, userId: u.id, type: 'deduct', amount: body.amount });
        state.holds.set(body.ref, { userId: u.id, charged: body.amount });
        return json(res, 200, { holdId: body.ref, charged: body.amount, balance: u.balance });
      }
      if (req.method === 'POST' && (path === '/credits/settle' || path === '/credits/refund')) {
        if (path === '/credits/settle' && (!Number.isSafeInteger(body.amount) || body.amount < 0)) return invalidAmount(res);
        const u = state.users.get(String(body.userId));
        if (!u || !hasHold(u.id, body.holdId)) return json(res, 404, { error: 'not_found' });
        if (path === '/credits/settle') {
          // Validated against the gross charge; once settled or refunded the hold is terminal and nothing moves.
          if (body.amount > state.holds.get(body.holdId).charged) {
            return json(res, 400, { error: 'invalid_request', message: 'amount exceeds the held credits' });
          }
          if (!state.settled.has(body.holdId) && !state.refunded.has(body.holdId)) {
            const remainder = state.net(body.holdId) - body.amount;
            if (remainder > 0) {
              u.balance += remainder;
              state.ledger.push({ ref: body.holdId, userId: u.id, type: 'refund', amount: remainder });
            }
            state.settled.add(body.holdId);
          }
          return json(res, 200, { balance: u.balance });
        }
        const owed = state.settled.has(body.holdId) || state.refunded.has(body.holdId) ? 0 : Math.max(0, state.net(body.holdId));
        if (owed > 0) {
          u.balance += owed;
          state.ledger.push({ ref: body.holdId, userId: u.id, type: 'refund', amount: owed });
        }
        if (!state.settled.has(body.holdId)) state.refunded.add(body.holdId);
        return json(res, 200, { balance: u.balance, refunded: owed });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      return json(res, 500, { error: 'internal', message: String(err) });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    bumpTv(id) {
      state.users.get(String(id)).tv += 1;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
