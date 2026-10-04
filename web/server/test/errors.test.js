import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../clients/http.js';
import { ApiError, errorHandler } from '../lib/errors.js';
import { lqError } from '../lib/upstream-errors.js';

const logs = [];
const log = { error: (fields) => logs.push(fields) };
const app = express();
app.use(express.json());
app.post('/x', (req, res) => res.json(req.body));
app.use(errorHandler(log));

const fakeRes = ({ headersSent = false } = {}) => ({
  headersSent,
  destroyed: false,
  statusCode: undefined,
  body: undefined,
  destroy() {
    this.destroyed = true;
  },
  set() {
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe('errorHandler', () => {
  it('answers an unsupported body charset or encoding with 415 invalid_request', async () => {
    const variants = [
      { 'content-type': 'application/json; charset=latin1' },
      { 'content-type': 'application/json', 'content-encoding': 'compress' },
    ];
    for (const headers of variants) {
      const res = await request(app).post('/x').set(headers).send('{"a":1}');
      expect(res.status).toBe(415);
      expect(res.body).toEqual({ error: { code: 'invalid_request', message: 'unsupported body charset or encoding' } });
    }
    expect(logs).toEqual([]);
  });

  it('answers a body cut off mid-request with 400 invalid_request', () => {
    const res = fakeRes();
    errorHandler(log)(Object.assign(new Error('request aborted'), { type: 'request.aborted' }), { path: '/x' }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: 'invalid_request', message: 'request body was cut off' } });
    expect(logs).toEqual([]);
  });

  it('closes the connection instead of answering twice once headers are sent', () => {
    const res = fakeRes({ headersSent: true });
    errorHandler(log)(new Error('late failure'), { path: '/x' }, res);
    expect(res.destroyed).toBe(true);
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toBeUndefined();
  });
});

describe('error details', () => {
  it('adds an ApiError\'s details next to code and message, never replacing them', async () => {
    const detailed = express();
    detailed.get('/x', () => {
      throw new ApiError('insufficient_credits', 'not enough', { details: { balance: 3, code: 'other', message: 'other' } });
    });
    detailed.use(errorHandler({ error() {} }));
    const res = await request(detailed).get('/x');
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: { code: 'insufficient_credits', message: 'not enough', balance: 3 } });
  });

  it('keeps the balance LQ-Studio sent with a 402', () => {
    const err = lqError(new UpstreamError('lqstudio', 402, 'insufficient_credits', 'insufficient_credits', { error: 'insufficient_credits', balance: 5 }));
    expect(err).toMatchObject({ code: 'insufficient_credits', status: 402, details: { balance: 5 } });
    expect(lqError(new UpstreamError('lqstudio', 402, 'insufficient_credits', 'x', null)).details).toEqual({});
  });
});
