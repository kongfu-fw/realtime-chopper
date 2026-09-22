/**
 * Shared domain types. Kept dependency-free so both the main thread and the
 * workers can import them.
 */

export type SourceLang = 'en' | 'zh' | 'ko'
export type TargetLang = 'en' | 'zh' | 'ko'
export type Lang = SourceLang

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Stage =
  | 'capture'
  | 'vad'
  | 'asr'
  | 'translate'
  | 'tts'
  | 'session'
  | 'storage'
  | 'selfcheck'
  | 'ui'

export interface LogEntry {
  id: number
  ts: number
  level: LogLevel
  stage: Stage
  message: string
  detail?: string
}

/** A speech segment produced by the VAD, before recognition. */
export interface SpeechSegment {
  id: number
  startMs: number
  endMs: number
  /** 16 kHz mono PCM. */
  samples: Float32Array
}

export type MtState = 'pending' | 'ok' | 'failed' | 'cached'
export type TtsState = 'idle' | 'pending' | 'speaking' | 'done' | 'error'

/** One recognised utterance plus everything downstream of it. */
export interface Line {
  id: number
  startMs: number
  endMs: number
  /** Normalised recognition output. */
  text: string
  /** Raw recognition output, before any tag/format cleanup. Kept for debug mode. */
  rawText: string
  engine: string
  inferMs: number
  /**
   * Position of this utterance inside the session recording.
   *
   * The audio itself is not stored per line: the recording already holds every
   * sample, so replay cuts this range out of the file on demand.
   */
  translation: string | null
  mtState: MtState
  mtProvider?: string
  ttsState: TtsState
  error?: string
}

export interface QueueSnapshot {
  seg: number
  mt: number
  tts: number
  /** Estimated seconds of audio still to be read out. */
  lagSeconds: number
  failed: number
}

export type SessionState =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'error'

export interface AsrResult {
  text: string
  rawText: string
  engine: string
  inferMs: number
}

/**
 * Progress report shared by every module downloader and engine loader.
 *
 * Contract for `progress`: a **fraction between 0 and 1** covering the whole
 * module — not the file currently in flight, and not a percentage. Every producer
 * converts to that shape, because the two underlying libraries disagree: our own
 * fetchers count bytes, while transformers.js reports `loaded / total * 100` per
 * file and additionally emits an aggregate `progress_total` event. Passing either
 * through unconverted is how the dialog ended up showing "4490%" and a bar that
 * restarted once per file.
 */
export interface AsrLoadProgress {
  status: string
  file?: string
  progress?: number
  loaded?: number
  total?: number
}

export type AsrProgressCallback = (progress: AsrLoadProgress) => void

/** Common surface of the two engine implementations, used by the router. */
export interface AsrEngine {
  readonly id: string
  readonly lang: Lang
  readonly ready: boolean
  load(onProgress?: AsrProgressCallback): Promise<{ device?: string; dtype?: string; reason?: string }>
  recognize(samples: Float32Array): Promise<AsrResult>
  dispose(): void
}
