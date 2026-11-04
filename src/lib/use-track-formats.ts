import { useEffect, useState } from "react";

import { trackAppError } from "./analytics";
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
      .then(async (response) => {
        if (!response.ok) throw new Error(`formats service ${response.status}`);
        return (await response.json()) as TrackFormats;
      })
      .then((data) => {
        if (active) setState({ formats: data, loading: false });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setState({ formats: null, loading: false });
        trackAppError({ stage: "formats", error });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [trackId]);

  return state;
}
