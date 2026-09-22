import type { Lang } from '../types'

/**
 * Language code mapping.
 *
 * We always send an explicit source language: the recogniser is per-language by
 * design, so `auto` would only add a second, worse guessing step — short
 * utterances are exactly where language auto-detection gets it wrong, and a
 * wrong guess also poisons the translation cache with entries under the wrong
 * key.
 */

export function googleCode(lang: Lang): string {
  switch (lang) {
    case 'zh':
      return 'zh-CN'
    case 'en':
      return 'en'
    case 'ko':
      return 'ko'
  }
}

export function microsoftCode(lang: Lang): string {
  switch (lang) {
    case 'zh':
      return 'zh-Hans'
    case 'en':
      return 'en'
    case 'ko':
      return 'ko'
  }
}

export function languageName(lang: Lang): string {
  switch (lang) {
    case 'zh':
      return 'Simplified Chinese'
    case 'en':
      return 'English'
    case 'ko':
      return 'Korean'
  }
}
