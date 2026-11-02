from __future__ import annotations

from formats import (
    FormatService,
    OriginalFile,
    StreamFormat,
    TrackFormats,
    _is_original_format,
    ext_from_filename,
    ext_from_url,
    filename_from_disposition,
    is_allowed_source,
    normalize_ext,
    pick_ext,
    safe_filename,
)
from sc_api import ApiTrack


def test_normalize_ext() -> None:
    assert normalize_ext(".WAV") == "wav"
    assert normalize_ext("flac") == "flac"
    assert normalize_ext("aif") == "aif"
    assert normalize_ext("") is None
    assert normalize_ext("../wav") is None


def test_ext_from_names() -> None:
    assert ext_from_filename("Artist - Song.FLAC") == "flac"
    assert ext_from_filename("no-extension") is None
    assert ext_from_url("https://cf-media.sndcdn.com/abc.aiff?policy=1") == "aiff"
    assert ext_from_url("https://cf-media.sndcdn.com/abc?policy=1") is None


def test_content_disposition_parsing() -> None:
    assert filename_from_disposition('attachment; filename="song.wav"') == "song.wav"
    assert (
        filename_from_disposition("attachment; filename*=UTF-8''Bj%C3%B6rk%20-%20J%C3%B3ga.flac")
        == "Björk - Jóga.flac"
    )
    assert filename_from_disposition(None) is None


def test_safe_filename_keeps_extension_when_truncating() -> None:
    name = safe_filename("a" * 400 + ".wav", "fallback.wav")
    assert len(name) <= 180
    assert name.endswith(".wav")
    assert safe_filename('bad/path\\name?.mp3', "fallback.mp3") == "bad_path_name_.mp3"
    assert safe_filename("   ", "fallback.wav") == "fallback.wav"


def test_source_allowlist() -> None:
    assert is_allowed_source("https://cf-media.sndcdn.com/x.wav")
    assert is_allowed_source("https://api-v2.soundcloud.com/media/1/stream/hls")
    assert is_allowed_source("https://playback.media-streaming.soundcloud.cloud/abc/aac_160k/1")
    assert not is_allowed_source("http://cf-media.sndcdn.com/x.wav")
    assert not is_allowed_source("https://sndcdn.com.evil.test/x.wav")
    assert not is_allowed_source("https://127.0.0.1/x.wav")
    assert not is_allowed_source(None)


def test_original_is_only_a_real_original_format() -> None:
    # A WAV-extension transcoding must never be treated as the artist upload.
    assert not _is_original_format({"format_id": "hls_aac_160k", "format_note": "AAC", "ext": "wav"})
    assert _is_original_format({"format_id": "download", "format_note": "Original"})
    assert _is_original_format({"format_id": "x", "format_note": "Original upload"})


def test_normalize_streams_ignores_downloads_and_foreign_hosts() -> None:
    formats = [
        {"format_id": "download", "format_note": "Original", "url": "https://cf-media.sndcdn.com/a.wav", "ext": "wav"},
        {"format_id": "hls_aac_160k", "protocol": "m3u8_native", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "url": "https://cf-hls-media.sndcdn.com/a.m3u8"},
        {"format_id": "http_mp3_1_0", "protocol": "http", "vcodec": "none", "acodec": "mp3", "ext": "mp3", "url": "https://cf-media.sndcdn.com/a.mp3"},
        {"format_id": "http_mp3_1_0", "protocol": "http", "vcodec": "none", "acodec": None, "ext": "mp3", "url": "https://cf-media.sndcdn.com/b.mp3"},
        {"format_id": "hls_aac_160k_preview", "protocol": "m3u8_native", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "url": "https://cf-hls-media.sndcdn.com/p.m3u8"},
        {"format_id": "evil", "protocol": "http", "vcodec": "none", "acodec": "mp3", "ext": "mp3", "url": "https://example.com/a.mp3"},
        {"format_id": "video", "protocol": "http", "vcodec": "h264", "acodec": "aac", "ext": "mp4", "url": "https://cf-media.sndcdn.com/v.mp4"},
    ]
    streams = FormatService._normalize_streams(formats)
    assert [(s.codec, s.bitrate, s.protocol) for s in streams] == [
        ("AAC", 160, "hls"),
        ("MP3", 128, "progressive"),
    ]


def test_select_stream_prefers_progressive_on_tie() -> None:
    formats = [
        {"format_id": "hls_aac_128k", "protocol": "m3u8_native", "vcodec": "none", "acodec": "aac", "ext": "m4a", "url": "https://cf-hls-media.sndcdn.com/a.m3u8"},
        {"format_id": "http_aac_128k", "protocol": "http", "vcodec": "none", "acodec": "aac", "ext": "m4a", "url": "https://cf-media.sndcdn.com/a.m4a"},
    ]
    streams = FormatService._normalize_streams(formats)
    bundle = TrackFormats(
        track_id=1,
        title="T",
        artist="A",
        duration=1,
        permalink_url="https://soundcloud.com/a/t",
        original=None,
        original_reason="unavailable",
        original_message="none",
        streams=streams,
    )
    assert bundle.select_stream("high").protocol == "progressive"
    assert bundle.select_stream("low").protocol == "progressive"


def test_public_payload_never_leaks_source_urls() -> None:
    bundle = TrackFormats(
        track_id=7,
        title="Song",
        artist="Artist",
        duration=1000,
        permalink_url="https://soundcloud.com/artist/song",
        original=OriginalFile(
            url="https://cf-media.sndcdn.com/secret.wav?policy=1",
            ext="wav",
            codec="PCM (WAV)",
            mime="audio/wav",
            bytes=123,
            filename="song.wav",
        ),
        original_reason=None,
        original_message=None,
        streams=[
            StreamFormat(
                preset="hls_aac_160k",
                codec="AAC",
                ext="m4a",
                bitrate=160,
                protocol="hls",
                url="https://cf-hls-media.sndcdn.com/secret.m3u8",
            )
        ],
    )
    public = bundle.to_public()
    assert "sndcdn.com" not in repr(public)
    assert public["original"]["ext"] == "wav"
    assert public["streams"][0]["codec"] == "AAC"
    assert public["wavConversion"]["available"] is False


def test_original_reason_order() -> None:
    track = ApiTrack(
        id=1,
        title="T",
        artist="A",
        duration=1,
        permalink_url="https://soundcloud.com/a/t",
        downloadable=False,
        has_downloads_left=True,
        policy="ALLOW",
        streamable=True,
    )
    assert FormatService._original_reason(track, False, True, False, [])[0] == "not-enabled"

    quota = ApiTrack(**{**track.__dict__, "downloadable": True, "has_downloads_left": False})
    assert FormatService._original_reason(quota, False, True, False, [])[0] == "quota"

    no_account = ApiTrack(**{**track.__dict__, "downloadable": True})
    assert FormatService._original_reason(no_account, False, False, False, [])[0] == "auth-required"

    hinted = FormatService._original_reason(
        no_account,
        False,
        True,
        False,
        ["Original download format is only available for registered users."],
    )
    assert hinted[0] == "auth-required"

    assert FormatService._original_reason(no_account, False, True, False, [])[0] == "unavailable"
    assert FormatService._original_reason(no_account, True, True, False, []) == (None, None)


def test_pick_ext_priority() -> None:
    assert pick_ext("flac", "wav") == "flac"
    assert pick_ext(None, "aiff") == "aiff"
    assert pick_ext(None, None) is None
