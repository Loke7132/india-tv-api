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
        title: value.includes(',') ? value.slice(value.indexOf(',') + 1).trim() : ''
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

  return streams.map(stream => {
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
}
