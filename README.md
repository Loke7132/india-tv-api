# India TV API

An India-first, static TV metadata API with dedicated Tamil, Telugu, Malayalam,
and Kannada JSON and M3U endpoints. It joins the public datasets maintained by
[iptv-org](https://github.com/iptv-org) instead of treating the India playlist
as a single flat file.

The catalog and playlist are intentionally different:

- The **catalog** includes known Indian and India-targeted channels, even when
  no public stream is available.
- The **playlists** contain only stream URLs present in the upstream dataset or
  explicitly added to `data/streams.json` with provenance.

This means paid channels can appear in the catalog without pretending that a
free or legal public stream exists.

## Generated endpoints

After deployment, replace `<username>` and `<repository>` below:

| Endpoint | Path |
| --- | --- |
| Full catalog | `https://<username>.github.io/<repository>/api/channels.json` |
| Tamil catalog | `https://<username>.github.io/<repository>/api/languages/tamil.json` |
| Telugu catalog | `https://<username>.github.io/<repository>/api/languages/telugu.json` |
| Malayalam catalog | `https://<username>.github.io/<repository>/api/languages/malayalam.json` |
| Kannada catalog | `https://<username>.github.io/<repository>/api/languages/kannada.json` |
| All playable streams | `https://<username>.github.io/<repository>/api/streams.json` |
| India playlist | `https://<username>.github.io/<repository>/playlists/india.m3u` |
| Tamil playlist | `https://<username>.github.io/<repository>/playlists/tamil.m3u` |
| Telugu playlist | `https://<username>.github.io/<repository>/playlists/telugu.m3u` |
| Malayalam playlist | `https://<username>.github.io/<repository>/playlists/malayalam.m3u` |
| Kannada playlist | `https://<username>.github.io/<repository>/playlists/kannada.m3u` |
| Build statistics | `https://<username>.github.io/<repository>/api/stats.json` |

## Build locally

Node.js 20 or newer is the only requirement. There are no package
dependencies.

```sh
npm test
npm run build
```

The generated site is written to `public/`. Open `public/index.html`, or serve
the directory with any static file server.

## Add channels that upstream is missing

The files in `data/` are merged over the upstream datasets:

- `channels.json` — channel metadata
- `feeds.json` — regional/language variants
- `streams.json` — public stream URLs
- `logos.json` — channel artwork
- `guides.json` — EPG mappings
- `language-overrides.json` — language codes for channels whose feed metadata
  is incomplete

Use ISO 639-3 language codes: `tam` for Tamil and `tel` for Telugu. A locally
added stream must include both `source_page` and `is_official: true`; this is a
deliberate guardrail against importing private, restreamed, credentialed, or
DRM-protected links. See `data/README.md` for examples.

## Deploy on GitHub Pages

1. Create a GitHub repository and push this project.
2. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
3. Run the `Build and deploy` workflow, or push to `main`.

The scheduled workflow refreshes the generated API every day.

## Important limitation

This project indexes links; it does not host or rebroadcast video. Availability
and geographic restrictions belong to each broadcaster. Inclusion in an
upstream public dataset is not a guarantee that a stream is authorized in every
jurisdiction. Remove a disputed link and contact its host or upstream source.
