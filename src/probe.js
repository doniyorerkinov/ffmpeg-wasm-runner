/**
 * Turn `ffmpeg -i` chatter into something that fits in a table.
 *
 * This is text scraping and in ffmpeg.wasm it is the only option: ffprobe's
 * JSON output is a separate binary the wasm build does not include, so the
 * stream table printed to the log is all there is. The layout has been
 * stable for a decade, but it is still text - so everything here is optional,
 * and a field that cannot be read is left out rather than guessed.
 *
 * Lines arrive from the worker one at a time and sometimes glued together, so
 * they are rejoined and re-split before anything is read.
 *
 * @param {string[]} lines what `runner.probe(file)` returned
 * @returns {{
 *   container: string | null,
 *   duration: number | null,
 *   bitrate: string | null,
 *   streams: { kind: 'video' | 'audio' | 'subtitle' | 'other', codec: string,
 *     size?: string, fps?: number, sampleRate?: number, channels?: string,
 *     bitrate?: string, detail: string }[]
 * }}
 */
export function readProbe(lines) {
  const rows = lines.join('\n').split('\n').map(line => line.trimEnd())

  // "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input-0.mp4':" - the demuxer's
  // name for the whole family, not a list of what is inside.
  const inputRow = rows.find(row => row.startsWith('Input #0,')) ?? ''
  const container = /^Input #0,\s*([^,]+(?:,[^,]+)*),\s*from/.exec(inputRow)?.[1]?.trim() ?? null

  const durationRow = rows.find(row => /^\s*Duration:/.test(row)) ?? ''
  const clock = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(durationRow)
  const duration = clock ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : null
  const bitrate = /bitrate:\s*([\d.]+\s*\w+\/s)/.exec(durationRow)?.[1] ?? null

  const streams = []
  for (const row of rows) {
    const match = /^\s*Stream #\d+:\d+.*?:\s*(Video|Audio|Subtitle|Data|Attachment):\s*(.+)$/.exec(row)
    if (!match) continue
    const label = match[1].toLowerCase()
    const rest = match[2]
    streams.push({
      kind: label === 'video' || label === 'audio' || label === 'subtitle' ? label : 'other',
      // Everything up to the first comma or bracket: "h264", "aac", "opus".
      codec: (/^([\w.-]+)/.exec(rest)?.[1] ?? rest).trim(),
      // The only WxH on the line; the [SAR ...] after it is not part of it.
      size: /(\d{2,5}x\d{2,5})/.exec(rest)?.[1],
      fps: Number(/([\d.]+)\s*fps/.exec(rest)?.[1]) || undefined,
      sampleRate: Number(/(\d+)\s*Hz/.exec(rest)?.[1]) || undefined,
      // "mono", "stereo", "5.1(side)", "7.1", "quad", "6 channels" - but never
      // the "44100" of ", 44100 Hz", which also follows a comma.
      channels: /,\s*(mono|stereo|quad|\d+\.\d+(?:\(\w+\))?|\d+ channels)(?=[,\s]|$)/.exec(rest)?.[1],
      bitrate: /([\d.]+\s*\w+\/s)/.exec(rest)?.[1],
      detail: rest
    })
  }
  return { container, duration, bitrate, streams }
}
