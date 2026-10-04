import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../lib/errors.js';

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
