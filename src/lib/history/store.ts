/**
 * The notes the app keeps: every session's audio, its transcript and its
 * translations, on the device.
 *
 * ## Why this exists
 *
 * A recording used to be a thing you had *just* made. The continuous WAV lived in
 * one file with one name, and starting a new session overwrote it — the export
 * button existed to get the audio out before that happened. That is the right
 * design for a tool whose artifact is the lesson you are sitting in and the wrong
 * one for a tool whose artifact is a *note*: the same person records the same
 * lecture twice, and the second recording threw the first away.
 *
 * So a session now ends by being *filed*: its audio is moved aside, and the text
 * that came out of it — the recognised sentences and their translations — is
 * written next to it. What the history view reads is what was said.
 *
 * ## What is stored, and where
 *
 * Three files per note in one OPFS directory (`rc-history/`):
 *
 *   `index.json`     every note's metadata, newest first — the list view reads
 *                    this and nothing else, so opening the app does not decode a
 *                    term of transcripts
 *   `<id>.json`      one note in full: its transcript, sentence by sentence
 *   `<id>.wav`       16 kHz mono, the same bytes the recogniser heard
 *
 * The directory rather than `localStorage`, and that is not a preference: an hour
 * of audio is ~115 MB and `localStorage` holds a few megabytes of *text*. OPFS is
 * already how the recording itself is written (`audio/recorder.ts`), so this is
 * the same storage the app was already using, with a name per note instead of one
 * name for all of them.
 *
 * ## When there is no OPFS
 *
 * A private window has no origin-private file system, and the honest answer there
 * is not to lose the note: everything still works, in memory, for as long as the
 * page lives — and `historyPersistent` is false so the view can say so. The
 * alternative (refusing to save) would be a worse lie: the user's note is real,
 * it simply will not survive the tab.
 */

import { get, writable, type Writable } from 'svelte/store'
import { t } from '../i18n/index.ts'
import { info, warn } from '../log/store'

/** One recognised sentence, as the note keeps it: the text and where it sits. */
export interface HistoryLine {
  text: string
  /** `null` while a sentence had no translation, which is a fact worth keeping. */
  translation: string | null
  /** Position inside this note's audio, so a sentence can be found again. */
  startMs: number
  endMs: number
}

/** Everything about a note except its words — what the list renders. */
export interface HistoryMeta {
  id: string
  /** When the session started, epoch ms. The sort key, and the date in the title. */
  at: number
  /** Recorded seconds. */
  seconds: number
  title: string
  /** True while the title is still the generated one; a rename clears it. */
  auto: boolean
  /** City, coordinates, or `''` when nothing was known. */
  place: string
  lat?: number
  lon?: number
  /** Bytes of the stored WAV; 0 when there is no audio for this note. */
  audioBytes: number
  /** How many sentences were recognised. */
  lines: number
}

export interface HistoryEntry extends HistoryMeta {
  transcript: HistoryLine[]
}

const DIR_NAME = 'rc-history'
const INDEX_NAME = 'index.json'
const entryName = (id: string) => `${id}.json`
const audioName = (id: string) => `${id}.wav`

/** The notes, newest first. The list view renders this. */
export const historyList: Writable<HistoryMeta[]> = writable([])
/** True once the index has been read, so the view can tell empty from unread. */
export const historyReady = writable(false)
/** False when this device cannot keep anything beyond the page. */
export const historyPersistent = writable(true)
/**
 * The note saved a moment ago — the one the list badges as 新.
 *
 * Not persisted and deliberately so: it means "you have not looked at this yet",
 * and a badge that survives a reload is a badge that outlives its own question.
 * It is cleared when the note is opened (`HistoryView`), which is the moment the
 * user has answered it.
 */
export const historyFresh = writable<string | null>(null)

/**
 * The notes of a browser with no OPFS, for as long as the page is open.
 *
 * `null` until something has actually been tried, so that "no OPFS" and "not
 * asked yet" stay different states.
 */
let memory: { entries: Map<string, HistoryEntry>; audio: Map<string, Blob> } | null = null

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(DIR_NAME, { create: true })
  } catch {
    return null
  }
}

/** The origin's own directory — where the live session recording is written. */
async function rootDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await navigator.storage.getDirectory()
  } catch {
    return null
  }
}

