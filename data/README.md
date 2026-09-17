# Local additions

Local records let this project cover channels that have not reached the
upstream iptv-org datasets yet. Keep metadata and playback availability
separate: a channel can be catalogued without a stream.

## Example Tamil channel

`channels.json`:

```json
[
  {
    "id": "ExampleTamil.in",
    "name": "Example Tamil",
    "alt_names": [],
    "network": null,
    "owners": [],
    "country": "IN",
    "categories": ["general"],
    "is_nsfw": false,
    "launched": null,
    "closed": null,
    "replaced_by": null,
    "website": "https://broadcaster.example/"
  }
]
```

`feeds.json`:

```json
[
  {
    "channel": "ExampleTamil.in",
    "id": "SD",
    "name": "SD",
    "alt_names": [],
    "is_main": true,
    "broadcast_area": ["c/IN"],
    "timezones": ["Asia/Kolkata"],
    "languages": ["tam"],
    "format": "576i"
  }
]
```

If the broadcaster publishes an unencrypted public HLS stream, add it to
`streams.json` with a page on the broadcaster's own site that proves where it
came from:

```json
[
  {
    "channel": "ExampleTamil.in",
    "feed": "SD",
    "title": "Example Tamil",
    "url": "https://broadcaster.example/live/master.m3u8",
    "referrer": null,
    "user_agent": null,
    "quality": "576p",
    "label": null,
    "source_page": "https://broadcaster.example/live",
    "is_official": true
  }
]
```

Do not add subscription URLs, extracted DRM manifests, cookies, credentials,
short-lived access tokens, or third-party restreams.
