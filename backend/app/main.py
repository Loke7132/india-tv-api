from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Callable
from typing import AsyncIterator
from urllib.parse import urljoin

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse


LOG = logging.getLogger("iptv_proxy")
HLS_CONTENT_TYPES = {
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
}
PASSTHROUGH_REQUEST_HEADERS = ("range", "if-range", "if-none-match", "if-modified-since")
PASSTHROUGH_RESPONSE_HEADERS = (
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "expires",
    "last-modified",
)
URI_ATTRIBUTE_RE = re.compile(r'URI=(?P<quote>["\'])(?P<uri>.*?)(?P=quote)')
GROUP_TITLE_RE = re.compile(r'group-title=(?P<quote>["\'])(?P<group>.*?)(?P=quote)', re.IGNORECASE)
VLC_HEADER_PREFIXES = {
    "#extvlcopt:http-user-agent=": "User-Agent",
    "#extvlcopt:http-referrer=": "Referer",
    "#extvlcopt:http-origin=": "Origin",
}
ALLOWED_TOKEN_HEADERS = frozenset(VLC_HEADER_PREFIXES.values())
EncryptUrl = Callable[[str, dict[str, str]], str]


@dataclass(frozen=True)
class Settings:
    upstream_m3u_url: str
    proxy_api_key: str
    token_key: str
    upstream_headers: dict[str, str]
    connect_timeout: float
    read_timeout: float | None
    token_ttl_seconds: int
    upstream_m3u_urls: tuple[str, ...] = ()
    verified_stream_urls: frozenset[str] = frozenset()
    insecure_tls_hosts: frozenset[str] = frozenset()
    public_web_origin: str = ""
    upstream_m3u_languages: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Settings":
        raw_headers = os.getenv("UPSTREAM_HEADERS_JSON", "{}")
        try:
            headers = json.loads(raw_headers)
        except json.JSONDecodeError as exc:
            raise RuntimeError("UPSTREAM_HEADERS_JSON must be valid JSON") from exc
        if not isinstance(headers, dict) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in headers.items()
        ):
            raise RuntimeError("UPSTREAM_HEADERS_JSON must be a JSON object of string values")

        upstream_url = os.getenv("UPSTREAM_M3U_URL", "").strip()
        raw_urls = os.getenv("UPSTREAM_M3U_URLS_JSON", "").strip()
        urls: list[str] = []
        if raw_urls:
            try:
                parsed_urls = json.loads(raw_urls)
            except json.JSONDecodeError as exc:
                raise RuntimeError("UPSTREAM_M3U_URLS_JSON must be valid JSON") from exc
            if not isinstance(parsed_urls, list) or not all(
                isinstance(url, str) and _is_http_url(url) for url in parsed_urls
            ):
                raise RuntimeError("UPSTREAM_M3U_URLS_JSON must be a JSON array of HTTP(S) URLs")
            urls = parsed_urls
        elif upstream_url:
            urls = [upstream_url]

        raw_languages = os.getenv("UPSTREAM_M3U_LANGUAGES_JSON", "").strip()
        languages: list[str] = []
        if raw_languages:
            try:
                parsed_languages = json.loads(raw_languages)
            except json.JSONDecodeError as exc:
                raise RuntimeError("UPSTREAM_M3U_LANGUAGES_JSON must be valid JSON") from exc
            if not isinstance(parsed_languages, list) or not all(
                isinstance(code, str) and code for code in parsed_languages
            ):
                raise RuntimeError("UPSTREAM_M3U_LANGUAGES_JSON must be a JSON array of codes")
            if len(parsed_languages) != len(urls):
                raise RuntimeError("UPSTREAM_M3U_LANGUAGES_JSON must match the upstream URL count")
            languages = parsed_languages

        token_key = os.getenv("TOKEN_ENCRYPTION_KEY", "").strip()
        if not urls:
            raise RuntimeError("UPSTREAM_M3U_URL or UPSTREAM_M3U_URLS_JSON is required")
        if not token_key:
            raise RuntimeError("TOKEN_ENCRYPTION_KEY is required")
        try:
            Fernet(token_key.encode())
        except (ValueError, TypeError) as exc:
            raise RuntimeError("TOKEN_ENCRYPTION_KEY must be a valid Fernet key") from exc

        read_timeout_raw = os.getenv("UPSTREAM_READ_TIMEOUT_SECONDS", "").strip()
        verified_urls_file = os.getenv("VERIFIED_STREAM_URLS_FILE", "").strip()
        verified_urls: frozenset[str] = frozenset()
        if verified_urls_file:
            try:
                values = {
                    line.strip()
                    for line in Path(verified_urls_file).read_text().splitlines()
                    if line.strip() and not line.lstrip().startswith("#")
                }
            except OSError as exc:
                raise RuntimeError(f"Could not read VERIFIED_STREAM_URLS_FILE: {verified_urls_file}") from exc
            if not all(_is_http_url(url) for url in values):
                raise RuntimeError("VERIFIED_STREAM_URLS_FILE contains a non-HTTP(S) URL")
            verified_urls = frozenset(values)

        raw_insecure_hosts = os.getenv("INSECURE_UPSTREAM_TLS_HOSTS_JSON", "[]")
        try:
            insecure_hosts_value = json.loads(raw_insecure_hosts)
        except json.JSONDecodeError as exc:
            raise RuntimeError("INSECURE_UPSTREAM_TLS_HOSTS_JSON must be valid JSON") from exc
        if not isinstance(insecure_hosts_value, list) or not all(
            isinstance(host, str) and host and "/" not in host for host in insecure_hosts_value
        ):
            raise RuntimeError("INSECURE_UPSTREAM_TLS_HOSTS_JSON must be a JSON array of hostnames")

        return cls(
            upstream_m3u_url=urls[0],
            proxy_api_key=os.getenv("PROXY_API_KEY", "").strip(),
            token_key=token_key,
            upstream_headers=headers,
            connect_timeout=float(os.getenv("UPSTREAM_CONNECT_TIMEOUT_SECONDS", "10")),
            read_timeout=float(read_timeout_raw) if read_timeout_raw else None,
            token_ttl_seconds=int(os.getenv("STREAM_TOKEN_TTL_SECONDS", "0")),
            upstream_m3u_urls=tuple(urls),
            verified_stream_urls=verified_urls,
            insecure_tls_hosts=frozenset(host.casefold() for host in insecure_hosts_value),
            public_web_origin=os.getenv("PUBLIC_WEB_ORIGIN", "").strip().rstrip("/"),
            upstream_m3u_languages=tuple(languages),
        )


