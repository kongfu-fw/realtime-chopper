/**
 * Saving a transcript to the phone, as text.
 *
 * The transcript is the artifact a lesson leaves behind, and on a phone it is
 * otherwise trapped in a page: nothing can be selected wholesale while new
 * sentences keep arriving, and a screen recording is not a note. So each panel
 * exports *its own column* — the original text from the original panel, the
 * translations from the translation panel — because those are the two things a
 * student might want separately (the English to hand in, the Chinese to revise
 * from), and a single combined file would answer neither of them cleanly.
 *
 * The DOM half (`saveText`) is deliberately at the bottom and deliberately not
 * tested here: `node --test` has no document, and a download is a browser
 * affordance rather than a behaviour with rules.
 */

/** Which column of the transcript is being exported. */
export type TranscriptKind = 'original' | 'translation'

export interface TranscriptLine {
  text: string
  /** `null` until the translation lands, which is most of a row's life. */
  translation: string | null
}

/**
 * One sentence per line, in the order they were spoken, with a trailing newline.
 *
 * Rows that are still empty are left out rather than exported as blanks: a line
 * exists (with its reserved space) before its text arrives, and a file with a
 * hole in it is worse than a file that simply has fewer lines. Whitespace-only
 * text counts as empty for the same reason — a recognised sentence that came back
 * as spaces is not a sentence.
 *
 * Nothing is escaped or normalised beyond that: the text is what was recognised,
 * and a transcript that has been re-wrapped by its exporter is no longer a
 * transcript.
 */
export function transcriptRows(lines: readonly TranscriptLine[], kind: TranscriptKind): string[] {
  const column = kind === 'original' ? 'text' : 'translation'
  const kept: string[] = []
  for (const line of lines) {
    const value = line[column]
    if (typeof value !== 'string' || value.trim() === '') continue
    kept.push(value)
  }
  return kept
}

/** The same rows as one file's worth of text. `''` when there is nothing to save. */
export function transcriptText(lines: readonly TranscriptLine[], kind: TranscriptKind): string {
  const kept = transcriptRows(lines, kind)
  return kept.length ? `${kept.join('\n')}\n` : ''
}

/**
 * A file name that says what is inside it and when it was exported.
 *
 * Local time, formatted `YYYYMMDD-HHMM`: the export happens on the phone that
 * recorded the lesson, in that phone's timezone, and two exports from one
 * morning must both survive a downloads folder. The two words are spelled in
 * English rather than in the interface language, because this string travels out
 * of the app — into a ZIP, a chat, an upload — where the reader's language is
 * nobody's decision.
 */
export function exportFileName(kind: TranscriptKind, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`
  return `realtime-chopper-${kind}-${stamp}.txt`
}

/**
 * Hands a text file to the browser's download machinery.
 *
 * An object URL rather than a `data:` URI: a lesson's worth of text is a few
 * hundred kilobytes, and a data URI of that size is a string the browser has to
 * copy twice. The URL is revoked on a delay rather than immediately — Safari
 * starts the download asynchronously, and revoking before it has read the blob
 * produces a file that is not there.
 */
export function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