async function removeFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name)
  } catch {
    /* already gone */
  }
}

async function readJsonFile<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  try {
    const handle = await dir.getFileHandle(name)
    return JSON.parse(await (await handle.getFile()).text()) as T
  } catch {
    return null
  }
}

async function writeJsonFile(dir: FileSystemDirectoryHandle, name: string, value: unknown): Promise<boolean> {
  try {
    const handle = await dir.getFileHandle(name, { create: true })
    const stream = await handle.createWritable()
    // `JSON.stringify` of a term of transcripts is a few hundred kilobytes, and
    // the stream is what keeps that from being one long string held twice.
    await stream.write(JSON.stringify(value))
    await stream.close()
    return true
  } catch {
    return false
  }
}

/**
 * Puts a finished recording into the note's own file and returns its size.
 *
 * A *move* where the browser can do one, because it is a rename inside the same
 * file system and costs nothing however long the lesson was; a copy where it
 * cannot (Safari has no `move`), which is the same bytes written twice rather
 * than an audio file the user does not get. Returns 0 when the audio could not be
 * stored at all, which the note keeps as "no audio" rather than as a failure.
 */
async function writeAudio(id: string, sourceName: string, audio: Blob): Promise<number> {
  const dir = await directory()
  if (!dir) {
    memory ??= { entries: new Map(), audio: new Map() }
    memory.audio.set(id, audio)
    return audio.size
  }
  const root = await rootDirectory()
  if (root) {
    try {
      // The finished session's file, moved aside by name: the recording sink writes
      // every session to the same `rc-recording.wav` in the root, and this is where
      // that file stops being overwritten by the next one.
      const source = await root.getFileHandle(sourceName)
      const movable = source as unknown as {
        move?: (parent: FileSystemDirectoryHandle, name: string) => Promise<void>
      }
      if (typeof movable.move === 'function') {
        await movable.move(dir, audioName(id))
        return audio.size
      }
    } catch {
      /* no file to move (memory-backed recording, or a sink that never flushed) */
    }
  }
  try {
    const handle = await dir.getFileHandle(audioName(id), { create: true })
    const stream = await handle.createWritable()
    await stream.write(audio)
    await stream.close()
    // The copy leaves the session's own file behind, and a file that is still
    // there is one the *next* session would adopt (`RecordingSink.attach`) and the
    // export button would hand out as if it were the recording just made.
    if (root) await removeFile(root, sourceName)
    return audio.size
  } catch (err) {
    warn('storage', t('这条录音没能存下来：{reason}', { reason: err instanceof Error ? err.message : String(err) }))
    return 0
  }
}

async function persistIndex(list: HistoryMeta[]): Promise<void> {
  const dir = await directory()
  if (!dir) {
    memory ??= { entries: new Map(), audio: new Map() }
    historyPersistent.set(false)
    return
  }
  const ok = await writeJsonFile(dir, INDEX_NAME, list)
  if (!ok) historyPersistent.set(false)
}

/**
 * Reads the index.
 *
 * Called at startup and again when the history view opens — the second call is
 * not redundant: another tab of this app may have filed a note in between, and
 * `index.json` is the only thing that knows about it.
 */
export async function loadHistory(): Promise<HistoryMeta[]> {
  const dir = await directory()
  if (!dir) {
    historyPersistent.set(false)
    const list = memory ? [...memory.entries.values()].map(metaOf) : []
    list.sort((a, b) => b.at - a.at)
    historyList.set(list)
    historyReady.set(true)
    return list
  }
  const stored = (await readJsonFile<HistoryMeta[]>(dir, INDEX_NAME)) ?? []
  const list = stored.filter((meta) => meta && typeof meta.id === 'string').sort((a, b) => b.at - a.at)
  historyList.set(list)
  historyReady.set(true)
  return list
}

function metaOf(entry: HistoryEntry): HistoryMeta {
  const { transcript, ...meta } = entry
  return { ...meta, lines: transcript.length }
}

/**
 * Files a note: its audio first, then the transcript, then the index.
 *
 * In that order because each step can fail on its own and the ones before it are
 * worth more. A note whose transcript was written but whose index entry was not
 * is invisible; a note whose audio arrived and whose transcript did not would be
 * a note that claims to have no words. So the audio goes in first (it is the part
 * that cannot be re-made), then the words, then the pointer to both.
 */
