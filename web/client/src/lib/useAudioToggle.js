import { useCallback, useEffect, useRef, useState } from 'react';

let current = null;

/** Plays `src`; starting one clip pauses whichever clip played before. */
export function useAudioToggle(src) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);

  useEffect(() => () => {
    audioRef.current?.pause();
    if (current === audioRef.current) current = null;
  }, []);

  useEffect(() => {
    if (audioRef.current && audioRef.current.dataset.src !== src) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlaying(false);
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
    if (current && current !== audioRef.current) current.pause();
    current = audioRef.current;
    try {
      await audioRef.current.play();
    } catch {
      setPlaying(false);
    }
  }, [src, playing]);

  return { playing, toggle };
}
