import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileDataset, createPlaylist, LANGUAGE_NAMES } from './core.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, 'public')

const urls = {
  channels: 'https://iptv-org.github.io/api/channels.json',
  feeds: 'https://iptv-org.github.io/api/feeds.json',
  streams: 'https://iptv-org.github.io/api/streams.json',
  logos: 'https://iptv-org.github.io/api/logos.json',
  guides: 'https://iptv-org.github.io/api/guides.json',
  blocklist: 'https://iptv-org.github.io/api/blocklist.json'
}

async function fetchJson(url, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'india-tv-api-builder/1.0' },
        signal: AbortSignal.timeout(60_000)
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1_000))
    }
  }
  throw new Error(`Unable to download ${url}: ${lastError.message}`)
}

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'))
}

async function write(path, contents) {
  const target = join(output, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function writeJson(path, value) {
  await write(path, `${JSON.stringify(value, null, 2)}\n`)
}

const [remoteEntries, localEntries] = await Promise.all([
  Promise.all(Object.entries(urls).map(async ([name, url]) => [name, await fetchJson(url)])),
  Promise.all(
    ['channels', 'feeds', 'streams', 'logos', 'guides'].map(async name => [
      name,
      await readJson(`data/${name}.json`)
    ])
  )
])

const remote = Object.fromEntries(remoteEntries)
const local = {
  ...Object.fromEntries(localEntries),
  languageOverrides: await readJson('data/language-overrides.json')
}
const result = compileDataset(remote, local)
const generatedAt = new Date().toISOString()

const stats = {
  generated_at: generatedAt,
  source: 'https://github.com/iptv-org',
  channels: result.channels.length,
  playable_channels: result.channels.filter(channel => channel.playable).length,
  feeds: result.feeds.length,
  streams: result.streams.length,
  logos: result.logos.length,
  guides: result.guides.length,
  languages: Object.fromEntries(
    Object.entries(LANGUAGE_NAMES).map(([code, name]) => {
      const catalog = result.languageCatalogs[code]
      return [name.toLowerCase(), {
        feeds: catalog.length,
        playable_feeds: catalog.filter(item => item.streams.length > 0).length,
        streams: result.streams.filter(stream => stream.languages.includes(code)).length
      }]
    })
  )
}

await Promise.all([
  writeJson('api/channels.json', result.channels),
  writeJson('api/feeds.json', result.feeds),
  writeJson('api/streams.json', result.streams),
  writeJson('api/logos.json', result.logos),
  writeJson('api/guides.json', result.guides),
  writeJson('api/languages/tamil.json', result.languageCatalogs.tam),
  writeJson('api/languages/telugu.json', result.languageCatalogs.tel),
  writeJson('api/languages/malayalam.json', result.languageCatalogs.mal),
  writeJson('api/languages/kannada.json', result.languageCatalogs.kan),
  writeJson('api/stats.json', stats),
  write('playlists/india.m3u', createPlaylist(result.streams)),
  write('playlists/tamil.m3u', createPlaylist(result.streams, 'tam')),
  write('playlists/telugu.m3u', createPlaylist(result.streams, 'tel')),
  write('playlists/malayalam.m3u', createPlaylist(result.streams, 'mal')),
  write('playlists/kannada.m3u', createPlaylist(result.streams, 'kan')),
  write('index.html', await readFile(join(root, 'site/index.html'), 'utf8')),
  write('.nojekyll', '')
])

console.log(JSON.stringify(stats, null, 2))
