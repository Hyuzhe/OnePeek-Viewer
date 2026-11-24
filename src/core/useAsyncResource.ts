import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// Reusable hook eliminating repetitive async load/cancel/error boilerplate across viewers
export function useAsyncResource<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[]
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let active = true;
    setState({ data: null, loading: true, error: null });

    loader()
      .then((result) => {
        if (active) setState({ data: result, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (active) {
          const msg = err instanceof Error ? err.message : String(err);
          setState({ data: null, loading: false, error: msg });
        }
      });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
