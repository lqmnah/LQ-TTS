import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAudioToggle } from './useAudioToggle.js';

afterEach(() => vi.restoreAllMocks());

function rejectPlay(error) {
  return vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(error));
}

describe('useAudioToggle', () => {
  it('treats a play() interrupted by pause() as a stop, not a failure, and keeps the element', async () => {
    const play = rejectPlay(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
    const { result } = renderHook(() => useAudioToggle('/a.mp3'));
    await act(() => result.current.toggle());
    expect(result.current.error).toBe(false);
    expect(result.current.playing).toBe(false);
    await act(() => result.current.toggle());
    expect(play.mock.contexts[1]).toBe(play.mock.contexts[0]);
  });

  it('flags a real playback failure and fetches the clip afresh next time', async () => {
    const play = rejectPlay(new DOMException('no supported source', 'NotSupportedError'));
    const { result } = renderHook(() => useAudioToggle('/a.mp3'));
    await act(() => result.current.toggle());
    expect(result.current.error).toBe(true);
    await act(() => result.current.toggle());
    expect(play.mock.contexts[1]).not.toBe(play.mock.contexts[0]);
  });
});
