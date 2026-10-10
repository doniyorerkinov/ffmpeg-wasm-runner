export interface InputFile {
  /** Only the extension is used: it picks the demuxer. */
  name: string
  data: Uint8Array
}

export interface Job {
  input?: InputFile
  /** Several inputs, in order: `-i input-0.x -i input-1.y ...`. */
  inputs?: InputFile[]
  /** Options before the first `-i`, e.g. `trimSeekArgs(...)` or `['-t', '61']`. */
  beforeInput?: string[]
  /** Arguments between the inputs and the output. */
  args?: string[]
  /** Output name. Only its extension reaches ffmpeg (it picks the container). */
  output: string
  /** Seconds of output expected, when shorter than the input; makes progress reach 1. */
  span?: number
  /** 0 to 1 as ffmpeg reports progress. */
  onProgress?: (fraction: number) => void
}

export type RunnerErrorCode =
  | 'FFMPEG_CORE_UNAVAILABLE'
  | 'FFMPEG_FAILED'
  | 'FFMPEG_EMPTY'
  | 'FFMPEG_CRASHED'
  | 'FFMPEG_BAD_PATTERN'

export interface RunnerError extends Error {
  code: RunnerErrorCode
  detail?: string
  command?: string[]
  /** The last lines ffmpeg logged before the failure. */
  log?: string[]
}

export interface Runner {
  readonly ready: boolean
  preload(): Promise<void>
  run(job: Job): Promise<Uint8Array>
  runMany(job: Job): Promise<{ name: string; data: Uint8Array }[]>
  probe(file: InputFile): Promise<string[]>
  terminate(): void
}

export function createRunner(options: { coreURL: string; wasmURL: string; logLines?: number }): Runner
export function wasmBlobURL(url: string): Promise<string>
export function codeError(code: RunnerErrorCode, detail?: string): RunnerError
export function extension(name?: string): string

export interface ProbeResult {
  container: string | null
  duration: number | null
  bitrate: string | null
  streams: {
    kind: 'video' | 'audio' | 'subtitle' | 'other'
    codec: string
    size?: string
    fps?: number
    sampleRate?: number
    channels?: string
    bitrate?: string
    detail: string
  }[]
}
export function readProbe(lines: string[]): ProbeResult

export type AudioFormat = 'mp3' | 'wav' | 'ogg' | 'm4a' | 'flac'
export const PLAYABLE: string[]
export function compressVideoArgs(options?: { crf?: number; maxWidth?: number; audioBitrate?: string }): string[]
export function trimArgs(options: { start: number; end: number; accurate: boolean }): string[]
export function trimSeekArgs(options: { start: number; accurate: boolean }): string[]
export function convertAudioArgs(format: AudioFormat): string[]
export function normaliseArgs(): string[]
export function toMp4Args(remux: boolean): string[]
export function gifArgs(options: { fps: number; width: number; start?: number; duration?: number }): string[]
export function framesArgs(options: { fps: number; width: number; limit: number }): string[]
export function framesSpan(options: { fps: number; limit: number }): number
export function fadeArgs(options: { fadeIn: number; fadeOut: number; duration: number }): string[]
export function mergeAudioArgs(count: number): string[]
export function ringtoneArgs(options: { phone: 'iphone' | 'android'; duration: number; fadeIn: number; fadeOut: number }): string[]
export function ringtoneSeekArgs(start: number): string[]
