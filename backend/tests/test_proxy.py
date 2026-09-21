import asyncio
import os

import httpx
from cryptography.fernet import Fernet
from fastapi import Request

os.environ.setdefault("UPSTREAM_M3U_URL", "https://iptv.example/list.m3u")
os.environ.setdefault("TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())

from app.main import (
    Settings,
    add_m3u_language,
    create_app,
    filter_m3u_group,
    filter_m3u_urls,
    merge_rewritten_playlists,
    normalize_media_type,
    rewrite_hls,
    rewrite_m3u,
)


class AsyncBytes(httpx.AsyncByteStream):
    def __init__(self, content: bytes):
        self.content = content

    async def __aiter__(self):
        yield self.content


def fake_request() -> Request:
    return Request(
        {
            "type": "http",
            "scheme": "https",
            "server": ("proxy.example", 443),
            "root_path": "",
            "path": "/",
            "query_string": b"",
            "headers": [],
        }
    )


def test_rewrite_provider_playlist() -> None:
    source = '#EXTM3U\n#EXTINF:-1,News\nchannels/news.m3u8\n'
    output = rewrite_m3u(
        source,
        "https://iptv.example/list.m3u",
        fake_request(),
        lambda url, headers: "TOKEN",
    )
    assert output == '#EXTM3U\n#EXTINF:-1,News\nhttps://proxy.example/stream?token=TOKEN\n'


def test_rewrite_hls_segments_keys_and_variants() -> None:
    source = (
        '#EXTM3U\n'
        '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"\n'
        '#EXTINF:6,\nsegment01.ts\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000\n720p/index.m3u8\n'
    )
    seen: list[str] = []

    def encrypt(url: str, headers: dict[str, str]) -> str:
        seen.append(url)
        return str(len(seen))

    output = rewrite_hls(
        source,
        "https://iptv.example/live/index.m3u8",
        fake_request(),
        encrypt,
        {},
    )
    assert 'URI="https://proxy.example/stream?token=1"' in output
    assert "https://proxy.example/stream?token=2" in output
    assert "https://proxy.example/stream?token=3" in output
    assert seen == [
        "https://iptv.example/live/keys/key.bin",
        "https://iptv.example/live/segment01.ts",
        "https://iptv.example/live/720p/index.m3u8",
    ]


def test_rewrite_captures_per_channel_headers() -> None:
    source = (
        '#EXTM3U\n'
        '#EXTINF:-1,Protected Channel\n'
        '#EXTVLCOPT:http-user-agent=Special Player\n'
        '#EXTVLCOPT:http-referrer=https://portal.example/\n'
        'https://cdn.example/live.m3u8\n'
        '#EXTINF:-1,Plain Channel\n'
        'https://cdn.example/plain.m3u8\n'
    )
    captured: list[tuple[str, dict[str, str]]] = []

    def encrypt(url: str, headers: dict[str, str]) -> str:
        captured.append((url, headers.copy()))
        return "TOKEN"

    rewrite_m3u(source, "https://provider.example/list.m3u", fake_request(), encrypt)
    assert captured == [
        (
            "https://cdn.example/live.m3u8",
            {"User-Agent": "Special Player", "Referer": "https://portal.example/"},
        ),
        ("https://cdn.example/plain.m3u8", {}),
    ]


def test_filter_group_and_merge_playlists() -> None:
    source = (
        '#EXTM3U url-tvg="guide.xml"\n'
        '#EXTINF:-1 group-title="Movies",Movie Channel\nmovie.m3u8\n'
        '#EXTINF:-1 group-title="News",News Channel\nnews.m3u8\n'
    )
    movies = filter_m3u_group(source, "movies")
    assert "Movie Channel" in movies
    assert "News Channel" not in movies
    merged = merge_rewritten_playlists([movies, "#EXTM3U\n#EXTINF:-1,Second\nsecond.m3u8\n"])
    assert merged.count("#EXTM3U") == 1
    assert "Movie Channel" in merged
    assert "Second" in merged

    verified = filter_m3u_urls(source, frozenset({"movie.m3u8"}))
    assert "Movie Channel" in verified
    assert "News Channel" not in verified

    localized = add_m3u_language(source, "tam")
    assert 'tvg-language="tam"' in localized


def test_app_can_be_created() -> None:
    settings = Settings(
        upstream_m3u_url="https://iptv.example/list.m3u",
        proxy_api_key="secret",
        token_key=Fernet.generate_key().decode(),
        upstream_headers={},
        connect_timeout=10,
        read_timeout=None,
        token_ttl_seconds=0,
    )
    assert create_app(settings).title == "Authorized IPTV Proxy"


def test_normalize_media_type_sniffs_mpeg_ts_and_fragmented_mp4() -> None:
    assert normalize_media_type("text/plain", b"\x47\x40\x11\x10") == "video/mp2t"
    assert normalize_media_type("application/octet-stream", b"\x00\x00\x00\x18ftypisom") == "video/mp4"
    assert normalize_media_type("audio/aac", b"\xff\xf1") == "audio/aac"


def test_playlist_to_hls_segment_end_to_end() -> None:
    async def scenario() -> None:
        settings = Settings(
            upstream_m3u_url="https://provider.example/list.m3u",
            proxy_api_key="proxy-secret",
            token_key=Fernet.generate_key().decode(),
            upstream_headers={"X-Provider": "account"},
            connect_timeout=10,
            read_timeout=None,
            token_ttl_seconds=0,
            public_web_origin="https://site.example",
        )
        app = create_app(settings)

        def upstream_handler(request: httpx.Request) -> httpx.Response:
            assert request.headers["X-Provider"] == "account"
            if request.url.path == "/list.m3u":
                return httpx.Response(
                    200,
                    text=(
                        '#EXTM3U\n'
                        '#EXTINF:-1,Test Channel\n'
                        '#EXTVLCOPT:http-user-agent=Provider Player\n'
                        '#EXTVLCOPT:http-referrer=https://portal.example/\n'
                        'https://provider.example/live?id=1\n'
                    ),
                )
            assert request.headers["User-Agent"] == "Provider Player"
            assert request.headers["Referer"] == "https://portal.example/"
            if request.url.path == "/live":
                if request.headers.get("Range"):
                    return httpx.Response(
                        206,
                        stream=AsyncBytes(b"#E"),
                        headers={"Content-Type": "application/vnd.apple.mpegurl"},
                    )
                # Deliberately mislabeled to exercise HLS content sniffing.
                return httpx.Response(
                    200,
                    stream=AsyncBytes(b"#EXTM3U\n#EXTINF:6,\nsegment01.ts\n"),
                    headers={"Content-Type": "application/octet-stream"},
                )
            if request.url.path == "/segment01.ts":
                return httpx.Response(
                    200,
                    stream=AsyncBytes(b"\x47MPEG-TS-DATA"),
                    headers={"Content-Type": "text/plain"},
                )
            return httpx.Response(404)

        async with app.router.lifespan_context(app):
            await app.state.client.aclose()
            app.state.client = httpx.AsyncClient(
                transport=httpx.MockTransport(upstream_handler),
                headers=settings.upstream_headers,
                follow_redirects=True,
            )
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://proxy.test",
            ) as client:
                assert (await client.get("/playlist.m3u")).status_code == 401
                assert (await client.get("/web/playlist.m3u")).status_code == 403
                web_playlist = await client.get(
                    "/web/playlist.m3u",
                    headers={"Origin": "https://site.example"},
                )
                assert web_playlist.status_code == 200
                assert web_playlist.headers["access-control-allow-origin"] == "https://site.example"
                playlist = await client.get("/playlist.m3u?api_key=proxy-secret")
                assert playlist.status_code == 200
                channel_url = next(
                    line for line in playlist.text.splitlines() if line.startswith("http://proxy.test/stream")
                )
                manifest = await client.get(
                    channel_url,
                    headers={"Range": "bytes=0-1"},
                )
                assert manifest.status_code == 200
                assert manifest.text.startswith("#EXTM3U")
                segment_url = next(
                    line for line in manifest.text.splitlines() if line.startswith("http://proxy.test/stream")
                )
                segment = await client.get(segment_url)
                assert segment.status_code == 200
                assert segment.content == b"\x47MPEG-TS-DATA"
                assert segment.headers["content-type"] == "video/mp2t"

    asyncio.run(scenario())
