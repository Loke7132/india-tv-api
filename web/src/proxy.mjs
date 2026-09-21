function attribute(line, name) {
  const match = line.match(new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`, 'i'))
  return match?.[1] ?? match?.[2] ?? ''
}

export function parseProxyPlaylist(text) {
  const entries = []
  let metadata = null

  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (value.startsWith('#EXTINF')) {
      metadata = {
        id: attribute(value, 'tvg-id'),
        title: value.includes(',') ? value.slice(value.indexOf(',') + 1).trim() : '',
        logo: attribute(value, 'tvg-logo'),
        languages: attribute(value, 'tvg-language').split(';').filter(Boolean),
        categories: attribute(value, 'group-title').split(';').filter(Boolean)
      }
    } else if (metadata && value && !value.startsWith('#')) {
      entries.push({ ...metadata, url: value })
      metadata = null
    }
  }

  return entries
}

export function connectProxyStreams(streams, playlistText) {
  const entries = parseProxyPlaylist(playlistText).map(entry => ({ ...entry, used: false }))
  const byId = new Map()
  const byExactKey = new Map()

  for (const entry of entries) {
    const exactKey = `${entry.id}\n${entry.title}`
    const exactValues = byExactKey.get(exactKey) ?? []
    exactValues.push(entry)
    byExactKey.set(exactKey, exactValues)

    const idValues = byId.get(entry.id) ?? []
    idValues.push(entry)
    byId.set(entry.id, idValues)
  }

  const connected = streams.map(stream => {
    if (!(stream.languages ?? []).some(code => code === 'tam' || code === 'tel')) return stream
    const id = `${stream.channel}${stream.feed ? `@${stream.feed}` : ''}`
    const exactKey = `${id}\n${stream.title ?? ''}`
    const entry = (byExactKey.get(exactKey) ?? []).find(item => !item.used) ??
      (byId.get(id) ?? []).find(item => !item.used)
    if (!entry) return stream
    entry.used = true
    return {
      ...stream,
      source_url: stream.url,
      url: entry.url,
      proxied: true
    }
  })

  for (const entry of entries) {
    if (entry.used || !entry.languages.some(code => code === 'tam' || code === 'tel')) continue
    const separator = entry.id.lastIndexOf('@')
    const channel = separator > 0 ? entry.id.slice(0, separator) : entry.id
    const feed = separator > 0 ? entry.id.slice(separator + 1) : null
    const quality = entry.title.match(/\((\d+[pi]|\d+K)\)/i)?.[1] ?? null
    const channelName = entry.title
      .replace(/\s+\([^)]*\)(?:\s+\[[^\]]*\])?$/, '')
      .trim()
    connected.push({
      channel,
      feed,
      title: entry.title,
      channel_name: channelName,
      url: entry.url,
      source_url: null,
      quality,
      languages: entry.languages,
      categories: entry.categories,
      logo: entry.logo || null,
      proxied: true
    })
  }

  return connected
}
