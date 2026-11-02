import { useEffect, useRef, useState } from "react";
import { Headphones, Loader2, Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";

import { formatDuration } from "@/lib/search-rank";
import type { TrackDetails } from "@/lib/soundcloud.server";
import { cn } from "@/lib/utils";

const clock = (seconds: number) =>
  formatDuration(Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : 0));

export function PreviewPlayer({ track }: { track: TrackDetails }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(Math.max(0, Math.round(track.duration / 1000)));
  const [volume, setVolume] = useState(0.9);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlaying(false);
    setLoading(false);
    setError(null);
    setCurrent(0);
    setDuration(Math.max(0, Math.round(track.duration / 1000)));
  }, [track.id, track.duration]);

  function syncDuration() {
    const el = audioRef.current;
    if (!el) return;
    const real = Math.max(0, Math.round(track.duration / 1000));
    // Only snippets are shorter than the track: trust that stream's length.
    if (track.snippet && Number.isFinite(el.duration) && el.duration > 0) {
      setDuration(Math.min(real || el.duration, el.duration));
      return;
    }
    setDuration(real);
  }

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    setError(null);
    if (playing) {
      el.pause();
      return;
    }
    setLoading(true);
    void el
      .play()
      .then(() => setLoading(false))
      .catch(() => {
        setLoading(false);
        setPlaying(false);
        setError("The preview couldn't play. Check your connection and try again.");
      });
  }

  function seek(value: number) {
    setCurrent(value);
    const el = audioRef.current;
    if (!el) return;
    try {
      el.currentTime = value;
    } catch {
      /* the joined stream may not be seekable yet */
    }
  }

  function retry() {
    const el = audioRef.current;
    if (!el) return;
    setError(null);
    setLoading(true);
    el.load();
    void el
      .play()
      .then(() => setLoading(false))
      .catch(() => {
        setLoading(false);
        setError("The preview still isn't available. Try again in a moment.");
      });
  }

  function changeVolume(next: number) {
    setVolume(next);
    setMuted(next === 0);
    const el = audioRef.current;
    if (el) {
      el.volume = next;
      el.muted = next === 0;
    }
  }

  function toggleMute() {
    const el = audioRef.current;
    const next = !muted;
    setMuted(next);
    if (el) el.muted = next;
  }

  if (!track.previewAllowed) {
    return (
      <section className="rounded-2xl border border-border bg-card/50 p-5 sm:p-6">
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <Headphones className="h-3.5 w-3.5" /> Preview
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            SoundCloud isn't providing an authorized preview stream for this track.
          </p>
          <a
            href={track.permalink_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground transition hover:border-primary/50 hover:text-primary"
          >
            Listen on SoundCloud
          </a>
        </div>
      </section>
    );
  }

  const progress = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;
  const volumeValue = muted ? 0 : volume;

  return (
    <section className="rounded-2xl border border-border bg-card/60 p-5 shadow-xl shadow-black/20 backdrop-blur sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden /> Preview
        </p>
        {track.snippet && (
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-foreground">
            Official 30-second preview
          </span>
        )}
      </div>

      <audio
        ref={audioRef}
        src={`/api/public/preview?id=${track.id}`}
        preload="none"
        onLoadedMetadata={syncDuration}
        onDurationChange={syncDuration}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onPlaying={() => setLoading(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(duration);
        }}
        onError={() => {
          setLoading(false);
          setPlaying(false);
          setError("The preview couldn't be loaded. SoundCloud may be temporarily unavailable.");
        }}
      />

      <div className="mt-4 flex items-center gap-4">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause preview" : "Play preview"}
          className={cn(
            "flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground",
            "shadow-lg shadow-primary/25 transition hover:scale-[1.04] hover:brightness-110",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          {loading ? (
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
          ) : playing ? (
            <Pause className="h-6 w-6" fill="currentColor" aria-hidden />
          ) : (
            <Play className="ml-0.5 h-6 w-6" fill="currentColor" aria-hidden />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={Math.max(1, duration)}
            step={0.1}
            value={Math.min(current, duration)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek preview"
            className="range-brand w-full cursor-pointer"
            style={{ ["--range-progress" as string]: `${progress}%` }}
          />
          <div className="mt-2 flex items-center justify-between text-xs tabular-nums text-muted-foreground">
            <span>{clock(current)}</span>
            <span>{clock(duration)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
        <p className="text-xs text-muted-foreground">
          Streamed from SoundCloud's authorized preview source.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? "Unmute preview" : "Mute preview"}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            {muted || volume === 0 ? (
              <VolumeX className="h-4 w-4" aria-hidden />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volumeValue}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label="Preview volume"
            className="range-brand w-24 cursor-pointer"
            style={{ ["--range-progress" as string]: `${volumeValue * 100}%` }}
          />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5"
        >
          <p className="text-xs text-destructive">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold transition hover:bg-accent"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
          </button>
        </div>
      )}
    </section>
  );
}
