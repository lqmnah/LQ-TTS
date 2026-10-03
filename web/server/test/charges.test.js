import { describe, expect, it } from 'vitest';
import { decide } from '../services/charges.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const charge = (extra = {}) => ({ job_id: 'j1', revision: 1, created_at: new Date(NOW - 3 * 60000), ...extra });
const young = { created_at: new Date(NOW - 30000) };

describe('decide', () => {
  it.each([
    ['done at the same revision', charge(), { status: 'done', revision: 1 }, 'settle'],
    ['failed', charge(), { status: 'failed', revision: 1 }, 'refund'],
    ['canceled', charge(), { status: 'canceled', revision: 1 }, 'refund'],
    ['still running', charge(), { status: 'running', revision: 1 }, 'wait'],
    ['still queued', charge(), { status: 'queued', revision: 1 }, 'wait'],
    ['a later revision exists, so this one finished', charge(), { status: 'queued', revision: 2 }, 'settle'],
    ['the engine never got this revision', charge({ revision: 3 }), { status: 'done', revision: 2 }, 'refund'],
    ['the engine may still be receiving this revision', charge({ revision: 3, ...young }), { status: 'done', revision: 2 }, 'wait'],
    ['the job is gone from the engine', charge(), null, 'refund'],
    ['create crashed before the job row existed', charge({ job_id: null }), null, 'refund'],
    ['create may still be in flight', charge({ job_id: null, ...young }), null, 'wait'],
  ])('%s', (_, c, view, expected) => {
    expect(decide(c, view, NOW)).toBe(expected);
  });
});
