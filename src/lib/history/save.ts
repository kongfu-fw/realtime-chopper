/**
 * Filing the session that just ended.
 *
 * One function, because "save" means the same five things however it is asked
 * for — from the pause panel's 保存, from 开启新录音, or from anywhere else that
 * grows later: stop listening, let the pipeline finish, take the audio and the
 * transcript, write them as a note, and remember which note is the new one.
 *
 * The ordering inside is what makes the failure modes mild:
 *
 *  - the session is stopped *before* the audio is read, because the file's WAV
 *    header is only written by the worker when the recording is closed;
 *  - the entry is written before the "this one is new" flag is raised, so a badge
 *    can never point at a note that is not there.
 */

import { get } from 'svelte/store'
import { session } from '../app/state'
import { RECORDING_FILE_NAME, RECORDING_RATE, WAV_HEADER_BYTES } from '../audio/recorder'
import { currentLang } from '../i18n/index.ts'
import { autoTitle, placeNow } from './place'
import { historyFresh, newId, saveEntry, type HistoryEntry, type HistoryLine } from './store'

/** What filing a session produced, so a caller can say why it filed nothing. */
export type SaveOutcome = 'saved' | 'empty'

/**
 * Ends the session and files it.
 *
 * `title` is what the user typed in the dialog, if they opened one; absent means
 * the generated one, which is what 开启新录音 uses — the user asked for a new
 * recording, not for a naming ceremony.
 */
export async function saveSession(title?: string): Promise<SaveOutcome> {
  const lines = get(session.lines)
  const info = get(session.recording)
  const transcript: HistoryLine[] = lines
    .filter((line) => line.text.trim() !== '')
    .map((line) => ({
      text: line.text,
      translation: line.translation,
      startMs: line.startMs,
      endMs: line.endMs,
    }))
  // The date the note belongs to is when the session started, and it has to be
  // read *before* the stop: `start` stamps it, nothing clears it, but a note filed
  // after a restart must not be dated by the new one.
  const at = session.startedAtMs || Date.now()
  if (get(session.state) === 'recording') await session.pause()
  if (get(session.state) !== 'idle') await session.stop()
  const blob = await session.recordingBlob()

  // How much audio there really is, counted from the file rather than from
  // `recording.bytes`, and the difference is a session shorter than the half
  // second between two of that readout's updates: it produced audio, the number
  // beside the button still says zero, and a note thrown away on it would be a
  // recording somebody watched happen and then lost.
  const audioSeconds =
    blob && blob.size > WAV_HEADER_BYTES
      ? (blob.size - WAV_HEADER_BYTES) / 2 / RECORDING_RATE
      : 0
  // Nothing was said and nothing was recorded: there is no note to file, and a
  // silent one would be a row in the list that opens onto an empty screen.
  if (transcript.length === 0 && audioSeconds <= 0) return 'empty'

  const place = placeNow()
  const named = title?.trim() ?? ''
  const entry: HistoryEntry = {
    id: newId(new Date(at)),
    at,
    seconds: Math.round(Math.max(audioSeconds, info?.seconds ?? 0)),
    title: named || autoTitle(at, place.label),
    auto: named === '',
    place: place.label,
    ...(place.lat !== undefined ? { lat: place.lat } : {}),
    ...(place.lon !== undefined ? { lon: place.lon } : {}),
    audioBytes: 0,
    lines: transcript.length,
    transcript,
  }
  await saveEntry(entry, blob && blob.size > 0 ? { blob, name: RECORDING_FILE_NAME } : null)
  historyFresh.set(entry.id)
  return 'saved'
}

/** The generated title, so a dialog can open with the name the note already has. */
export function generatedTitle(at: number): string {
  return autoTitle(at, placeNow().label, currentLang())
}
