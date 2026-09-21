import { useEffect, useMemo, useRef, useState } from 'react'
import { connectProxyStreams } from './proxy.mjs'

const BASE = import.meta.env.BASE_URL
const PROXY_PLAYLIST_URL = import.meta.env.VITE_PROXY_PLAYLIST_URL ||
  'https://india-tv-proxy.graygrass-63d87833.centralindia.azurecontainerapps.io/web/playlist.m3u'

const languages = [
  { code: 'all', label: 'All India' },
  { code: 'tam', label: 'Tamil' },
  { code: 'tel', label: 'Telugu' },
  { code: 'mal', label: 'Malayalam' },
  { code: 'kan', label: 'Kannada' }
]

const languageNames = Object.fromEntries(languages.map(item => [item.code, item.label]))

function Icon({ name, size = 20 }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.7-7.5a5.5 5.5 0 0 0 1.1-8.9Z"/>,
    play: <path d="m8 5 11 7-11 7V5Z"/>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
    external: <><path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></>,
    close: <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>,
    tv: <><rect x="3" y="6" width="18" height="13" rx="2"/><path d="m8 2 4 4 4-4"/></>
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function groupChannels(streams) {
  const grouped = new Map()
  for (const stream of streams) {
    if (!stream.channel) continue
    const current = grouped.get(stream.channel) ?? {
      id: stream.channel,
      name: stream.channel_name || stream.title,
      logo: stream.logo,
      languages: new Set(),
      categories: new Set(),
      streams: []
    }
    if (!current.logo && stream.logo) current.logo = stream.logo
    for (const language of stream.languages ?? []) current.languages.add(language)
    for (const category of stream.categories ?? []) current.categories.add(category)
    current.streams.push(stream)
    grouped.set(stream.channel, current)
  }
  return [...grouped.values()]
    .map(channel => ({
      ...channel,
      languages: [...channel.languages],
      categories: [...channel.categories],
      streams: channel.streams.sort((a, b) => Number(b.url.startsWith('https:')) - Number(a.url.startsWith('https:')))
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
}

function Logo({ channel, large = false }) {
  const [failed, setFailed] = useState(false)
  const initials = channel.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase()
  return (
    <div className={`channel-logo${large ? ' channel-logo--large' : ''}`}>
      {channel.logo && !failed
        ? <img src={channel.logo} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <span>{initials}</span>}
    </div>
  )
}

function Player({ channel, onClose }) {
  const videoRef = useRef(null)
  const [streamIndex, setStreamIndex] = useState(0)
  const [state, setState] = useState({ kind: 'loading', message: 'Connecting to live stream…' })
  const [copied, setCopied] = useState(false)
  const stream = channel.streams[streamIndex]

  useEffect(() => {
    setStreamIndex(0)
  }, [channel.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return undefined
    let hls
    let stopped = false
    setState({ kind: 'loading', message: `Connecting to source ${streamIndex + 1} of ${channel.streams.length}…` })

    const fail = message => {
      if (stopped) return
      setState({ kind: 'error', message })
    }

    if (window.location.protocol === 'https:' && stream.url.startsWith('http:')) {
      fail('This source uses insecure HTTP and is blocked by modern browsers. Try it in VLC instead.')
      return undefined
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = stream.url
      video.addEventListener('loadedmetadata', () => {
        setState({ kind: 'playing', message: 'Live' })
        video.play().catch(() => {})
      }, { once: true })
      video.addEventListener('error', () => fail('This source is unavailable or blocked in your region.'), { once: true })
    } else {
      import('hls.js').then(({ default: Hls }) => {
        if (stopped) return
        if (!Hls.isSupported()) {
          fail('This browser cannot play HLS video. Use the VLC playlist instead.')
          return
        }
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 30
        })
        hls.loadSource(stream.url)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setState({ kind: 'playing', message: 'Live' })
          video.play().catch(() => {})
        })
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) fail('This source is unavailable, geo-blocked, or does not allow browser playback.')
        })
      }).catch(() => fail('The video player could not be loaded. Refresh and try again.'))
    }

    return () => {
      stopped = true
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [channel.streams.length, stream, streamIndex])

  async function copyUrl() {
    await navigator.clipboard.writeText(stream.url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="player-shell" aria-label={`Playing ${channel.name}`}>
      <div className="player-heading">
        <div className="now-playing">
          <Logo channel={channel} large />
          <div>
            <span className="eyebrow">Now playing</span>
            <h2>{channel.name}</h2>
            <p>{stream.title} {stream.quality ? `· ${stream.quality}` : ''}</p>
          </div>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close player"><Icon name="close" /></button>
      </div>

      <div className="video-frame">
        <video ref={videoRef} controls playsInline />
        {state.kind !== 'playing' && (
          <div className={`player-state player-state--${state.kind}`}>
            {state.kind === 'loading' && <span className="spinner" />}
            <p>{state.message}</p>
            {state.kind === 'error' && channel.streams.length > 1 && (
              <button className="button button--light" onClick={() => setStreamIndex(index => (index + 1) % channel.streams.length)}>
                Try another source
              </button>
            )}
          </div>
        )}
      </div>

      <div className="player-actions">
        <span className={`status-dot status-dot--${state.kind}`} />
        <span>{streamIndex + 1} / {channel.streams.length} sources</span>
        {channel.streams.length > 1 && (
          <button className="text-button" onClick={() => setStreamIndex(index => (index + 1) % channel.streams.length)}>Next source</button>
        )}
        <button className="text-button push" onClick={copyUrl}><Icon name="copy" size={16} /> {copied ? 'Copied' : 'Copy stream URL'}</button>
        <a className="text-button" href={stream.url} target="_blank" rel="noreferrer"><Icon name="external" size={16} /> Open source</a>
      </div>
    </section>
  )
}

