const INDIA = 'IN'

export const LANGUAGE_NAMES = Object.freeze({
  kan: 'Kannada',
  mal: 'Malayalam',
  tam: 'Tamil',
  tel: 'Telugu'
})

function feedKey(record) {
  return `${record.channel}@${record.id ?? record.feed ?? ''}`
}

function streamKey(record) {
  return `${record.channel ?? ''}@${record.feed ?? ''}|${record.url}`
}

function logoKey(record) {
  return `${record.channel}@${record.feed ?? ''}|${record.url}`
}

function guideKey(record) {
  return `${record.channel ?? ''}@${record.feed ?? ''}|${record.site}|${record.site_id}`
}

function mergeByKey(remote, local, keyFn) {
  const records = new Map(remote.map(record => [keyFn(record), record]))
  for (const record of local) records.set(keyFn(record), record)
  return [...records.values()]
}

function targetsIndia(feed) {
  return (feed.broadcast_area ?? []).some(area =>
    area === 'c/IN' || area.startsWith('s/IN-') || area.startsWith('ct/IN')
  )
}

function text(value) {
  return value == null ? '' : String(value)
}

function sortByName(a, b) {
  return text(a.name ?? a.title).localeCompare(text(b.name ?? b.title), 'en', {
    sensitivity: 'base',
    numeric: true
  })
}

function resolveFeed(stream, feedsByKey, mainFeedByChannel) {
  if (stream.feed) return feedsByKey.get(feedKey(stream)) ?? null
  return mainFeedByChannel.get(stream.channel) ?? null
}

function preferredLogo(channel, feed, logosByChannel) {
  const candidates = logosByChannel.get(channel) ?? []
  return (
    candidates.find(logo => logo.feed === feed && logo.in_use) ??
    candidates.find(logo => logo.feed == null && logo.in_use) ??
    candidates.find(logo => logo.feed === feed) ??
    candidates[0] ??
    null
  )
}

