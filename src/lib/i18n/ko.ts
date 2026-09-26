import { KO_CORE } from './ko/core.ts'
import { KO_SHELL } from './ko/shell.ts'

/**
 * Korean, keyed by the Chinese source string (see `index.ts`).
 *
 * Split in two only to keep the files readable: `shell` is everything a person
 * sees, `core` is the log lines, the diagnostic report and the engine messages.
 * They are one map — a key lives in exactly one of them, and a key that two
 * screens share ('识别', '版本', '失败') lives in whichever file needed it first.
 */
export const KO: Record<string, string> = { ...KO_SHELL, ...KO_CORE }
