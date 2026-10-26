import { create } from 'zustand'

/**
 * Локальные (в браузере) настройки интерфейса, которые не нужно хранить на роутере.
 * Отдельный маленький store, чтобы не трогать общий AppSettings / store.ts.
 */

const DIFF_KEY = 'showDiffBeforeApply'

function readBool(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* приватный режим и т.п. */
  }
}

interface UiPrefsState {
  /** Показывать diff перед «Сохранить» / «Применить». По умолчанию включено. */
  showDiffBeforeApply: boolean
  setShowDiffBeforeApply: (value: boolean) => void
}

export const useUiPrefs = create<UiPrefsState>((set) => ({
  showDiffBeforeApply: readBool(DIFF_KEY, true),
  setShowDiffBeforeApply: (value) => {
    writeBool(DIFF_KEY, value)
    set({ showDiffBeforeApply: value })
  },
}))
