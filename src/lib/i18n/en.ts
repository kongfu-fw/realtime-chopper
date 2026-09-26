import { EN_CORE } from './en/core.ts'
import { EN_SHELL } from './en/shell.ts'

/**
 * English, keyed by the Chinese source string (see `index.ts`).
 *
 * Split in two only to keep the files readable: `shell` is everything a person
 * sees, `core` is the log lines, the diagnostic report and the engine messages.
 * They are one map — a key lives in exactly one of them, and a key that two
 * screens share ('识别', '版本', '失败') lives in whichever file needed it first.
 */
export const EN: Record<string, string> = { ...EN_SHELL, ...EN_CORE }
