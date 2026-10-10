// The recipes, as arguments. The behaviour behind them is checked against the
// real core in core.test.mjs (npm run test:core).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAYABLE,
  compressVideoArgs,
  convertAudioArgs,
  fadeArgs,
  framesArgs,
  framesSpan,
  gifArgs,
  mergeAudioArgs,
  normaliseArgs,
  ringtoneArgs,
  ringtoneSeekArgs,
  toMp4Args,
  trimArgs,
  trimSeekArgs
} from '../src/args.js'

const has = (args, ...seq) => args.join(' ').includes(seq.join(' '))

test('every H.264 recipe forces 8-bit 4:2:0', () => {
  for (const args of [compressVideoArgs(), trimArgs({ start: 1, end: 2, accurate: true }), toMp4Args(false)]) {
    assert.ok(has(args, ...PLAYABLE), args.join(' '))
  }
})

test('compressing never upscales and keeps an even height', () => {
  assert.ok(has(compressVideoArgs({ maxWidth: 854 }), '-vf', "scale='min(854,iw)':-2"))
  assert.ok(has(compressVideoArgs(), '-movflags', '+faststart'))
})

test('a copied cut seeks before the input; an accurate one after', () => {
  const copy = { start: 5, end: 9, accurate: false }
  assert.deepEqual(trimSeekArgs(copy), ['-ss', '5'])
  assert.deepEqual(trimArgs(copy), ['-t', '4', '-c', 'copy'])
  const exact = { start: 5, end: 9, accurate: true }
  assert.deepEqual(trimSeekArgs(exact), [])
  assert.deepEqual(trimArgs(exact).slice(0, 4), ['-ss', '5', '-t', '4'])
})

test('a cut is never shorter than 50 ms', () => {
  assert.ok(has(trimArgs({ start: 3, end: 3, accurate: false }), '-t', '0.05'))
})

test('audio conversion drops video and picks the codec by format', () => {
  assert.deepEqual(convertAudioArgs('wav'), ['-vn', '-c:a', 'pcm_s16le'])
  assert.deepEqual(convertAudioArgs('flac'), ['-vn', '-c:a', 'flac'])
  assert.ok(has(convertAudioArgs('ogg'), '-c:a', 'libvorbis', '-q:a', '5'))
  assert.throws(() => convertAudioArgs('wma'), /unknown audio format/)
})

test('normalising is one pass of loudnorm to -16 LUFS', () => {
  assert.ok(has(normaliseArgs(), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'))
})

test('remuxing copies; converting re-encodes', () => {
  assert.deepEqual(toMp4Args(true), ['-c', 'copy', '-movflags', '+faststart'])
  assert.ok(has(toMp4Args(false), '-c:v', 'libx264'))
})

test('a GIF builds its own palette in one pass', () => {
  const args = gifArgs({ fps: 12, width: 480, start: 2, duration: 3 })
  assert.deepEqual(args.slice(0, 4), ['-ss', '2', '-t', '3'])
  assert.match(args[5], /palettegen.*paletteuse/)
  assert.deepEqual(args.slice(-2), ['-loop', '0'])
})

test('frames are capped, and the input read is bounded too', () => {
  assert.deepEqual(framesArgs({ fps: 1, width: 1280, limit: 60 }), ['-vf', "fps=1,scale='min(1280,iw)':-2", '-frames:v', '60'])
  // 60 frames at 1 per second need 61 seconds of input, one spare period.
  assert.equal(framesSpan({ fps: 1, limit: 60 }), 61)
  assert.equal(framesSpan({ fps: 0.5, limit: 10 }), 22)
})

test('the fade-out ends on the last sound', () => {
  assert.ok(has(fadeArgs({ fadeIn: 2, fadeOut: 3, duration: 60 }), '-af', 'afade=t=in:st=0:d=2,afade=t=out:st=57.000:d=3'))
  // Longer than the file: starts at zero rather than at a negative time.
  assert.ok(fadeArgs({ fadeIn: 0, fadeOut: 9, duration: 4 })[1].includes('st=0.000'))
  assert.deepEqual(fadeArgs({ fadeIn: 0, fadeOut: 0, duration: 4 }), ['-c:a', 'libmp3lame', '-b:a', '192k'])
})

test('merging brings every input to one format first', () => {
  const graph = mergeAudioArgs(3)[1]
  assert.equal((graph.match(/aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo/g) ?? []).length, 3)
  assert.match(graph, /\[a0\]\[a1\]\[a2\]concat=n=3:v=0:a=1\[out\]$/)
})

test('an iPhone ringtone is AAC in the ipod muxer, at most 40 s, fades placed on the cut', () => {
  const iphone = ringtoneArgs({ phone: 'iphone', duration: 55, fadeIn: 0.5, fadeOut: 1.5 })
  assert.deepEqual(iphone.slice(0, 2), ['-t', '40'])
  assert.ok(has(iphone, '-f', 'ipod'))
  assert.ok(iphone.join(' ').includes('afade=t=out:st=38.500:d=1.5'))
  assert.ok(has(ringtoneArgs({ phone: 'android', duration: 30, fadeIn: 0, fadeOut: 0 }), '-c:a', 'libmp3lame'))
  assert.deepEqual(ringtoneSeekArgs(45.5), ['-ss', '45.5'])
})
