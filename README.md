# ffmpeg-wasm-runner

Single-threaded [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) for a real website: no COOP/COEP headers, a self-hosted core that fits under Cloudflare's 25 MiB file limit, recovery from crashed workers, and the ffmpeg arguments that survived production.

This is the code behind the audio and video tools on **[toolkave.com](https://toolkave.com)**, where every file is processed in the visitor's browser and never uploaded:

- [Trim video](https://toolkave.com/video/trim-video), [Convert video to MP4](https://toolkave.com/video/convert-video-to-mp4), [Compress video](https://toolkave.com/video/compress-video)
- [Convert audio](https://toolkave.com/audio/convert-audio), [Normalise volume](https://toolkave.com/audio/normalize-audio-volume), [Ringtone maker](https://toolkave.com/audio/ringtone-maker)
- [Media info](https://toolkave.com/video/media-info), [Video bitrate checker](https://toolkave.com/video/video-bitrate-checker)

It is small on purpose: one runner, one parser, a dozen argument recipes, no framework.

## What it fixes

Every item here broke something on the live site before the code looked like this.

| Problem | What happens | What this does |
|---|---|---|
| The multithreaded core needs `SharedArrayBuffer` | That needs COOP/COEP headers, which break ads and other third-party embeds on the page | Uses the single-threaded core. No special headers. |
| The core is 30.7 MiB | Cloudflare (Workers static assets, Pages) refuses files over 25 MiB | Serves it gzipped (9.8 MiB) and unpacks it with `DecompressionStream`. Sniffs the magic bytes first, because some servers send `Content-Encoding: gzip` and the browser has already unpacked it. |
| The UMD core | `@ffmpeg/ffmpeg` always starts a module worker, which has no `importScripts`; it imports the core and reads `.default`, which UMD lacks. "failed to import ffmpeg-core.js", on every browser | `pack-core` copies the ESM build. |
| `writeFile` transfers the buffer | The second run on the same file fails: "An ArrayBuffer is detached and could not be cloned" | Hands ffmpeg a copy. |
| A wasm trap ("memory access out of bounds") | The core is corrupt; every later job in the tab fails for no visible reason | Terminates the worker; the next job boots a fresh one. |
| The in-memory disk lives as long as the page | Five conversions hold five inputs and outputs in memory; phones kill the tab | Deletes inputs and outputs after every job, success or failure. |
| File names from users | `-song.mp3` is read as an option, `clip:2.mp4` as a protocol called `clip`, `x%d.png` as a frame pattern, and `input.mp3` converted to MP3 collides with its own input | ffmpeg only ever sees `input-0.mp3` and `output.mp3`; you name the download. |
| Progress | ffmpeg reports past 100% on some inputs, and "the first minute of a two-hour file" never reaches 100% | Clamps, and measures against `span` (expected output seconds) when you give one. |

## Install

```sh
npm i ffmpeg-wasm-runner @ffmpeg/ffmpeg @ffmpeg/util @ffmpeg/core
npx ffmpeg-wasm-pack-core public/ffmpeg     # writes ffmpeg-core.js and ffmpeg-core.wasm.gz
```

Run `pack-core` at build time rather than committing the 31 MB file: it stays in step with the installed `@ffmpeg/core`.

## Use

```js
import { createRunner, convertAudioArgs, trimArgs, trimSeekArgs } from 'ffmpeg-wasm-runner'

const ffmpeg = createRunner({
  coreURL: '/ffmpeg/ffmpeg-core.js',
  wasmURL: '/ffmpeg/ffmpeg-core.wasm.gz'
})

// Nothing is downloaded until the first job.
const file = input.files[0]
const data = new Uint8Array(await file.arrayBuffer())

const mp3 = await ffmpeg.run({
  input: { name: file.name, data },
  output: 'song.mp3',                 // only ".mp3" reaches ffmpeg
  args: convertAudioArgs('mp3'),
  onProgress: fraction => (bar.value = fraction)
})

// A cut that copies the streams: the seek goes BEFORE the input.
const clip = await ffmpeg.run({
  input: { name: file.name, data },
  beforeInput: trimSeekArgs({ start: 5, accurate: false }),
  args: trimArgs({ start: 5, end: 9, accurate: false }),
  output: 'clip.mp4'
})
```

`run` returns a `Uint8Array`. `runMany` takes an output pattern such as `frame-%04d.png` and returns every file it produced. `probe` returns the lines of `ffmpeg -i`, which `readProbe` turns into streams:

```js
import { readProbe } from 'ffmpeg-wasm-runner'

const info = readProbe(await ffmpeg.probe({ name: file.name, data }))
// { container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 62.53, bitrate: '8123 kb/s',
//   streams: [{ kind: 'video', codec: 'h264', size: '1920x1080', fps: 29.97, ... }, ...] }
```

`ffmpeg.preload()` starts the download early, for example while the user is still choosing options.

## Recipes

Pure functions that return arguments. Each comment in [`src/args.js`](src/args.js) says what went wrong before it looked like this.

| Function | What it is for | The part that matters |
|---|---|---|
| `compressVideoArgs({ crf, maxWidth, audioBitrate })` | Smaller video for sending | `scale='min(W,iw)':-2` never upscales and keeps sizes even; `+faststart` lets chat previews play early |
| `trimArgs` + `trimSeekArgs` | Cut a piece | With `-c copy`, `-ss` after `-i` starts the picture at the *next* keyframe, seconds after the sound. Before `-i`, picture and sound start together |
| `convertAudioArgs(format)` | MP3, WAV, OGG, M4A, FLAC | `-vn` drops video and cover art |
| `normaliseArgs()` | Even loudness at -16 LUFS | One-pass loudnorm adjusts as it plays; it does not measure the whole file first |
| `toMp4Args(remux)` | To MP4 | Remux (copy) when the codecs already fit; decide from a probe |
| `gifArgs({ fps, width, start, duration })` | GIF | `palettegen` + `paletteuse` in one pass instead of the 216-colour default |
| `framesArgs` + `framesSpan` | Still frames | PNG (the wasm mjpeg encoder crashed on 10-bit HEVC); bound the input with `-t` or a 60-frame request can decode a two-hour file |
| `fadeArgs({ fadeIn, fadeOut, duration })` | Fades | The fade-out needs the duration |
| `mergeAudioArgs(count)` | Join audio | `aformat` every input first, or 44.1 kHz and 48 kHz files play at the wrong speed |
| `ringtoneArgs` + `ringtoneSeekArgs` | iPhone `.m4r` / Android `.mp3` | `-f ipod`; seek before the input, or the fades land on the song's timeline and a cut at 0:45 is silence |

Every H.264 recipe adds `PLAYABLE` (`-pix_fmt yuv420p`): without it a 10-bit source becomes High 10 and an RGBA overlay High 4:4:4, which play in nothing but ffmpeg.

## Errors

Errors carry a stable `code`, plus `command` and the last `log` lines ffmpeg printed:

| `code` | Meaning |
|---|---|
| `FFMPEG_CORE_UNAVAILABLE` | The core could not be fetched or unpacked (or the server sent an HTML page in its place) |
| `FFMPEG_FAILED` | ffmpeg ran and exited non-zero: usually an input it cannot read or arguments that do not fit the file |
| `FFMPEG_EMPTY` | ffmpeg finished but wrote nothing |
| `FFMPEG_CRASHED` | The worker died (a wasm trap). It has been replaced; retrying is reasonable |
| `FFMPEG_BAD_PATTERN` | `runMany` was given an output without a `%` pattern |

## Notes from production

- **Durations from the browser are free, except for MediaRecorder files.** An `<audio>` element reports `duration` from the header without decoding, which is how the fade recipe learns where the end is. Chrome reports `Infinity` for files made by `MediaRecorder`; setting `currentTime` far past the end once makes it measure the file.
- **Memory.** The file is held twice, once in JavaScript and once in ffmpeg's disk, plus the output. toolkave caps inputs at 500 MB on desktop; phones give out well before that.
- **The core is the largest thing your page will ever load.** Load it on the first job, never on page load, and serve it with a long immutable cache.

## Tests

```sh
npm test            # runner, recipes and parser, without the core (fast)
npm run test:core   # the recipes against the real @ffmpeg/core 0.12.10, in Node
```

## License

MIT. Built for and used by [toolkave.com](https://toolkave.com), a set of free tools that run in the browser.
