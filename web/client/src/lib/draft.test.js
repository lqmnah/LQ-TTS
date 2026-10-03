import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadDraft, normalizeSettings, saveDraft } from './draft.js';

describe('draft', () => {
  it('starts empty with engine defaults', () => {
    expect(loadDraft('u1')).toEqual({ text: '', voiceId: '', settings: DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS).toEqual({ speed: 0.9, pause_sentence_s: 0.45, pause_paragraph_s: 0.8, formats: ['mp3', 'wav', 'srt', 'vtt'] });
  });
  it('keeps one draft per account', () => {
    saveDraft('u1', { text: 'Halo.', voiceId: 'v1', settings: DEFAULT_SETTINGS });
    expect(loadDraft('u1').text).toBe('Halo.');
    expect(loadDraft('u2').text).toBe('');
  });
  it('clamps settings into the engine ranges and drops unknown formats', () => {
    expect(normalizeSettings({ speed: 2, pause_sentence_s: -1, pause_paragraph_s: 'x', formats: ['wav', 'ogg'] }))
      .toEqual({ speed: 1.3, pause_sentence_s: 0, pause_paragraph_s: 0.8, formats: ['wav'] });
  });
  it('survives a corrupted entry', () => {
    window.localStorage.setItem('lqtts_draft:u1', '{nope');
    expect(loadDraft('u1').text).toBe('');
  });
});
