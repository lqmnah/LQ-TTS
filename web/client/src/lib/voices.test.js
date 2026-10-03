import { describe, expect, it } from 'vitest';
import { MAX_AUDIO_BYTES, audioFileProblem, countsTowardLimit } from './voices.js';

const file = (name, size) => ({ name, size });

describe('audioFileProblem', () => {
  it('accepts the four formats, case-insensitively', () => {
    for (const name of ['a.mp3', 'b.WAV', 'c.m4a', 'd.Flac']) expect(audioFileProblem(file(name, 1000))).toBeNull();
  });
  it('rejects missing, unsupported, empty and oversized files', () => {
    expect(audioFileProblem(null)).toBe('voices.form.audio_required');
    expect(audioFileProblem(file('clip.ogg', 1000))).toBe('voices.form.audio_type');
    expect(audioFileProblem(file('noext', 1000))).toBe('voices.form.audio_type');
    expect(audioFileProblem(file('a.wav', 0))).toBe('voices.form.audio_empty');
    expect(audioFileProblem(file('a.wav', MAX_AUDIO_BYTES))).toBeNull();
    expect(audioFileProblem(file('a.wav', MAX_AUDIO_BYTES + 1))).toBe('voices.form.audio_size');
  });
});

describe('countsTowardLimit', () => {
  it('counts processing and ready voices, not failed ones (spec §4)', () => {
    expect(countsTowardLimit({ status: 'processing' })).toBe(true);
    expect(countsTowardLimit({ status: 'ready' })).toBe(true);
    expect(countsTowardLimit({ status: 'failed' })).toBe(false);
  });
});
