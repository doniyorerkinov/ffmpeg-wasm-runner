/**
 * What to tell ffmpeg, kept apart from running it.
 *
 * Every tool built on ffmpeg is a few arguments around one binary, and the
 * arguments are where the mistakes live: a flag in the wrong place gives a
 * file without sound, or re-encodes what could have been copied. As pure
 * functions they can be tested in milliseconds without loading the core.
 *
 * Each recipe here runs in production on toolkave.com; the comments say what
 * went wrong before it looked like this.
 */

/**
 * Eight-bit 4:2:0 - the only H.264 that things other than ffmpeg decode.
 *
 * Without it libx264 keeps whatever it is handed: a 10-bit source becomes
 * High 10, an overlay negotiated in RGBA becomes High 4:4:4 Predictive. Both
 * are legal and both are refused by phones, TVs, browsers and hardware
 * decoders. A playable file beats a faithful one.
 */
export const PLAYABLE = ['-pix_fmt', 'yuv420p']

/**
 * Smaller video for sending.
 *
 * `scale='min(W,iw)':-2` never upscales and keeps the height even (H.264
 * rejects odd sizes). `+faststart` moves the index to the front so a
 * Telegram or WhatsApp preview plays before the whole file has arrived.
 *
 * @param {{ crf?: number, maxWidth?: number, audioBitrate?: string }} [options]
 */
export function compressVideoArgs({ crf = 27, maxWidth = 1280, audioBitrate = '128k' } = {}) {
  return [
    '-vf', `scale='min(${maxWidth},iw)':-2`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    ...PLAYABLE,
    '-crf', String(crf),
    '-c:a', 'aac',
    '-b:a', audioBitrate,
    '-movflags', '+faststart'
  ]
}

/**
 * Cut a piece out of a video.
 *
 * With `-c copy` (`accurate: false`) a video can only begin on a keyframe,
 * and where `-ss` goes decides what you get:
 * - after `-i`, ffmpeg drops everything before the start and the picture
 *   begins at the NEXT keyframe - seconds after the sound, or not at all when
 *   no keyframe falls inside the cut;
 * - before `-i`, it seeks to the keyframe at or before the start, copies from
 *   there, and the container records where playback begins, so picture and
 *   sound start together at the time asked.
 * So a copied cut needs `trimSeekArgs` as the job's `beforeInput`. Re-encoding
 * (`accurate: true`) is frame-accurate either way.
 *
 * @param {{ start: number, end: number, accurate: boolean }} options seconds
 */
export function trimArgs({ start, end, accurate }) {
  const duration = Math.max(0.05, end - start)
  const codec = accurate ? ['-c:v', 'libx264', '-preset', 'veryfast', ...PLAYABLE, '-crf', '23', '-c:a', 'aac'] : ['-c', 'copy']
  return [...(accurate ? ['-ss', String(start)] : []), '-t', String(duration), ...codec]
}

/** The part of a copied cut that goes before `-i`. Empty for an accurate cut. */
export function trimSeekArgs({ start, accurate }) {
  return accurate ? [] : ['-ss', String(start)]
}

/** @typedef {'mp3' | 'wav' | 'ogg' | 'm4a' | 'flac'} AudioFormat */

const AUDIO_CODEC = {
  mp3: ['-c:a', 'libmp3lame', '-b:a', '192k'],
  wav: ['-c:a', 'pcm_s16le'],
  ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
  m4a: ['-c:a', 'aac', '-b:a', '192k'],
  // Lossless: a bitrate would mean nothing.
  flac: ['-c:a', 'flac']
}

/**
 * Audio from one format to another. `-vn` drops video and album art, so an
 * MP4 or WebM gives clean sound. MP3 cannot go above 48 kHz; ffmpeg
 * resamples a higher rate on its own.
 *
 * @param {AudioFormat} format
 */
export function convertAudioArgs(format) {
  const codec = AUDIO_CODEC[format]
  if (!codec) throw new Error(`unknown audio format: ${format}`)
  return ['-vn', ...codec]
}

/**
 * Even loudness, -16 LUFS, peaks under -1.5 dBTP.
 *
 * One pass of loudnorm with nothing measured beforehand runs in its dynamic
 * mode: it follows the loudness as it plays (with a few seconds' look-ahead)
 * and turns quiet parts up and loud parts down. It does not measure the whole
 * file first - say so if you describe it to users. Output is resampled to
 * 48 kHz on the way to MP3.
 */
export function normaliseArgs() {
  return ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'libmp3lame', '-b:a', '192k']
}

/**
 * To MP4, copying the streams when the codecs already fit the container. An
 * MKV holding H.264 and AAC is an MP4 in the wrong box: remuxing takes a
 * second and loses nothing. Decide `remux` from a `probe` of the file.
 *
 * @param {boolean} remux
 */
