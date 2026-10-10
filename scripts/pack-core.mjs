#!/usr/bin/env node
/**
 * Copy the single-threaded ffmpeg core into a folder your site serves, with
 * the wasm gzipped.
 *
 *   npx ffmpeg-wasm-pack-core public/ffmpeg
 *
 * Writes ffmpeg-core.js and ffmpeg-core.wasm.gz. Run it at build time, so the
 * 31 MB binary stays out of your repository and in step with the installed
 * @ffmpeg/core.
 *
 * Why gzip: the wasm is 30.7 MiB and Cloudflare (Workers static assets and
 * Pages) refuses any file over 25 MiB. Gzipped it is 9.8 MiB - under the limit
 * and a third of the download - and `wasmBlobURL` unpacks it in the browser.
 *
 * Why the ESM build: @ffmpeg/ffmpeg always starts its worker with
 * `type: "module"`. A module worker has no importScripts, so it falls through
 * to `await import(coreURL)` and reads `.default`. The UMD build has no default
 * export, and the worker throws "failed to import ffmpeg-core.js" on every
 * browser.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import path from 'node:path'

const target = path.resolve(process.argv[2] ?? 'public/ffmpeg')
const require = createRequire(path.join(process.cwd(), 'package.json'))

let from
try {
  // The package exports only "." (dist/umd/ffmpeg-core.js under require) and
  // "./wasm", not its package.json; the ESM build sits two folders up.
  from = path.join(path.dirname(require.resolve('@ffmpeg/core')), '../esm')
} catch {
  console.error('ffmpeg-wasm-pack-core: install @ffmpeg/core first (npm i @ffmpeg/core)')
  process.exit(1)
}

await mkdir(target, { recursive: true })
await copyFile(path.join(from, 'ffmpeg-core.js'), path.join(target, 'ffmpeg-core.js'))
const wasm = await readFile(path.join(from, 'ffmpeg-core.wasm'))
const packed = gzipSync(wasm, { level: 9 })
await writeFile(path.join(target, 'ffmpeg-core.wasm.gz'), packed)
console.log(
  `ffmpeg-wasm-pack-core: ${path.relative(process.cwd(), target) || '.'}/ffmpeg-core.js and ffmpeg-core.wasm.gz ` +
    `(${(wasm.length / 1048576).toFixed(1)} MiB -> ${(packed.length / 1048576).toFixed(1)} MiB)`
)
