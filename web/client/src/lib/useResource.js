import { useCallback, useEffect, useRef, useState } from 'react';

/** Loads `fetcher()` on mount and when `deps` change; older responses never overwrite newer ones. */
export function useResource(fetcher, deps) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const seq = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fetcher();
      if (mine === seq.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (mine === seq.current) setState((s) => ({ data: s.data, error, loading: false }));
      return undefined;
    }
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  const setData = useCallback((next) => {
    setState((s) => ({ ...s, data: typeof next === 'function' ? next(s.data) : next }));
  }, []);

  return { ...state, reload, setData };
}