export function toMp4Args(remux) {
  return remux
    ? ['-c', 'copy', '-movflags', '+faststart']
    : ['-c:v', 'libx264', '-preset', 'veryfast', ...PLAYABLE, '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']
}

/**
 * A GIF worth looking at, in one pass: `palettegen` builds a palette from the
 * footage itself and `paletteuse` dithers against it. The naive conversion
 * quantises against the stock 216-colour palette and looks like 1997.
 *
 * @param {{ fps: number, width: number, start?: number, duration?: number }} options
 */
export function gifArgs({ fps, width, start, duration }) {
  const seek = start ? ['-ss', String(start)] : []
  const length = duration ? ['-t', String(duration)] : []
  const filter =
    `fps=${fps},scale='min(${width},iw)':-1:flags=lanczos,` +
    'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3'
  return [...seek, ...length, '-vf', filter, '-loop', '0']
}

/**
 * Still frames, `fps` per second, at most `limit` of them, never wider than
 * `width`. Run with `runMany` and an output pattern such as frame-%04d.png.
 *
 * PNG, not JPEG: ffmpeg.wasm's mjpeg encoder corrupted memory on a 10-bit
 * HEVC source after a few dozen frames and took the worker down. Make JPEGs
 * from the PNGs in the browser if you need them.
 *
 * @param {{ fps: number, width: number, limit: number }} options
 */
export function framesArgs({ fps, width, limit }) {
  return ['-vf', `fps=${fps},scale='min(${width},iw)':-2`, '-frames:v', String(limit)]
}

/**
 * How much input the frame cap can need, in seconds - pass it as `-t` in the
 * job's `beforeInput`. `-frames:v` only limits output: if the fps filter stops
 * emitting (a timestamp gap is enough), ffmpeg keeps decoding to the end of
 * the file, and 60 frames from a two-hour video become a two-hour decode.
 */
export function framesSpan({ fps, limit }) {
  return Math.ceil((limit + 1) / fps)
}

/**
 * Fade in at the start and out at the end. The fade-out must be placed, not
 * just given a length, so this needs the file's duration - take it from an
 * `<audio>` element's `duration`, which costs nothing (but see the README:
 * Chrome reports Infinity for MediaRecorder files until you seek).
 *
 * @param {{ fadeIn: number, fadeOut: number, duration: number }} options seconds
 */
export function fadeArgs({ fadeIn, fadeOut, duration }) {
  const filters = []
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`)
  if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut}`)
  return [...(filters.length ? ['-af', filters.join(',')] : []), '-c:a', 'libmp3lame', '-b:a', '192k']
}

/**
 * Join audio files end to end. A 44.1 kHz stereo MP3 and a 48 kHz mono voice
 * note cannot simply be concatenated: without `aformat` you get a failure or,
 * worse, a file that plays at the wrong speed. Everything is brought to one
 * format first.
 *
 * @param {number} count how many inputs, in order
 */
export function mergeAudioArgs(count) {
  const prepared = []
  const labels = []
  for (let i = 0; i < count; i++) {
    prepared.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`)
    labels.push(`[a${i}]`)
  }
  return ['-filter_complex', `${prepared.join(';')};${labels.join('')}concat=n=${count}:v=0:a=1[out]`, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k']
}

/**
 * A phone ringtone. iPhone wants AAC in an MPEG-4 container named `.m4r` -
 * byte for byte an `.m4a`, renamed; `-f ipod` picks that muxer explicitly.
 * Android takes a plain MP3. Write to an `.m4a` (iPhone) or `.mp3` output and
 * rename the download.
 *
 * Seek BEFORE the input (`ringtoneSeekArgs` as `beforeInput`). After it,
 * ffmpeg filters the song from its first second and drops the start later,
 * so the fades land on the song's timeline: a 30 s cut starting at 0:45 comes
 * out as silence.
 *
 * @param {{ phone: 'iphone' | 'android', duration: number, fadeIn: number, fadeOut: number }} options
 */
export function ringtoneArgs({ phone, duration, fadeIn, fadeOut }) {
  const length = Math.min(duration, 40)
  const filters = []
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`)
  if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, length - fadeOut).toFixed(3)}:d=${fadeOut}`)
  return [
    '-t', String(length),
    '-vn',
    ...(filters.length ? ['-af', filters.join(',')] : []),
    ...(phone === 'iphone' ? ['-c:a', 'aac', '-b:a', '192k', '-f', 'ipod'] : ['-c:a', 'libmp3lame', '-b:a', '192k'])
  ]
}

/** The start of a ringtone, which goes before `-i`. */
export function ringtoneSeekArgs(start) {
  return ['-ss', String(start)]
}
