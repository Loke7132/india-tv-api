import test from 'node:test'
import assert from 'node:assert/strict'
import { compileDataset, createPlaylist } from '../src/core.mjs'

const channel = (id, country, name = id) => ({
  id, name, alt_names: [], network: null, owners: [], country,
  categories: ['general'], is_nsfw: false, launched: null, closed: null,
  replaced_by: null, website: null
})

const feed = (channelId, id, languages, areas = []) => ({
  channel: channelId, id, name: id, alt_names: [], is_main: id === 'Main',
  broadcast_area: areas, timezones: ['Asia/Kolkata'], languages, format: '1080p'
})

const stream = (channelId, feedId, title) => ({
  channel: channelId, feed: feedId, title,
  url: `https://example.test/${channelId}/${feedId}.m3u8`, referrer: null,
  user_agent: null, quality: '1080p', label: null
})

const emptyLocal = {
  channels: [], feeds: [], streams: [], logos: [], guides: [], languageOverrides: {}
}

test('includes Indian channels and foreign channels with India-targeted feeds', () => {
  const remote = {
    channels: [channel('Tamil.in', 'IN'), channel('Asia.sg', 'SG'), channel('Other.us', 'US')],
    feeds: [
      feed('Tamil.in', 'Main', ['tam'], ['c/IN']),
      feed('Tamil.in', 'Telugu', ['tel'], ['c/IN']),
      feed('Asia.sg', 'India', ['tam'], ['c/IN']),
      feed('Asia.sg', 'Singapore', ['eng'], ['c/SG']),
      feed('Other.us', 'Main', ['eng'], ['c/US'])
    ],
    streams: [
      stream('Tamil.in', 'Main', 'Tamil'),
      stream('Tamil.in', 'Telugu', 'Telugu'),
      stream('Asia.sg', 'India', 'Asia India'),
      stream('Asia.sg', 'Singapore', 'Asia Singapore'),
      stream('Other.us', 'Main', 'Other')
    ],
    logos: [], guides: [], blocklist: []
  }

  const result = compileDataset(remote, emptyLocal)
  assert.deepEqual(result.channels.map(item => item.id), ['Asia.sg', 'Tamil.in'])
  assert.equal(result.streams.length, 3)
  assert.equal(result.languageCatalogs.tam.length, 2)
  assert.equal(result.languageCatalogs.tel.length, 1)
  assert.match(createPlaylist(result.streams, 'tel'), /Telugu/)
  assert.doesNotMatch(createPlaylist(result.streams, 'tel'), /Asia India/)
})

test('rejects local stream additions without official provenance', () => {
  const remote = { channels: [], feeds: [], streams: [], logos: [], guides: [], blocklist: [] }
  assert.throws(() => compileDataset(remote, {
    ...emptyLocal,
    streams: [{ channel: 'Bad.in', feed: 'Main', url: 'https://example.test/live.m3u8' }]
  }), /source_page and is_official/)
})

test('removes blocked and adult channels from generated results', () => {
  const remote = {
    channels: [channel('Blocked.in', 'IN'), { ...channel('Adult.in', 'IN'), is_nsfw: true }],
    feeds: [feed('Blocked.in', 'Main', ['tam'], ['c/IN']), feed('Adult.in', 'Main', ['tel'], ['c/IN'])],
    streams: [stream('Blocked.in', 'Main', 'Blocked'), stream('Adult.in', 'Main', 'Adult')],
    logos: [], guides: [], blocklist: [{ channel: 'Blocked.in', reason: 'dmca', ref: 'test' }]
  }
  const result = compileDataset(remote, emptyLocal)
  assert.equal(result.channels.length, 0)
  assert.equal(result.streams.length, 0)
})
