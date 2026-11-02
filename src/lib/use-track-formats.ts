import { useEffect, useState } from "react";

import type { TrackFormats } from "./track-formats";

export function useTrackFormats(trackId: number): {
  formats: TrackFormats | null;
  loading: boolean;
} {
  const [state, setState] = useState<{ formats: TrackFormats | null; loading: boolean }>({
    formats: null,
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ formats: null, loading: true });

    fetch(`/api/public/formats?id=${trackId}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: TrackFormats | null) => {
        if (active) setState({ formats: data ?? null, loading: false });
      })
      .catch(() => {
        if (active) setState({ formats: null, loading: false });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [trackId]);

  return state;
}