function ChannelCard({ channel, favorite, onFavorite, onPlay }) {
  const browserReady = channel.streams.some(stream => stream.url.startsWith('https:'))
  return (
    <article className="channel-card">
      <button className="card-play" onClick={() => onPlay(channel)} aria-label={`Play ${channel.name}`}>
        <Logo channel={channel} />
        <span className="play-overlay"><Icon name="play" size={24} /></span>
      </button>
      <div className="card-copy">
        <h3>{channel.name}</h3>
        <p>{channel.categories.slice(0, 2).join(' · ') || 'Live TV'}</p>
        <div className="badges">
          {channel.languages.slice(0, 2).map(code => <span key={code}>{languageNames[code] || code.toUpperCase()}</span>)}
          {!browserReady && <span className="warning-badge">VLC</span>}
        </div>
      </div>
      <button className={`favorite${favorite ? ' favorite--active' : ''}`} onClick={() => onFavorite(channel.id)} aria-label={`${favorite ? 'Remove' : 'Add'} ${channel.name} ${favorite ? 'from' : 'to'} favorites`}>
        <Icon name="heart" size={18} />
      </button>
    </article>
  )
}

export default function App() {
  const [streams, setStreams] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [proxyConnected, setProxyConnected] = useState(false)
  const [language, setLanguage] = useState('all')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [favorites, setFavorites] = useState(() => new Set(JSON.parse(localStorage.getItem('bharat-tv-favorites') || '[]')))

  useEffect(() => {
    Promise.all([
      fetch(`${BASE}api/streams.json`).then(response => {
        if (!response.ok) throw new Error('Could not load the channel API.')
        return response.json()
      }),
      fetch(`${BASE}api/stats.json`).then(response => response.json()),
      fetch(PROXY_PLAYLIST_URL)
        .then(response => {
          if (!response.ok) throw new Error('Azure stream relay is unavailable.')
          return response.text()
        })
        .catch(() => '')
    ])
      .then(([streamData, statsData, proxyPlaylist]) => {
        setStreams(proxyPlaylist ? connectProxyStreams(streamData, proxyPlaylist) : streamData)
        setStats(statsData)
        setProxyConnected(Boolean(proxyPlaylist))
      })
      .catch(cause => setError(cause.message))
      .finally(() => setLoading(false))
  }, [])

  const channels = useMemo(() => groupChannels(streams), [streams])
  const categories = useMemo(() => [...new Set(channels.flatMap(channel => channel.categories))].filter(Boolean).sort(), [channels])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return channels.filter(channel => {
      if (language !== 'all' && !channel.languages.includes(language)) return false
      if (category !== 'all' && !channel.categories.includes(category)) return false
      if (favoritesOnly && !favorites.has(channel.id)) return false
      return !needle || `${channel.name} ${channel.id} ${channel.categories.join(' ')}`.toLowerCase().includes(needle)
    })
  }, [channels, language, category, query, favoritesOnly, favorites])

  function toggleFavorite(id) {
    setFavorites(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem('bharat-tv-favorites', JSON.stringify([...next]))
      return next
    })
  }

  function play(channel) {
    setSelected(channel)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <>
      <header className="topbar">
        <a className="brand" href={BASE} aria-label="Bharat TV home">
          <span className="brand-mark"><Icon name="tv" /></span>
          <span>Bharat <strong>TV</strong></span>
        </a>
        <nav>
          <a href={`${BASE}playlists/india.m3u`}>VLC playlist</a>
          <a href="https://github.com/Loke7132/india-tv-api" target="_blank" rel="noreferrer">GitHub <Icon name="external" size={14} /></a>
        </nav>
      </header>

      <main>
        {selected ? <Player channel={selected} onClose={() => setSelected(null)} /> : (
          <section className="hero">
            <div>
              <span className="eyebrow">Free public streams · India</span>
              <h1>Your channels.<br /><em>Your languages.</em></h1>
              <p>Browse live Tamil, Telugu, Malayalam, Kannada, and nationwide television in one clean player. {proxyConnected ? 'Tamil and Telugu playback is connected through the Azure relay.' : ''}</p>
            </div>
            <div className="hero-stat">
              <strong>{channels.length || '—'}</strong>
              <span>playable channels</span>
              <small>{stats ? `Updated ${new Date(stats.generated_at).toLocaleDateString()}` : 'Loading live catalog'}</small>
            </div>
          </section>
        )}

        <section className="controls" aria-label="Channel filters">
          <div className="language-tabs">
            {languages.map(item => (
              <button key={item.code} className={language === item.code ? 'active' : ''} onClick={() => setLanguage(item.code)}>{item.label}</button>
            ))}
          </div>
          <div className="filter-row">
            <label className="search-field">
              <Icon name="search" size={18} />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search channels" aria-label="Search channels" />
            </label>
            <select value={category} onChange={event => setCategory(event.target.value)} aria-label="Filter by category">
              <option value="all">All categories</option>
              {categories.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
            </select>
            <button className={`favorites-filter${favoritesOnly ? ' active' : ''}`} onClick={() => setFavoritesOnly(value => !value)}><Icon name="heart" size={17} /> Favorites</button>
          </div>
        </section>

        <section className="channel-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Live directory</span>
              <h2>{languageNames[language]}</h2>
            </div>
            <span>{filtered.length} channels</span>
          </div>

          {loading && <div className="empty-state"><span className="spinner" /><p>Loading channels…</p></div>}
          {error && <div className="empty-state"><h3>Could not load channels</h3><p>{error}</p></div>}
          {!loading && !error && filtered.length === 0 && <div className="empty-state"><h3>No channels found</h3><p>Try another language, category, or search.</p></div>}
          <div className="channel-grid">
            {filtered.map(channel => <ChannelCard key={channel.id} channel={channel} favorite={favorites.has(channel.id)} onFavorite={toggleFavorite} onPlay={play} />)}
          </div>
        </section>
      </main>

      <footer>
        <div className="brand"><span className="brand-mark"><Icon name="tv" /></span><span>Bharat <strong>TV</strong></span></div>
        <p>This site indexes public streams. Tamil and Telugu playback may be relayed through the Azure backend; availability and regional restrictions still belong to each broadcaster.</p>
        <div>
          <a href={`${BASE}api/streams.json`}>JSON API</a>
          <a href={`${BASE}playlists/tamil.m3u`}>Tamil M3U</a>
          <a href={`${BASE}playlists/telugu.m3u`}>Telugu M3U</a>
        </div>
      </footer>
    </>
  )
}
