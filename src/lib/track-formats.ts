export type OriginalFile = {
  available: true;
  /** The extension SoundCloud actually serves for the artist upload. */
  ext: string;
  codec: string;
  mime: string | null;
  bytes: number | null;
  filename: string | null;
  /** Only set when the source reports a real bitrate. */
  bitrate: number | null;
};

export type OriginalUnavailable = {
  available: false;
  reason:
    | "not-enabled"
    | "quota"
    | "auth-required"
    | "unavailable"
    | "service-unconfigured"
    | "service-error";
  message: string;
};

export type OriginalInfo = OriginalFile | OriginalUnavailable;

export type StreamInfo = {
  preset: string;
  codec: string;
  ext: string;
  bitrate: number | null;
  protocol: "hls" | "progressive";
};

export type TrackFormats = {
  configured: boolean;
  trackId: number;
  original: OriginalInfo;
  streams: StreamInfo[];
  wavConversion: { available: boolean; source: StreamInfo | null };
  account: { configured: boolean };
};