def _is_http_url(url: str) -> bool:
    return url.startswith("http://") or url.startswith("https://")


def _public_url(request: Request, route: str, token: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}{route}?token={token}"


def rewrite_m3u(
    text: str,
    source_url: str,
    request: Request,
    encrypt: EncryptUrl,
) -> str:
    output: list[str] = []
    stream_headers: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        for prefix, header_name in VLC_HEADER_PREFIXES.items():
            if lowered.startswith(prefix):
                stream_headers[header_name] = stripped[len(prefix) :]
                break
        if stripped and not stripped.startswith("#"):
            resolved = urljoin(source_url, stripped)
            if _is_http_url(resolved):
                line = _public_url(request, "/stream", encrypt(resolved, stream_headers))
            stream_headers = {}
        output.append(line)
    return "\n".join(output) + "\n"


def filter_m3u_group(text: str, wanted_group: str) -> str:
    """Keep complete M3U records whose group-title contains the requested group."""
    wanted = wanted_group.strip().casefold()
    if not wanted:
        return text

    header = "#EXTM3U"
    records: list[list[str]] = []
    current: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("#EXTM3U"):
            header = line
            continue
        if stripped.upper().startswith("#EXTINF"):
            if current:
                records.append(current)
            current = [line]
        elif current:
            current.append(line)
    if current:
        records.append(current)

    output = [header]
    for record in records:
        match = GROUP_TITLE_RE.search(record[0])
        groups = match.group("group").casefold().split(";") if match else []
        if any(wanted == group.strip() for group in groups):
            output.extend(record)
    return "\n".join(output) + "\n"


def filter_m3u_urls(text: str, allowed_urls: frozenset[str]) -> str:
    """Keep complete M3U records whose final stream URL passed validation."""
    header = "#EXTM3U"
    records: list[list[str]] = []
    current: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("#EXTM3U"):
            header = line
            continue
        if stripped.upper().startswith("#EXTINF"):
            if current:
                records.append(current)
            current = [line]
        elif current:
            current.append(line)
    if current:
        records.append(current)

    output = [header]
    for record in records:
        stream_url = next(
            (line.strip() for line in reversed(record) if line.strip() and not line.lstrip().startswith("#")),
            None,
        )
        if stream_url in allowed_urls:
            output.extend(record)
    return "\n".join(output) + "\n"


def add_m3u_language(text: str, language_code: str) -> str:
    output: list[str] = []
    for line in text.splitlines():
        if line.lstrip().upper().startswith("#EXTINF") and "tvg-language=" not in line.lower():
            metadata, separator, title = line.partition(",")
            if separator:
                line = f'{metadata} tvg-language="{language_code}",{title}'
        output.append(line)
    return "\n".join(output) + "\n"


