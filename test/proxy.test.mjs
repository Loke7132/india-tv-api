import assert from 'node:assert/strict'
import test from 'node:test'

import { connectProxyStreams, parseProxyPlaylist } from '../web/src/proxy.mjs'

const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="SunGemini.in@SD" group-title="General",Sun Gemini
https://proxy.example/stream?token=one
#EXTINF:-1 tvg-id="Other.in@SD" group-title="News",Other
https://proxy.example/stream?token=two
`

test('parseProxyPlaylist reads ids, titles, and URLs', () => {
  assert.deepEqual(parseProxyPlaylist(playlist), [
    { id: 'SunGemini.in@SD', title: 'Sun Gemini', url: 'https://proxy.example/stream?token=one' },
    { id: 'Other.in@SD', title: 'Other', url: 'https://proxy.example/stream?token=two' }
  ])
})

test('connectProxyStreams replaces Tamil and Telugu URLs without exposing the source', () => {
  const streams = [
    {
      channel: 'SunGemini.in',
      feed: 'SD',
      title: 'Sun Gemini',
      url: 'http://upstream.example/gemini.m3u8',
      languages: ['tel']
    },
    {
      channel: 'Other.in',
      feed: 'SD',
      title: 'Other',
      url: 'http://upstream.example/other.m3u8',
      languages: ['hin']
    }
  ]

  const connected = connectProxyStreams(streams, playlist)
  assert.equal(connected[0].url, 'https://proxy.example/stream?token=one')
  assert.equal(connected[0].source_url, streams[0].url)
  assert.equal(connected[0].proxied, true)
  assert.equal(connected[1], streams[1])
})
