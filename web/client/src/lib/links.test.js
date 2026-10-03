import { describe, expect, it } from 'vitest';
import { lqstudioOrigin, safeNext } from './links.js';

describe('lqstudioOrigin', () => {
  it('maps only the PROD host to PROD LQ-Studio', () => {
    expect(lqstudioOrigin('tts.lq-studio.com')).toBe('https://lq-studio.com');
    expect(lqstudioOrigin('tts-stg.lq-studio.com')).toBe('https://demo.lq-studio.com');
    expect(lqstudioOrigin('127.0.0.1')).toBe('https://demo.lq-studio.com');
  });
});

describe('safeNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/voices')).toBe('/voices');
    expect(safeNext('/jobs/abc?x=1')).toBe('/jobs/abc?x=1');
  });
  it('rejects open redirects and loops', () => {
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