def merge_rewritten_playlists(playlists: list[str]) -> str:
    output = ["#EXTM3U"]
    for playlist in playlists:
        output.extend(
            line
            for line in playlist.splitlines()
            if not line.strip().upper().startswith("#EXTM3U")
        )
    return "\n".join(output) + "\n"


def rewrite_hls(
    text: str,
    source_url: str,
    request: Request,
    encrypt: EncryptUrl,
    stream_headers: dict[str, str],
) -> str:
    def rewrite_attribute(match: re.Match[str]) -> str:
        resolved = urljoin(source_url, match.group("uri"))
        if not _is_http_url(resolved):
            return match.group(0)
        proxied = _public_url(request, "/stream", encrypt(resolved, stream_headers))
        quote = match.group("quote")
        return f"URI={quote}{proxied}{quote}"

    output: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            line = URI_ATTRIBUTE_RE.sub(rewrite_attribute, line)
        elif stripped:
            resolved = urljoin(source_url, stripped)
            if _is_http_url(resolved):
                line = _public_url(request, "/stream", encrypt(resolved, stream_headers))
        output.append(line)
    return "\n".join(output) + "\n"


def normalize_media_type(content_type: str, first_chunk: bytes) -> str:
    """Correct common upstream MIME mistakes that break native HLS players."""
    if first_chunk.startswith(b"\x47"):
        return "video/mp2t"
    if len(first_chunk) >= 12 and first_chunk[4:8] in {b"ftyp", b"moof", b"styp"}:
        return "video/mp4"
    return content_type


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or Settings.from_env()
    cipher = Fernet(config.token_key.encode())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        timeout = httpx.Timeout(
            connect=config.connect_timeout,
            read=config.read_timeout,
            write=30.0,
            pool=10.0,
        )
        app.state.client = httpx.AsyncClient(
            headers=config.upstream_headers,
            timeout=timeout,
            follow_redirects=True,
        )
        app.state.insecure_client = httpx.AsyncClient(
            headers=config.upstream_headers,
            timeout=timeout,
            follow_redirects=True,
            verify=False,
        )
        try:
            yield
        finally:
            await app.state.client.aclose()
            await app.state.insecure_client.aclose()

    app = FastAPI(
        title="Authorized IPTV Proxy",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    if config.public_web_origin:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[config.public_web_origin],
            allow_methods=["GET"],
            allow_headers=["Range", "If-Range", "If-None-Match", "If-Modified-Since"],
            expose_headers=["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type"],
        )

    def encrypt_url(url: str, headers: dict[str, str]) -> str:
        payload = json.dumps({"url": url, "headers": headers}, separators=(",", ":"))
        return cipher.encrypt(payload.encode()).decode()

    def decrypt_url(token: str) -> tuple[str, dict[str, str]]:
        try:
            ttl = config.token_ttl_seconds or None
            payload = json.loads(cipher.decrypt(token.encode(), ttl=ttl).decode())
            url = payload["url"]
            headers = payload.get("headers", {})
        except (InvalidToken, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid or expired token")
        if not isinstance(url, str) or not _is_http_url(url):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported upstream URL")
        if not isinstance(headers, dict) or not all(
            name in ALLOWED_TOKEN_HEADERS and isinstance(value, str)
            for name, value in headers.items()
        ):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid stream headers")
        return url, headers

    def client_for(request: Request, url: str) -> httpx.AsyncClient:
        hostname = (httpx.URL(url).host or "").casefold()
        if hostname in config.insecure_tls_hosts:
            return request.app.state.insecure_client
        return request.app.state.client

    async def require_api_key(
        api_key: str | None = Query(default=None),
        x_api_key: str | None = Header(default=None),
    ) -> None:
        supplied = api_key or x_api_key or ""
        if config.proxy_api_key and not secrets.compare_digest(config.proxy_api_key, supplied):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/playlist.m3u", response_class=PlainTextResponse)
    async def playlist(
        request: Request,
        group: str | None = Query(default=None),
        verified: bool = Query(default=False),
        _: None = Depends(require_api_key),
    ) -> PlainTextResponse:
        urls = config.upstream_m3u_urls or (config.upstream_m3u_url,)

        async def fetch(url: str) -> httpx.Response | None:
            try:
                response = await request.app.state.client.get(url)
                response.raise_for_status()
                return response
            except httpx.HTTPError as exc:
                LOG.warning("Could not fetch upstream playlist %s: %s", url, exc)
                return None

        responses = await asyncio.gather(*(fetch(url) for url in urls))
        successful = [response for response in responses if response is not None]
        if not successful:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Upstream playlists failed")

        rewritten_parts = []
        for index, response in enumerate(responses):
            if response is None:
                continue
            source_text = filter_m3u_group(response.text, group) if group else response.text
            if verified:
                if not config.verified_stream_urls:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="No verified stream snapshot is configured",
                    )
                source_text = filter_m3u_urls(source_text, config.verified_stream_urls)
            if config.upstream_m3u_languages:
                source_text = add_m3u_language(
                    source_text,
                    config.upstream_m3u_languages[index],
                )
            rewritten_parts.append(
                rewrite_m3u(source_text, str(response.url), request, encrypt_url)
            )
        rewritten = merge_rewritten_playlists(rewritten_parts)
        return PlainTextResponse(
            rewritten,
            media_type="audio/x-mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/web/playlist.m3u", response_class=PlainTextResponse)
    async def web_playlist(
        request: Request,
        group: str | None = Query(default=None),
    ) -> PlainTextResponse:
        origin = request.headers.get("origin", "").rstrip("/")
        if not config.public_web_origin or not secrets.compare_digest(
            config.public_web_origin,
            origin,
        ):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Origin not allowed")
        return await playlist(request=request, group=group, verified=False, _=None)

    @app.get("/stream")
    async def stream(
        request: Request,
        token: str = Query(...),
    ):
        upstream_url, stream_headers = decrypt_url(token)
        request_headers = {
            name: request.headers[name]
            for name in PASSTHROUGH_REQUEST_HEADERS
            if name in request.headers
        }
        request_headers.update(stream_headers)
        upstream_client = client_for(request, upstream_url)

        async def open_upstream(headers: dict[str, str]):
            upstream_request = upstream_client.build_request(
                "GET", upstream_url, headers=headers
            )
            try:
                response = await upstream_client.send(upstream_request, stream=True)
            except httpx.HTTPError as exc:
                LOG.warning("Could not open upstream stream: %s", exc)
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Upstream stream failed",
                )
            response_iterator = response.aiter_raw()
            try:
                chunk = await anext(response_iterator)
            except StopAsyncIteration:
                chunk = b""
            except httpx.HTTPError as exc:
                await response.aclose()
                LOG.warning("Could not read upstream stream: %s", exc)
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Upstream stream failed",
                )
            response_content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
            return response, response_iterator, chunk, response_content_type

        upstream, iterator, first_chunk, content_type = await open_upstream(request_headers)

        looks_like_hls = (
            content_type in HLS_CONTENT_TYPES
            or upstream.url.path.lower().endswith(".m3u8")
            or first_chunk.lstrip().startswith(b"#EXTM3U")
        )
        if looks_like_hls and upstream.status_code == 206 and "range" in request_headers:
            # Native HLS players often probe manifests with a Range request. Some
            # providers honor it and return an unusable partial M3U8, so retry the
            # small text manifest without the media Range headers.
            await upstream.aclose()
            request_headers.pop("range", None)
            request_headers.pop("if-range", None)
            upstream, iterator, first_chunk, content_type = await open_upstream(request_headers)
            looks_like_hls = (
                content_type in HLS_CONTENT_TYPES
                or upstream.url.path.lower().endswith(".m3u8")
                or first_chunk.lstrip().startswith(b"#EXTM3U")
            )
        if looks_like_hls and upstream.status_code < 400:
            try:
                remaining = b"".join([chunk async for chunk in iterator])
                body = first_chunk + remaining
                text = body.decode(upstream.encoding or "utf-8")
            except (UnicodeDecodeError, httpx.HTTPError):
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid HLS manifest")
            finally:
                await upstream.aclose()
            rewritten = rewrite_hls(
                text,
                str(upstream.url),
                request,
                encrypt_url,
                stream_headers,
            )
            return PlainTextResponse(
                rewritten,
                status_code=upstream.status_code,
                media_type="application/vnd.apple.mpegurl",
                headers={"Cache-Control": upstream.headers.get("cache-control", "no-cache")},
            )

        response_headers = {
            name: upstream.headers[name]
            for name in PASSTHROUGH_RESPONSE_HEADERS
            if name in upstream.headers
        }
        media_type = normalize_media_type(upstream.headers.get("content-type", ""), first_chunk)
        response_headers["content-type"] = media_type

        async def relay() -> AsyncIterator[bytes]:
            try:
                if first_chunk:
                    yield first_chunk
                async for chunk in iterator:
                    yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(
            relay(),
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=media_type,
        )

    return app


app = create_app()