function assertArray(name, value) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be a JSON array`)
}

export function validateLocalData(local) {
  for (const name of ['channels', 'feeds', 'streams', 'logos', 'guides']) {
    assertArray(`data/${name}.json`, local[name])
  }

  for (const stream of local.streams) {
    if (!stream.source_page || stream.is_official !== true) {
      throw new Error(
        `Local stream ${stream.url ?? '(missing URL)'} must include source_page and is_official: true`
      )
    }
    if (!/^https?:\/\//.test(stream.url ?? '')) {
      throw new Error(`Local stream must use HTTP(S): ${stream.url ?? '(missing URL)'}`)
    }
  }
}

export function compileDataset(remote, local = {}) {
  const additions = {
    channels: local.channels ?? [],
    feeds: local.feeds ?? [],
    streams: local.streams ?? [],
    logos: local.logos ?? [],
    guides: local.guides ?? [],
    languageOverrides: local.languageOverrides ?? {}
  }
  validateLocalData(additions)

  const channels = mergeByKey(remote.channels, additions.channels, item => item.id)
  const feeds = mergeByKey(remote.feeds, additions.feeds, feedKey)
  const streams = mergeByKey(remote.streams, additions.streams, streamKey)
  const logos = mergeByKey(remote.logos, additions.logos, logoKey)
  const guides = mergeByKey(remote.guides, additions.guides, guideKey)
  const blockedIds = new Set((remote.blocklist ?? []).map(item => item.channel))

  const allChannelsById = new Map(channels.map(channel => [channel.id, channel]))
  const originIds = new Set(
    channels
      .filter(channel => channel.country === INDIA && !channel.is_nsfw && !blockedIds.has(channel.id))
      .map(channel => channel.id)
  )
  const indiaFeeds = feeds.filter(feed =>
    !blockedIds.has(feed.channel) &&
    !allChannelsById.get(feed.channel)?.is_nsfw &&
    (originIds.has(feed.channel) || targetsIndia(feed))
  )
  const indiaFeedKeys = new Set(indiaFeeds.map(feedKey))
  const includedIds = new Set([...originIds, ...indiaFeeds.map(feed => feed.channel)])
  const indiaChannels = channels.filter(channel => includedIds.has(channel.id)).sort(sortByName)

  const indiaStreams = streams
    .filter(stream => {
      if (!stream.channel || !includedIds.has(stream.channel)) return false
      if (originIds.has(stream.channel)) return true
      return indiaFeedKeys.has(feedKey(stream))
    })
    .sort(sortByName)

  const indiaLogos = logos.filter(logo => {
    if (!includedIds.has(logo.channel)) return false
    return originIds.has(logo.channel) || logo.feed == null || indiaFeedKeys.has(feedKey(logo))
  })
  const indiaGuides = guides.filter(guide => {
    if (!guide.channel || !includedIds.has(guide.channel)) return false
    return originIds.has(guide.channel) || guide.feed == null || indiaFeedKeys.has(feedKey(guide))
  })

  const feedsByKey = new Map(indiaFeeds.map(feed => [feedKey(feed), feed]))
  const mainFeedByChannel = new Map()
  for (const feed of indiaFeeds) {
    if (feed.is_main || !mainFeedByChannel.has(feed.channel)) mainFeedByChannel.set(feed.channel, feed)
  }
  const logosByChannel = new Map()
  for (const logo of indiaLogos) {
    const values = logosByChannel.get(logo.channel) ?? []
    values.push(logo)
    logosByChannel.set(logo.channel, values)
  }
  const streamsByFeed = new Map()
  for (const stream of indiaStreams) {
    const feed = resolveFeed(stream, feedsByKey, mainFeedByChannel)
    const key = feed ? feedKey(feed) : `${stream.channel}@`
    const values = streamsByFeed.get(key) ?? []
    values.push(stream)
    streamsByFeed.set(key, values)
  }
  const guidesByFeed = new Map()
  for (const guide of indiaGuides) {
    const key = feedKey(guide)
    const values = guidesByFeed.get(key) ?? []
    values.push(guide)
    guidesByFeed.set(key, values)
  }

  const channelLanguages = new Map()
  for (const feed of indiaFeeds) {
    const values = channelLanguages.get(feed.channel) ?? new Set()
    for (const language of feed.languages ?? []) values.add(language)
    channelLanguages.set(feed.channel, values)
  }
  for (const [channel, languages] of Object.entries(additions.languageOverrides)) {
    const values = channelLanguages.get(channel) ?? new Set()
    for (const language of languages) values.add(language)
    channelLanguages.set(channel, values)
  }

  const streamRecords = indiaStreams.map(stream => {
    const channel = allChannelsById.get(stream.channel)
    const feed = resolveFeed(stream, feedsByKey, mainFeedByChannel)
    const languages = new Set(feed?.languages ?? [])
    for (const language of additions.languageOverrides[stream.channel] ?? []) languages.add(language)
    const logo = preferredLogo(stream.channel, stream.feed ?? feed?.id ?? null, logosByChannel)
    return {
      ...stream,
      channel_name: channel?.name ?? stream.title,
      country: channel?.country ?? null,
      languages: [...languages].sort(),
      categories: channel?.categories ?? [],
      logo: logo?.url ?? null
    }
  })

  const languageCatalogs = {}
  for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
    languageCatalogs[code] = indiaFeeds
      .filter(feed =>
        (feed.languages ?? []).includes(code) ||
        (additions.languageOverrides[feed.channel] ?? []).includes(code)
      )
      .map(feed => {
        const channel = allChannelsById.get(feed.channel)
        const logo = preferredLogo(feed.channel, feed.id, logosByChannel)
        return {
          channel,
          feed,
          language: { code, name },
          logo: logo?.url ?? null,
          streams: streamsByFeed.get(feedKey(feed)) ?? [],
          guides: [
            ...(guidesByFeed.get(feedKey(feed)) ?? []),
            ...(guidesByFeed.get(`${feed.channel}@`) ?? [])
          ]
        }
      })
      .sort((a, b) => sortByName(a.channel, b.channel))
  }

  const catalogChannels = indiaChannels.map(channel => ({
    ...channel,
    languages: [...(channelLanguages.get(channel.id) ?? [])].sort(),
    feed_count: indiaFeeds.filter(feed => feed.channel === channel.id).length,
    stream_count: indiaStreams.filter(stream => stream.channel === channel.id).length,
    playable: indiaStreams.some(stream => stream.channel === channel.id)
  }))

  return {
    channels: catalogChannels,
    feeds: indiaFeeds.sort((a, b) => sortByName(a, b)),
    streams: streamRecords,
    logos: indiaLogos,
    guides: indiaGuides,
    languageCatalogs
  }
}

function escapeAttribute(value) {
  return text(value).replaceAll('"', "'").replace(/[\r\n]/g, ' ')
}

export function createPlaylist(streams, languageCode = null) {
  const selected = languageCode
    ? streams.filter(stream => stream.languages.includes(languageCode))
    : streams
  const lines = ['#EXTM3U']

  for (const stream of selected) {
    const id = `${stream.channel}${stream.feed ? `@${stream.feed}` : ''}`
    const attrs = [
      `tvg-id="${escapeAttribute(id)}"`,
      `tvg-name="${escapeAttribute(stream.channel_name)}"`,
      `tvg-country="IN"`,
      `tvg-language="${escapeAttribute(stream.languages.join(';'))}"`,
      `group-title="${escapeAttribute((stream.categories ?? []).join(';') || 'Undefined')}"`
    ]
    if (stream.logo) attrs.splice(2, 0, `tvg-logo="${escapeAttribute(stream.logo)}"`)
    if (stream.user_agent) attrs.push(`http-user-agent="${escapeAttribute(stream.user_agent)}"`)
    if (stream.referrer) attrs.push(`http-referrer="${escapeAttribute(stream.referrer)}"`)
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${escapeAttribute(stream.title)}`)
    if (stream.user_agent) lines.push(`#EXTVLCOPT:http-user-agent=${stream.user_agent}`)
    if (stream.referrer) lines.push(`#EXTVLCOPT:http-referrer=${stream.referrer}`)
    lines.push(stream.url)
  }

  return `${lines.join('\n')}\n`
}
