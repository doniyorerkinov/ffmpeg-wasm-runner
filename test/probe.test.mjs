// Reading `ffmpeg -i` output. The samples follow the format @ffmpeg/core 0.12.10
// prints; core.test.mjs reads output from the real core.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readProbe } from '../src/probe.js'

const PHONE_MP4 = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'probe.mp4':",
  '  Metadata:',
  '    major_brand     : isom',
  '  Duration: 00:01:02.53, start: 0.000000, bitrate: 8123 kb/s',
  '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 7990 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)',
  '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)',
  'At least one output file must be specified'
]

test('a phone video: container, duration, both streams', () => {
  const info = readProbe(PHONE_MP4)
  assert.equal(info.container, 'mov,mp4,m4a,3gp,3g2,mj2')
  assert.equal(info.duration, 62.53)
  assert.equal(info.bitrate, '8123 kb/s')
  assert.equal(info.streams.length, 2)
  const [video, audio] = info.streams
  assert.deepEqual(
    { kind: video.kind, codec: video.codec, size: video.size, fps: video.fps, bitrate: video.bitrate },
    { kind: 'video', codec: 'h264', size: '1920x1080', fps: 29.97, bitrate: '7990 kb/s' }
  )
  assert.deepEqual(
    { kind: audio.kind, codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels, bitrate: audio.bitrate },
    { kind: 'audio', codec: 'aac', sampleRate: 44100, channels: 'stereo', bitrate: '128 kb/s' }
  )
})

test('surround layouts are channels; the sample rate is not', () => {
  const info = readProbe(['  Stream #0:1: Audio: eac3, 48000 Hz, 5.1(side), fltp, 384 kb/s'])
  assert.equal(info.streams[0].channels, '5.1(side)')
  assert.equal(info.streams[0].sampleRate, 48000)
})

test('an MKV without per-stream bitrates, and subtitles', () => {
  const info = readProbe([
    "Input #0, matroska,webm, from 'probe.mkv':",
    '  Duration: 00:00:10.00, start: 0.000000, bitrate: 97 kb/s',
    '  Stream #0:0: Video: h264 (High), yuv420p(progressive), 160x90, 25 fps, 25 tbr, 1k tbn',
    '  Stream #0:1: Audio: aac (LC), 44100 Hz, mono, fltp',
    '  Stream #0:2: Subtitle: subrip (srt)'
  ])
  assert.equal(info.container, 'matroska,webm')
  assert.equal(info.streams[0].bitrate, undefined)
  assert.equal(info.streams[1].channels, 'mono')
  assert.equal(info.streams[2].kind, 'subtitle')
  assert.equal(info.streams[2].codec, 'subrip')
})

test('lines glued together by the worker are split again', () => {
  const glued = [PHONE_MP4.slice(0, 4).join('\n'), PHONE_MP4.slice(4).join('\n')]
  assert.equal(readProbe(glued).streams.length, 2)
})

test('an unreadable file gives nulls, not guesses', () => {
  const info = readProbe(['probe.bin: Invalid data found when processing input'])
  assert.deepEqual(info, { container: null, duration: null, bitrate: null, streams: [] })
})
