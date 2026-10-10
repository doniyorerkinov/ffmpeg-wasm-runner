/**
 * Single-threaded ffmpeg.wasm, loaded on demand and kept for the page.
 *
 * Why single-threaded: the multithreaded core is two to four times faster but
 * needs SharedArrayBuffer, which needs the COOP and COEP response headers,
 * which break third-party embeds and ads on the same page. This runs on any
 * host with no special headers.
 *
 * Nothing loads until the first job. The core is the largest thing a page is
 * likely to ask for, so the import, the download and the instantiation all
 * happen inside `run`, never at page load.
 */
import { codeError, wasmBlobURL } from './unpack.js'

/**
 * @param {{ coreURL: string, wasmURL: string, logLines?: number, createFFmpeg?: () => Promise<any> }} options
 *   coreURL: the ESM `ffmpeg-core.js` (the UMD build does not work, see README)
 *   wasmURL: `ffmpeg-core.wasm` or `ffmpeg-core.wasm.gz`
 *   createFFmpeg: returns a loaded @ffmpeg/ffmpeg instance - for tests, or to
 *     load the core some other way. Defaults to loading coreURL and wasmURL.
 */
export function createRunner(options) {
  const keepLines = options.logLines ?? 80
  /** @type {any} */
  let instance = null
  /** @type {Promise<any> | null} */
  let loading = null

  async function defaultFFmpeg() {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const { toBlobURL } = await import('@ffmpeg/util')
    const ffmpeg = new FFmpeg()
    await ffmpeg.load({
      coreURL: await toBlobURL(options.coreURL, 'text/javascript'),
      wasmURL: await wasmBlobURL(options.wasmURL)
    })
    return ffmpeg
  }

  async function boot() {
    if (instance?.loaded) return instance
    if (loading) return await loading
    loading = (async () => {
      const ffmpeg = await (options.createFFmpeg ?? defaultFFmpeg)()
      instance = ffmpeg
      return ffmpeg
    })()
    try {
      return await loading
    } finally {
      loading = null
    }
  }

  /**
   * Write the inputs, run, collect, and clean the in-memory disk whatever
   * happened. The disk lives as long as the page, so a visitor converting five
   * videos without the cleanup would hold all five, plus their outputs, in
   * memory at once - on a phone, the difference between slow and a killed tab.
   */
  async function withFfmpeg(job, collect, outputArgs) {
    const ffmpeg = await boot()

    const onProgress = payload => {
      // Measured against the expected output length when there is one, so
      // "the first minute of a two-hour file" can reach 100%. Clamped, because
      // ffmpeg reports past 1 on some inputs.
      const raw = job.span && typeof payload.time === 'number' ? payload.time / 1e6 / job.span : payload.progress
      job.onProgress?.(Math.max(0, Math.min(1, raw)))
    }
    const log = []
    const onLog = ({ message }) => {
      log.push(message)
      if (log.length > keepLines) log.shift()
    }
    ffmpeg.on('progress', onProgress)
    ffmpeg.on('log', onLog)

    const inputs = inputsOf(job)
    const command = [...(job.beforeInput ?? []), ...inputs.flatMap(file => ['-i', file.name]), ...(job.args ?? []), ...outputArgs]
    try {
      // `.slice()` is required, not defensive: writeFile *transfers* the
      // buffer to the worker and detaches the caller's copy, so running a
      // second job on the same bytes would fail with "An ArrayBuffer is
      // detached and could not be cloned".
      for (const file of inputs) await ffmpeg.writeFile(file.name, file.data.slice())
      const code = await ffmpeg.exec(command)
      if (code !== 0) throw codeError('FFMPEG_FAILED', `exit ${code}`)
      return await collect(ffmpeg)
    } catch (error) {
      // Our own codes mean ffmpeg ran and disagreed. Anything else came up from
      // the worker - a wasm trap such as "memory access out of bounds" - and
      // the core is corrupt from here on: every later job would fail too. So
      // it is thrown away and the next job boots a fresh one.
      if (!(error?.code ?? '').startsWith('FFMPEG_')) {
        try { ffmpeg.terminate() } catch { /* already gone */ }
        instance = null
        error = codeError('FFMPEG_CRASHED', String(error?.message ?? error))
      }
      error.command = command
      error.log = log.slice()
      throw error
    } finally {
      ffmpeg.off('log', onLog)
      ffmpeg.off('progress', onProgress)
      for (const file of inputs) await ffmpeg.deleteFile(file.name).catch(() => {})
    }
  }

  return {
    /** Whether the core is loaded. */
    get ready() {
      return Boolean(instance?.loaded)
    },

    /** Load the core now, e.g. while the user is still choosing options. */
    preload: () => boot().then(() => undefined),

    /**
     * One conversion producing one file.
     *
     * ffmpeg writes to a name of its own; only the extension of `job.output`
     * reaches it, to choose the container. A name made from the user's file
     * breaks ffmpeg in ways nobody expects: "-song.mp3" is read as an option,
     * "clip:2.mp4" as a protocol called "clip", "50%d.png" as a frame pattern,
     * and "input.mp3" converted to MP3 collides with its own input.
     */
    async run(job) {
      const target = `output${extension(job.output)}`
      return await withFfmpeg(
        job,
        async ffmpeg => {
          try {
            const out = await ffmpeg.readFile(target)
            if (typeof out === 'string') throw codeError('FFMPEG_FAILED', 'output read back as text')
            if (!out.byteLength) throw codeError('FFMPEG_EMPTY', 'ffmpeg wrote an empty file')
            return out
          } finally {
            await ffmpeg.deleteFile(target).catch(() => {})
          }
        },
        [target]
      )
    },

    /**
     * One conversion producing many files, e.g. `frame-%04d.png`. Only ffmpeg
     * knows how many it wrote, so the disk is listed afterwards and every
     * file starting with the pattern's fixed part is returned, in name order.
     */
    async runMany(job) {
      const at = job.output.indexOf('%')
      if (at < 0) throw codeError('FFMPEG_BAD_PATTERN', 'runMany needs an output pattern such as frame-%04d.png')
      // As in `run`, nothing but safe characters reaches ffmpeg as a name.
      const stem = job.output.slice(0, at).replace(/[^A-Za-z0-9_.-]/g, '_') || 'out-'
      const pattern = stem + job.output.slice(at)
      return await withFfmpeg(
        job,
        async ffmpeg => {
          const names = (await ffmpeg.listDir('/'))
            .filter(entry => !entry.isDir && entry.name.startsWith(stem))
            .map(entry => entry.name)
            .sort()
          const out = []
          try {
            for (const name of names) {
              const data = await ffmpeg.readFile(name)
              if (typeof data !== 'string' && data.byteLength) out.push({ name, data })
            }
          } finally {
            for (const name of names) await ffmpeg.deleteFile(name).catch(() => {})
          }
          if (!out.length) throw codeError('FFMPEG_EMPTY', `no file matched ${stem}`)
          return out
        },
        [pattern]
      )
    },

    /**
     * What ffmpeg can say about a file, without converting it: the lines of
     * `ffmpeg -i file`. That command exits non-zero ("At least one output
     * file must be specified") even when it worked, so it cannot go through
     * `run`. Pass the lines to `readProbe`.
     */
    async probe(file) {
      const ffmpeg = await boot()
      const lines = []
      const onLog = ({ message }) => lines.push(message)
      ffmpeg.on('log', onLog)
      const name = `probe${extension(file.name)}`
      try {
        await ffmpeg.writeFile(name, file.data.slice())
        await ffmpeg.exec(['-hide_banner', '-i', name])
        return lines
      } catch (error) {
        try { ffmpeg.terminate() } catch { /* already gone */ }
        instance = null
        throw codeError('FFMPEG_CRASHED', String(error?.message ?? error))
      } finally {
        ffmpeg.off('log', onLog)
        await ffmpeg.deleteFile(name).catch(() => {})
      }
    },

    /** Stop the worker and free its memory. The next job boots a new one. */
    terminate() {
      try { instance?.terminate() } catch { /* already gone */ }
      instance = null
    }
  }
}

/**
 * The inputs, renamed. The extension is kept because it picks the demuxer;
 * the rest of the visitor's file name never reaches ffmpeg (see `run`).
 * Numbered, because the in-memory disk is flat: two inputs both called
 * "input.mp4" would be one file, and a merge would join a clip to itself.
 */
function inputsOf(job) {
  const list = job.inputs ?? (job.input ? [job.input] : [])
  return list.map((file, index) => ({ name: `input-${index}${extension(file.name)}`, data: file.data }))
}

/** ".mp4" from "Holiday clip.MP4"; "" when there is none. */
export function extension(name = '') {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name)
  return match ? `.${match[1].toLowerCase()}` : ''
}