export async function saveEntry(
  entry: HistoryEntry,
  audio: { blob: Blob; name: string } | null,
): Promise<HistoryMeta> {
  const audioBytes = audio && audio.blob.size > 0 ? await writeAudio(entry.id, audio.name, audio.blob) : 0
  const stored: HistoryEntry = { ...entry, audioBytes }
  const dir = await directory()
  if (!dir) {
    memory ??= { entries: new Map(), audio: new Map() }
    memory.entries.set(entry.id, stored)
    historyPersistent.set(false)
  } else if (!(await writeJsonFile(dir, entryName(entry.id), stored))) {
    historyPersistent.set(false)
  }
  historyList.update((list) => [metaOf(stored), ...list.filter((item) => item.id !== stored.id)])
  await persistIndex(get(historyList))
  const meta = metaOf(stored)
  info('storage', t('已存为历史记录：{title}', { title: meta.title }), {
    [t('时长')]: `${Math.round(meta.seconds)} s`,
    [t('句子')]: meta.lines,
    [t('录音文件')]: audioBytes > 0 ? `${(audioBytes / 1024 / 1024).toFixed(1)} MB` : t('没有'),
  })
  return meta
}

/** One note in full, transcript included. */
export async function readEntry(id: string): Promise<HistoryEntry | null> {
  const dir = await directory()
  if (!dir) return memory?.entries.get(id) ?? null
  return await readJsonFile<HistoryEntry>(dir, entryName(id))
}

/** The note's audio, as a blob to play or download. */
export async function readAudio(id: string): Promise<Blob | null> {
  const dir = await directory()
  if (!dir) return memory?.audio.get(id) ?? null
  try {
    const handle = await dir.getFileHandle(audioName(id))
    return await handle.getFile()
  } catch {
    return null
  }
}

/**
 * Renames a note.
 *
 * The stored entry and the index both change, and the second one is why this is
 * not a one-line update: the list renders from the index, so a rename that only
 * touched the entry file would show its old name until the note was opened.
 */
export async function renameEntry(id: string, title: string): Promise<void> {
  const clean = title.trim()
  if (!clean) return
  const dir = await directory()
  if (dir) {
    const entry = await readJsonFile<HistoryEntry>(dir, entryName(id))
    if (entry) await writeJsonFile(dir, entryName(id), { ...entry, title: clean, auto: false })
  } else if (memory) {
    const entry = memory.entries.get(id)
    if (entry) memory.entries.set(id, { ...entry, title: clean, auto: false })
  }
  historyList.update((list) => list.map((item) => (item.id === id ? { ...item, title: clean, auto: false } : item)))
  await persistIndex(get(historyList))
  info('storage', t('已重命名历史记录：{title}', { title: clean }))
}

/**
 * Deletes notes — one, or the many a selection holds.
 *
 * The audio goes first: it is the part that costs the disk, it is the part nobody
 * asked for by name, and a delete interrupted between the two files leaves a note
 * with words and no sound, which is exactly what a note recorded without 「保存整
 * 场录音」 looks like.
 */
export async function deleteEntries(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0
  const dir = await directory()
  for (const id of ids) {
    if (dir) {
      await removeFile(dir, audioName(id))
      await removeFile(dir, entryName(id))
    }
    memory?.audio.delete(id)
    memory?.entries.delete(id)
  }
  const gone = new Set(ids)
  historyList.update((list) => list.filter((item) => !gone.has(item.id)))
  await persistIndex(get(historyList))
  if (get(historyFresh) && gone.has(get(historyFresh)!)) historyFresh.set(null)
  info('storage', t('已删除 {n} 条历史记录', { n: ids.length }))
  return ids.length
}

/** Total bytes the notes hold, for the line above the list. */
export function totalAudioBytes(list: readonly HistoryMeta[]): number {
  return list.reduce((sum, meta) => sum + (meta.audioBytes || 0), 0)
}

/**
 * A note's identity: the moment it started, plus four random characters.
 *
 * Readable and sortable on purpose — a file manager that shows the history
 * directory shows the day it was recorded — and the random tail is there because
 * two notes *can* start in the same second (a session ended and restarted on a
 * double tap) and one of them must not overwrite the other.
 */
export function newId(at: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
  const clock = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  const tail = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `${day}-${clock}-${tail}`
}
