/**
 * Fetch the ffmpeg core's wasm and return a URL ffmpeg can load.
 *
 * The single-threaded core is 30.7 MiB. Cloudflare (Workers static assets,
 * Pages) refuses a file over 25 MiB, so it is stored gzipped (9.8 MiB) and
 * unpacked here with DecompressionStream.
 *
 * Whether it arrives compressed is not up to us. A server that recognises
 * `.gz` may send `Content-Encoding: gzip`, and then the browser has already
 * unpacked it before a byte reaches this code; one that treats it as an
 * opaque download does not. So the first bytes decide: gzip magic means
 * unpack, wasm magic means use as is, anything else is an error page standing
 * in for the file.
 */

const GZIP_MAGIC = [0x1f, 0x8b]
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]

const startsWith = (bytes, magic) => magic.every((byte, i) => bytes[i] === byte)

/** One object URL per wasm URL, for the life of the page. */
const cache = new Map()

/**
 * @param {string} url Where the `.wasm` or `.wasm.gz` is served from.
 * @returns {Promise<string>} A blob URL holding the plain wasm.
 */
export async function wasmBlobURL(url) {
  const cached = cache.get(url)
  if (cached) return cached

  const response = await fetch(url)
  if (!response.ok) throw codeError('FFMPEG_CORE_UNAVAILABLE', `${url} answered ${response.status}`)

  let buffer = await response.arrayBuffer()
  const head = new Uint8Array(buffer.slice(0, 4))

  if (startsWith(head, GZIP_MAGIC)) {
    if (typeof DecompressionStream !== 'function') {
      throw codeError('FFMPEG_CORE_UNAVAILABLE', 'this browser has no DecompressionStream to unpack the core')
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
    buffer = await new Response(stream).arrayBuffer()
  } else if (!startsWith(head, WASM_MAGIC)) {
    throw codeError('FFMPEG_CORE_UNAVAILABLE', `${url} is neither gzip nor wasm - probably an HTML error page`)
  }

  const blobURL = URL.createObjectURL(new Blob([buffer], { type: 'application/wasm' }))
  cache.set(url, blobURL)
  return blobURL
}

/** An Error whose message is a stable code, with the details alongside. */
export function codeError(code, detail) {
  const error = new Error(code)
  error.code = code
  if (detail) error.detail = detail
  return error
}
