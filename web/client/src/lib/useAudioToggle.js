import { useCallback, useEffect, useRef, useState } from 'react';

let current = null;

/** Makes `audio` the one playing element on the page, pausing whichever played before. */
export function claimAudio(audio) {
  if (current && current !== audio) current.pause();
  current = audio;
}

/** Forgets `audio` if it is the registered element. */
export function releaseAudio(audio) {
  if (current === audio) current = null;
}

/** Plays `src`; starting one clip pauses whichever clip played before. */
export function useAudioToggle(src) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const audioRef = useRef(null);

  useEffect(() => () => {
    audioRef.current?.pause();
    releaseAudio(audioRef.current);
  }, []);

  useEffect(() => {
    if (audioRef.current && audioRef.current.dataset.src !== src) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlaying(false);
      setError(false);
    }
  }, [src]);

  const toggle = useCallback(async () => {
    if (!src) return;
    if (playing && audioRef.current) {
      audioRef.current.pause();
      return;
    }
    if (!audioRef.current) {
      const audio = new Audio(src);
      audio.dataset.src = src;
      audio.preload = 'auto';
      audio.addEventListener('play', () => setPlaying(true));
      audio.addEventListener('pause', () => setPlaying(false));
      audio.addEventListener('ended', () => setPlaying(false));
      audioRef.current = audio;
    }
    const audio = audioRef.current;
    claimAudio(audio);
    setError(false);
    try {
      await audio.play();
    } catch (err) {
      setPlaying(false);
      // pause() while play() is pending (second click, another clip started) is not a failure.
      if (err?.name === 'AbortError') return;
      // Drop the failed element so the next click fetches the clip afresh.
      if (audioRef.current === audio) audioRef.current = null;
      releaseAudio(audio);
      setError(true);
    }
  }, [src, playing]);

  return { playing, error, toggle };
}
