# Authorized IPTV Proxy

A small Python/FastAPI proxy for IPTV sources you are authorized to access. It fetches an upstream M3U playlist, replaces channel URLs with local encrypted links, rewrites nested HLS manifests, and relays segments or direct MPEG-TS streams without buffering the full stream.

## Features

- M3U and nested HLS playlist rewriting
- Multiple upstream M3U playlists merged into one feed
- Optional `group` filtering, such as `group=movies`
- Optional tested-stream snapshot filtering with `verified=true`
- HLS variant, segment, encryption-key, subtitle, and audio URI proxying
- Per-channel VLC user-agent, referrer, and origin option forwarding
- Direct/live stream relay with HTTP range support
- Encrypted upstream URLs so provider credentials are not exposed to clients
- Optional query-string or `X-API-Key` access control
- Custom provider headers through configuration
- Docker and local Python setup

## Quick start with Docker

1. Copy the example configuration:

   ```sh
   cp .env.example .env
   ```

2. Generate the token encryption key:

   ```sh
   python -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
   ```

3. Put that value, your upstream playlist URL, and a long random proxy API key in `.env`. You can generate the latter with `python -c "import secrets; print(secrets.token_urlsafe(32))"`.

4. Start the service:

   ```sh
   docker compose up -d --build
   ```

5. Add this URL to VLC, TiviMate, IPTV Smarters, or another M3U-compatible client:

   ```text
   http://YOUR_SERVER_IP:8000/playlist.m3u?api_key=YOUR_PROXY_API_KEY
   ```

The health endpoint is available at `http://YOUR_SERVER_IP:8000/health`.

## Run without Docker

Requires Python 3.11 or newer.

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
set -a
source .env
set +a
uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers
```

## Configuration

| Variable | Required | Purpose |
|---|---:|---|
| `UPSTREAM_M3U_URL` | yes | Authorized M3U/M3U Plus playlist URL |
| `UPSTREAM_M3U_URLS_JSON` | alternative | JSON array of playlists to merge; overrides `UPSTREAM_M3U_URL` |
| `UPSTREAM_M3U_LANGUAGES_JSON` | no | Language codes corresponding to merged upstream playlists |
| `TOKEN_ENCRYPTION_KEY` | yes | Fernet key used to hide upstream URLs |
| `PROXY_API_KEY` | recommended | Secret accepted as `api_key` or `X-API-Key` when fetching the playlist |
| `UPSTREAM_HEADERS_JSON` | no | JSON object of headers sent to the provider |
| `UPSTREAM_CONNECT_TIMEOUT_SECONDS` | no | Connection timeout; default `10` |
| `UPSTREAM_READ_TIMEOUT_SECONDS` | no | Read timeout; blank disables it for live streams |
| `STREAM_TOKEN_TTL_SECONDS` | no | Encrypted URL lifetime; `0` disables expiration |
| `VERIFIED_STREAM_URLS_FILE` | no | Newline-delimited upstream URLs allowed by `verified=true` |
| `INSECURE_UPSTREAM_TLS_HOSTS_JSON` | no | Hostnames whose broken TLS certificates may be accepted; avoid unless necessary |
| `PUBLIC_WEB_ORIGIN` | no | Exact browser origin allowed to fetch `/web/playlist.m3u` and relay HLS requests |

## Reverse proxy notes

For internet exposure, put this behind HTTPS (Caddy, nginx, or a private VPN). Make sure the reverse proxy preserves the original scheme and host via forwarded headers; generated stream URLs use those values. Avoid exposing port 8000 directly to the public internet.

The playlist endpoint is protected by `PROXY_API_KEY`. Each generated stream URL contains an encrypted, authenticated bearer token, so players do not need to repeat the API key on every HLS segment request. Treat downloaded playlists as secrets. Set `STREAM_TOKEN_TTL_SECONDS` if you want those links to expire.

Filter the combined playlist by an exact M3U `group-title` value with, for example, `/playlist.m3u?api_key=YOUR_KEY&group=movies`.

When a verified URL snapshot is configured, append `verified=true` to return only streams in that snapshot. This is a point-in-time availability check, not a guarantee that public streams will stay online.

This implementation supports HTTP(S) M3U, HLS, and direct byte streams. It does not implement Xtream Codes login endpoints, DASH/DRM license flows, or provider-specific device emulation.
