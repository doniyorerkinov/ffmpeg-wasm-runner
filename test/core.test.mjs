// The recipes against the real @ffmpeg/core, run in Node (no browser, no worker).
// Slow (about a minute) and needs the devDependency installed: npm run test:core
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  convertAudioArgs, framesArgs, mergeAudioArgs, readProbe, ringtoneArgs, ringtoneSeekArgs, trimArgs, trimSeekArgs
} from '../src/index.js'

const require = createRequire(import.meta.url)
let core
let ffmpeg // (...args) => { code, log }

before(async () => {
  // The UMD build runs in Node; it wants a `self` and a `location` to exist.
  // @ffmpeg/core exports only "." and "./wasm"; under require they are the UMD build.
  const script = require.resolve('@ffmpeg/core')
  globalThis.self = globalThis
  globalThis.location = { href: 'file:///' + script.replace(/\\/g, '/') }
  const create = require(script)
  const logs = []
  core = await create({ wasmBinary: readFileSync(require.resolve('@ffmpeg/core/wasm')), print() {}, printErr() {} })
  core.setLogger(({ message }) => logs.push(message))
  ffmpeg = (...args) => {
    logs.length = 0
    core.setTimeout(-1)
    core.exec(...args)
    const code = core.ret
    core.reset()
    return { code, log: logs.slice() }
  }
  // 12 s of video with a keyframe every 4 s, and a tone.
  const made = ffmpeg('-hide_banner', '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=100:min-keyint=100:scenecut=0', '-c:a', 'aac', '-shortest', 'src.mp4')
  assert.equal(made.code, 0, made.log.slice(-5).join('\n'))
})

const probe = file => readProbe(ffmpeg('-hide_banner', '-i', file).log)

test('readProbe reads what the real core prints', () => {
  const info = probe('src.mp4')
  assert.equal(info.container, 'mov,mp4,m4a,3gp,3g2,mj2')
  assert.ok(Math.abs(info.duration - 12) < 0.2, String(info.duration))
  assert.deepEqual(info.streams.map(s => [s.kind, s.codec]), [['video', 'h264'], ['audio', 'aac']])
  assert.equal(info.streams[0].size, '160x90')
  assert.equal(info.streams[1].sampleRate, 44100)
})

test('a copied cut that seeks before the input keeps picture and sound, at the asked length', () => {
  const cut = { start: 5, end: 9, accurate: false }
  const { code } = ffmpeg('-hide_banner', ...trimSeekArgs(cut), '-i', 'src.mp4', ...trimArgs(cut), 'copy.mp4')
  assert.equal(code, 0)
  const info = probe('copy.mp4')
  assert.deepEqual(info.streams.map(s => s.kind), ['video', 'audio'])
  // Copied from the keyframe at 4 s, with the container saying "start at 5":
  // the duration ffmpeg reports covers the copied keyframe interval too.
  assert.ok(info.duration >= 3.9 && info.duration <= 5.2, String(info.duration))
})

test('an accurate cut re-encodes to exactly the asked length', () => {
  const cut = { start: 5, end: 9, accurate: true }
  assert.equal(ffmpeg('-hide_banner', '-i', 'src.mp4', ...trimArgs(cut), 'exact.mp4').code, 0)
  assert.ok(Math.abs(probe('exact.mp4').duration - 4) < 0.15)
})

test('every audio format converts and reads back with the intended codec', () => {
  const expected = { mp3: 'mp3', wav: 'pcm_s16le', ogg: 'vorbis', m4a: 'aac', flac: 'flac' }
  for (const [format, codec] of Object.entries(expected)) {
    const { code } = ffmpeg('-hide_banner', '-i', 'src.mp4', ...convertAudioArgs(format), `out.${format}`)
    assert.equal(code, 0, format)
    const info = probe(`out.${format}`)
    assert.deepEqual(info.streams.map(s => [s.kind, s.codec]), [['audio', codec]], format)
  }
})

test('merging 44.1 kHz stereo and 48 kHz mono gives the sum of both lengths', () => {
  assert.equal(ffmpeg('-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3:sample_rate=48000', '-ac', '1', 'mono48.wav').code, 0)
  assert.equal(ffmpeg('-hide_banner', '-i', 'src.mp4', '-i', 'mono48.wav', ...mergeAudioArgs(2), 'joined.mp3').code, 0)
  assert.ok(Math.abs(probe('joined.mp3').duration - 15) < 0.3)
})

test('frames are capped at the limit', () => {
  const { code } = ffmpeg('-hide_banner', '-t', '6', '-i', 'src.mp4', ...framesArgs({ fps: 1, width: 1280, limit: 5 }), 'frame-%04d.png')
  assert.equal(code, 0)
  const frames = core.FS.readdir('/').filter(name => /^frame-\d{4}\.png$/.test(name))
  assert.equal(frames.length, 5)
})

test('an iPhone ringtone is AAC in an MPEG-4 file, starting where it was asked', () => {
  const args = ringtoneArgs({ phone: 'iphone', duration: 5, fadeIn: 0.5, fadeOut: 1 })
  assert.equal(ffmpeg('-hide_banner', ...ringtoneSeekArgs(6), '-i', 'src.mp4', ...args, 'tone.m4a').code, 0)
  const info = probe('tone.m4a')
  assert.match(info.container, /mp4|m4a/)
  assert.deepEqual(info.streams.map(s => [s.kind, s.codec]), [['audio', 'aac']])
  assert.ok(Math.abs(info.duration - 5) < 0.2, String(info.duration))
})
