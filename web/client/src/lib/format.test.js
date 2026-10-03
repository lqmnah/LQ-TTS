import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration } from './format.js';

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65.4)).toBe('1:05');
    expect(formatDuration(599.6)).toBe('10:00');
  });
  it('adds hours past one hour', () => {
    expect(formatDuration(3665)).toBe('1:01:05');
  });
  it('renders a dash for unknown values', () => {
    expect(formatDuration(null)).toBe('–');
    expect(formatDuration(Number.NaN)).toBe('–');
  });
});

describe('formatBytes', () => {
  it('uses MB with one decimal and the language separator', () => {
    expect(formatBytes(12.3 * 1024 * 1024, 'id')).toBe('12,3 MB');
    expect(formatBytes(12.3 * 1024 * 1024, 'en')).toBe('12.3 MB');
  });
  it('uses KB below one megabyte', () => {
    expect(formatBytes(2048, 'en')).toBe('2 KB');
  });
});
