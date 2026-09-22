/**
 * Continuous recording of a session's audio — the "nothing can be missed" copy.
 *
 * Why this exists alongside the per-utterance audio the recogniser is handed:
 * every decision the pipeline makes (discard a burst shorter than `minSegMs`, a
 * recognition that times out, a cut placed mid-word) is a decision made *after*
 * the audio arrived, and each of them can lose or mangle a sentence. A continuous
 * recording turns all of those from "gone" into "recoverable": a segment can be
 * re-cut and re-recognised from the file, and the whole session can be exported.
 *
 * Two deliberate choices:
 *
 *  - **16 kHz mono, exactly what the recogniser consumes.** Recording the raw
 *    48 kHz stream would sound better but would make a slice no longer
 *    byte-identical to the recogniser's input, and re-recognition from a slice
 *    would be a different experiment from the original run. It is also 3x the
 *    size: 115 MB/hour at 16 kHz versus 345 MB/hour.
 *  - **Written to a real file, not a growing array of blobs.** The sink appends
 *    through a synchronous OPFS handle, so a long recording costs no memory at
 *    all. This is only possible inside a Worker — `createSyncAccessHandle` does
 *    not exist on the main thread (and is the *only* OPFS write API Safari has,
 *    which is why the recording lives in the worker alongside the VAD).
 *
 * The file is a valid WAV at all times: the header sits at offset 0 and is
 * rewritten as the recording grows, so exporting is `getFile()` + a download link
 * with no in-memory copy and no encoder.
 */

export const RECORDING_RATE = 16000
export const WAV_HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 2

/** One file per origin; a new recording truncates it. */
const FILE_NAME = 'rc-recording.wav'

export type RecordingMode = 'off' | 'opfs' | 'memory'
export type RecordingStopReason = 'limit' | 'error' | null

export interface RecordingInfo {
  mode: RecordingMode
  seconds: number
  bytes: number
  /** Why the recording stopped on its own. `null` while it is running fine. */
  stopped: RecordingStopReason
}

/**
 * Structural type for the synchronous OPFS handle.
 *
 * Declared locally rather than taken from the DOM lib: the type is present on
 * the main thread's `FileSystemFileHandle` in TypeScript's lib but the method
 * only exists inside a worker at runtime, so the lib's type would happily let
 * someone call it from the wrong place.
 */
interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  getSize(): number
  truncate(size: number): void
  flush(): void
  close(): void
}

export function writeWavHeader(view: DataView, sampleCount: number, sampleRate = RECORDING_RATE): void {
  const dataBytes = sampleCount * BYTES_PER_SAMPLE
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true)
  view.setUint16(32, BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
}

/** Wraps PCM in a WAV container. Used by the in-memory fallback and slices. */
export function pcmToWav(pcm: Float32Array, sampleRate = RECORDING_RATE): Blob {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + pcm.length * BYTES_PER_SAMPLE)
  const view = new DataView(buffer)
  writeWavHeader(view, pcm.length, sampleRate)
  const int16 = new Int16Array(buffer, WAV_HEADER_BYTES)
  for (let i = 0; i < pcm.length; i++) int16[i] = toInt16(pcm[i] ?? 0)
  return new Blob([buffer], { type: 'audio/wav' })
}

function toInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value))
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}

/** How often the on-disk header is refreshed while recording. */
const HEADER_REFRESH_SAMPLES = RECORDING_RATE * 5

export class RecordingSink {
  private mode: RecordingMode = 'off'
  private handle: SyncAccessHandle | null = null
  private memory: Int16Array[] = []
  private samples = 0
  private headerSamples = 0
  private maxSamples = Number.POSITIVE_INFINITY
  private stopped: RecordingStopReason = null
  private recording = false
  private lastNotify = 0

  constructor(private readonly notify?: (info: RecordingInfo) => void) {}

  get info(): RecordingInfo {
    return {
      mode: this.mode,
      seconds: this.samples / RECORDING_RATE,
      bytes: this.samples * BYTES_PER_SAMPLE,
      stopped: this.stopped,
    }
  }

  /** Longest recording we are willing to hold, so a forgotten tab cannot fill the disk. */
  configure(maxMinutes: number): void {
    this.maxSamples = Math.max(1, maxMinutes) * 60 * RECORDING_RATE
  }

  /**
   * Makes a WAV file available without touching a recording that is already on
   * the device, so the previous session can still be exported after a reload.
   */
  async attach(): Promise<RecordingInfo> {
    if (!this.handle && this.mode === 'off') await this.openFile(false)
    return this.info
  }

  /** Begins a new recording, discarding whatever was there. */
  async start(): Promise<RecordingInfo> {
    if (!this.handle && this.mode === 'off') await this.openFile(true)
    else await this.truncate()
    this.recording = true
    this.stopped = null
    this.publish(true)
    return this.info
  }

