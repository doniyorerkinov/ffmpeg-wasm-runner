// The runner's bookkeeping, against a fake ffmpeg: names, cleanup, errors, crashes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunner } from '../src/index.js'

function fakeFFmpeg({ exitCode = 0, crash = false, outputs = {} } = {}) {
  const fs = new Map()
  const listeners = { log: new Set(), progress: new Set() }
  const fake = {
    loaded: true,
    terminated: false,
    commands: [],
    written: [],
    fs,
    on: (event, fn) => listeners[event]?.add(fn),
    off: (event, fn) => listeners[event]?.delete(fn),
    async writeFile(name, data) {
      fake.written.push({ name, data })
      fs.set(name, data)
    },
    async exec(args) {
      fake.commands.push(args)
      for (const fn of listeners.log) fn({ message: `ffmpeg ${args.join(' ')}` })
      for (const fn of listeners.progress) fn({ progress: 2, time: 5_000_000 })
      if (crash) throw new Error('RuntimeError: memory access out of bounds')
      for (const [name, data] of Object.entries(outputs)) fs.set(name, data)
      return exitCode
    },
    async readFile(name) {
      if (!fs.has(name)) throw new Error(`no such file: ${name}`)
      return fs.get(name)
    },
    async deleteFile(name) {
      if (!fs.delete(name)) throw new Error(`no such file: ${name}`)
    },
    async listDir() {
      return [...fs.keys()].map(name => ({ name, isDir: false }))
    },
    terminate() {
      fake.terminated = true
      fake.loaded = false
    }
  }
  return fake
}

const bytes = (...values) => new Uint8Array(values)

test("the visitor's file names never reach ffmpeg", async () => {
  const fake = fakeFFmpeg({ outputs: { 'output.mp3': bytes(1, 2, 3) } })
  const runner = createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => fake })
  const out = await runner.run({
    input: { name: '-My song: live.MP3', data: bytes(9) },
    output: '-My song: live.mp3',
    args: ['-c:a', 'libmp3lame']
  })
  assert.deepEqual([...out], [1, 2, 3])
  // "-..." would be read as an option, "x:" as a protocol.
  assert.deepEqual(fake.commands[0], ['-i', 'input-0.mp3', '-c:a', 'libmp3lame', 'output.mp3'])
})

test('inputs are numbered, so two clips never overwrite each other', async () => {
  const fake = fakeFFmpeg({ outputs: { 'output.mp4': bytes(1) } })
  const runner = createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => fake })
  await runner.run({ inputs: [{ name: 'a.mp4', data: bytes(1) }, { name: 'b.mov', data: bytes(2) }], output: 'joined.mp4' })
  assert.deepEqual(fake.commands[0], ['-i', 'input-0.mp4', '-i', 'input-1.mov', 'output.mp4'])
})

test('the bytes handed to ffmpeg are a copy, so the same file can run twice', async () => {
  const fake = fakeFFmpeg({ outputs: { 'output.wav': bytes(1) } })
  const runner = createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => fake })
  const data = bytes(5, 6, 7)
  await runner.run({ input: { name: 'x.wav', data }, output: 'x.wav' })
  assert.notEqual(fake.written[0].data.buffer, data.buffer)
  assert.deepEqual([...fake.written[0].data], [5, 6, 7])
})

test('the in-memory disk is emptied after every job, success or not', async () => {
  const ok = fakeFFmpeg({ outputs: { 'output.mp3': bytes(1) } })
  await createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => ok }).run({ input: { name: 'a.wav', data: bytes(1) }, output: 'a.mp3' })
  assert.equal(ok.fs.size, 0)

  const failed = fakeFFmpeg({ exitCode: 1 })
  await assert.rejects(
    createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => failed }).run({ input: { name: 'a.wav', data: bytes(1) }, output: 'a.mp3' }),
    error => error.code === 'FFMPEG_FAILED' && error.log.length > 0 && error.command.includes('output.mp3')
  )
  assert.equal(failed.fs.size, 0)
})

test('an empty output is an error, not a download', async () => {
  const fake = fakeFFmpeg({ outputs: { 'output.mp3': new Uint8Array(0) } })
  const runner = createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => fake })
  await assert.rejects(runner.run({ input: { name: 'a.wav', data: bytes(1) }, output: 'a.mp3' }), { code: 'FFMPEG_EMPTY' })
})

test('a crashed core is thrown away and the next job boots a new one', async () => {
  const crashed = fakeFFmpeg({ crash: true })
  const fresh = fakeFFmpeg({ outputs: { 'output.mp3': bytes(1) } })
  const queue = [crashed, fresh]
  const runner = createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => queue.shift() })
  await assert.rejects(runner.run({ input: { name: 'a.wav', data: bytes(1) }, output: 'a.mp3' }), { code: 'FFMPEG_CRASHED' })
  assert.equal(crashed.terminated, true)
  const out = await runner.run({ input: { name: 'a.wav', data: bytes(1) }, output: 'a.mp3' })
  assert.deepEqual([...out], [1])
})

test('progress is measured against the expected length and clamped', async () => {
  const fake = fakeFFmpeg({ outputs: { 'output.mp4': bytes(1) } })
  const runner = createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => fake })
  const seen = []
  await runner.run({ input: { name: 'a.mp4', data: bytes(1) }, output: 'a.mp4', span: 10, onProgress: f => seen.push(f) })
  // time 5 s of a 10 s span is 0.5, whatever ffmpeg's own (wrong, 2) fraction says.
  assert.deepEqual(seen, [0.5])
})

test('runMany returns every file the pattern produced, in order', async () => {
  const fake = fakeFFmpeg({ outputs: { 'frame-0002.png': bytes(2), 'frame-0001.png': bytes(1), 'other.txt': bytes(9) } })
  const runner = createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => fake })
  const frames = await runner.runMany({ input: { name: 'v.mp4', data: bytes(1) }, output: 'frame-%04d.png' })
  assert.deepEqual(frames.map(f => f.name), ['frame-0001.png', 'frame-0002.png'])
  assert.equal(fake.commands[0].at(-1), 'frame-%04d.png')
  await assert.rejects(runner.runMany({ input: { name: 'v.mp4', data: bytes(1) }, output: 'frame.png' }), { code: 'FFMPEG_BAD_PATTERN' })
})

test('probe returns the log even though ffmpeg -i exits non-zero', async () => {
  const fake = fakeFFmpeg({ exitCode: 1 })
  const runner = createRunner({ coreURL: '', wasmURL: '', createFFmpeg: async () => fake })
  const lines = await runner.probe({ name: 'clip.MOV', data: bytes(1) })
  assert.ok(lines.some(line => line.includes('-i probe.mov')))
  assert.equal(fake.fs.size, 0)
})
