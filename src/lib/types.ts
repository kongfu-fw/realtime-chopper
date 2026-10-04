/**
 * Shared domain types. Kept dependency-free so both the main thread and the
 * workers can import them.
 */

export type SourceLang = 'en' | 'zh' | 'ko'
export type TargetLang = 'en' | 'zh' | 'ko'
export type Lang = SourceLang

/**
 * A downloadable recognition module.
 *
 * Not the same thing as a language: a module is a set of bytes and a language is
 * what the user says, so the two are mapped rather than equated (see `moduleIdFor`
 * in `asr/models.ts`). There is one module left — SenseVoice, which answers every
 * language the app offers — so the mapping is currently a constant, and it stays a
 * mapping because that is what versions of this app have changed and what a second
 * module would change again.
 *
 * Retired ids (`en`, `ko`, `ko-net`, `en-nemo`) are deliberately *not* part of this
 * union: they are never resolved to a module by the live code any more. They
 * survive as plain strings in the two places leftover bytes and crash notes are
 * read — the retired-cache sweep and `moduleName` — because a phone that installed
 * one of them is still holding the download.
 */
export type ModuleId = 'zh'

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
  /**
   * How much of `samples` the segmenter classified as speech — not the segment's
   * duration, which also covers the pre-roll, the tail the cut keeps and every
   * pause inside the utterance (see `EmittedSegment` in `asr/segmenter.ts`). This
   * is the number that says whether a recogniser has enough to read (`coalesceMs`)
   * and the one worth printing when a result is refused, so it travels with the
   * segment instead of being re-derived.
   */
  speechMs: number
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