  append(samples: Float32Array): void {
    if (!this.recording || this.mode === 'off' || samples.length === 0) return
    if (this.samples >= this.maxSamples) {
      this.stopped = 'limit'
      void this.finish()
      return
    }
    const take = Math.min(samples.length, this.maxSamples - this.samples)
    const int16 = new Int16Array(take)
    for (let i = 0; i < take; i++) int16[i] = toInt16(samples[i] ?? 0)
    try {
      if (this.handle) {
        this.handle.write(int16, { at: WAV_HEADER_BYTES + this.samples * BYTES_PER_SAMPLE })
      } else {
        this.memory.push(int16)
      }
    } catch (err) {
      this.stopped = 'error'
      this.recording = false
      this.notify?.(this.info)
      void err
      return
    }
    this.samples += take
    if (this.samples - this.headerSamples >= HEADER_REFRESH_SAMPLES) this.finalizeHeader()
    this.publish(false)
  }

  /** Stops appending; the file stays readable and exportable. */
  async stop(): Promise<RecordingInfo> {
    await this.finish()
    this.publish(true)
    return this.info
  }

  async clear(): Promise<RecordingInfo> {
    await this.truncate()
    this.recording = false
    this.stopped = null
    this.publish(true)
    return this.info
  }

  async dispose(): Promise<void> {
    this.recording = false
    if (this.handle) {
      try {
        this.finalizeHeader()
        this.handle.flush()
        this.handle.close()
      } catch {
        /* the file is already as good as it is going to get */
      }
      this.handle = null
    }
  }

  /** The whole recording as a disk-backed WAV (or an in-memory blob). */
  async file(): Promise<File | Blob | null> {
    if (this.samples === 0) return null
    this.finalizeHeader()
    if (this.mode === 'opfs') {
      try {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle(FILE_NAME)
        return await handle.getFile()
      } catch {
        return null
      }
    }
    return this.memoryWav()
  }

  /** A WAV of just one segment, for playing a line back. */
  async wavSlice(startMs: number, endMs: number): Promise<ArrayBuffer | null> {
    const from = Math.max(0, Math.round((startMs / 1000) * RECORDING_RATE))
    const to = Math.min(this.samples, Math.round((endMs / 1000) * RECORDING_RATE))
    if (to <= from) return null
    const pcm = await this.readRange(from, to)
    if (!pcm) return null
    const buffer = new ArrayBuffer(WAV_HEADER_BYTES + pcm.length * BYTES_PER_SAMPLE)
    const view = new DataView(buffer)
    writeWavHeader(view, pcm.length)
    new Uint8Array(buffer, WAV_HEADER_BYTES).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    return buffer
  }

  /** The raw samples of one segment, for recognising it again from the file. */
  async pcmSlice(startMs: number, endMs: number): Promise<Float32Array | null> {
    const from = Math.max(0, Math.round((startMs / 1000) * RECORDING_RATE))
    const to = Math.min(this.samples, Math.round((endMs / 1000) * RECORDING_RATE))
    if (to <= from) return null
    const pcm = await this.readRange(from, to)
    if (!pcm) return null
    const out = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000
    return out
  }

  // ------------------------------------------------------------------ internals

  private async readRange(from: number, to: number): Promise<Int16Array | null> {
    const count = to - from
    if (count <= 0) return null
    if (this.handle) {
      const bytes = new ArrayBuffer(count * BYTES_PER_SAMPLE)
      const read = this.handle.read(new Uint8Array(bytes), {
        at: WAV_HEADER_BYTES + from * BYTES_PER_SAMPLE,
      })
      if (read <= 0) return null
      return new Int16Array(bytes, 0, Math.floor(read / BYTES_PER_SAMPLE))
    }
    const out = new Int16Array(count)
    let written = 0
    let cursor = 0
    for (const chunk of this.memory) {
      const chunkEnd = cursor + chunk.length
      if (chunkEnd <= from) {
        cursor = chunkEnd
        continue
      }
      if (cursor >= to) break
      const localStart = Math.max(0, from - cursor)
      const localEnd = Math.min(chunk.length, to - cursor)
      out.set(chunk.subarray(localStart, localEnd), written)
      written += localEnd - localStart
      cursor = chunkEnd
    }
    return out
  }

  private memoryWav(): Blob {
    const total = this.memory.reduce((n, chunk) => n + chunk.length, 0)
    const buffer = new ArrayBuffer(WAV_HEADER_BYTES + total * BYTES_PER_SAMPLE)
    writeWavHeader(new DataView(buffer), total)
    const target = new Int16Array(buffer, WAV_HEADER_BYTES, total)
    let offset = 0
    for (const chunk of this.memory) {
      target.set(chunk, offset)
      offset += chunk.length
    }
    return new Blob([buffer], { type: 'audio/wav' })
  }

  private async finish(): Promise<void> {
    this.recording = false
    this.finalizeHeader()
    try {
      this.handle?.flush()
    } catch {
      /* nothing to flush */
    }
  }

  private finalizeHeader(): void {
    if (!this.handle || this.headerSamples === this.samples) return
    try {
      const header = new ArrayBuffer(WAV_HEADER_BYTES)
      writeWavHeader(new DataView(header), this.samples)
      this.handle.write(new Uint8Array(header), { at: 0 })
      this.headerSamples = this.samples
    } catch {
      this.stopped = 'error'
    }
  }

  private async truncate(): Promise<void> {
    this.memory = []
    this.samples = 0
    this.headerSamples = 0
    if (this.handle) {
      try {
        this.handle.flush()
        this.handle.truncate(0)
        this.finalizeHeader()
      } catch {
        this.stopped = 'error'
      }
    }
  }

  private async openFile(truncate: boolean): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory()
      const fileHandle = await root.getFileHandle(FILE_NAME, { create: true })
      const create = (
        fileHandle as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandle> }
      ).createSyncAccessHandle
      if (typeof create !== 'function') throw new Error('no sync access handle')
      this.handle = await create.call(fileHandle)
      this.mode = 'opfs'
      if (truncate) {
        this.handle.truncate(0)
        this.samples = 0
        this.headerSamples = 0
        this.finalizeHeader()
      } else {
        // Adopt what is already there (a reload should not throw away a recording
        // the user has not exported yet).
        const size = this.handle.getSize()
        this.samples = Math.max(0, Math.floor((size - WAV_HEADER_BYTES) / BYTES_PER_SAMPLE))
        this.headerSamples = this.samples
      }
    } catch {
      // No OPFS (private windows, very old engines): keep the recording in RAM.
      // It still exports and still backs re-recognition; it just costs memory.
      this.handle = null
      this.mode = 'memory'
      if (truncate) this.memory = []
    }
  }

  /** At most two updates a second: the UI shows a size, not a waveform. */
  private publish(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastNotify < 500) return
    this.lastNotify = now
    this.notify?.(this.info)
  }
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

// ----------------------------------------------------------------------------
// Main-thread helpers.
//
// Once a session stops, the worker that wrote the recording is gone with it, so
// playback and re-recognition read the finished WAV directly. Byte ranges are
// copied rather than decoded and re-encoded, so a slice of the recording is
// bit-for-bit what the recogniser heard the first time.
// ----------------------------------------------------------------------------

function sampleRange(totalSamples: number, startMs: number, endMs: number): [number, number] | null {
  const from = Math.max(0, Math.round((startMs / 1000) * RECORDING_RATE))
  const to = Math.min(totalSamples, Math.round((endMs / 1000) * RECORDING_RATE))
  return to > from ? [from, to] : null
}

function samplesIn(blob: Blob): number {
  return Math.max(0, Math.floor((blob.size - WAV_HEADER_BYTES) / BYTES_PER_SAMPLE))
}

/** Cuts one segment out of a finished recording, as a playable WAV. */
export async function wavSliceFromBlob(
  source: Blob,
  startMs: number,
  endMs: number,
): Promise<Blob | null> {
  const range = sampleRange(samplesIn(source), startMs, endMs)
  if (!range) return null
  const [from, to] = range
  const data = await source
    .slice(WAV_HEADER_BYTES + from * BYTES_PER_SAMPLE, WAV_HEADER_BYTES + to * BYTES_PER_SAMPLE)
    .arrayBuffer()
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + data.byteLength)
  writeWavHeader(new DataView(buffer), data.byteLength / BYTES_PER_SAMPLE)
  new Uint8Array(buffer, WAV_HEADER_BYTES).set(new Uint8Array(data))
  return new Blob([buffer], { type: 'audio/wav' })
}

/** The raw samples of one segment, for recognising it again from the recording. */
export async function pcmSliceFromBlob(
  source: Blob,
  startMs: number,
  endMs: number,
): Promise<Float32Array | null> {
  const range = sampleRange(samplesIn(source), startMs, endMs)
  if (!range) return null
  const [from, to] = range
  const data = await source
    .slice(WAV_HEADER_BYTES + from * BYTES_PER_SAMPLE, WAV_HEADER_BYTES + to * BYTES_PER_SAMPLE)
    .arrayBuffer()
  const int16 = new Int16Array(data)
  const out = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 0x8000
  return out
}

/** Deletes the stored recording (used when no worker holds it open). */
export async function deleteRecordingFile(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(FILE_NAME)
  } catch {
    /* nothing stored, or no OPFS at all */
  }
}
