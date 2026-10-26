import type { ComponentType } from 'react'
import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * Реестр команд для командной палитры (Ctrl/Cmd+K) и глобальных горячих клавиш.
 *
 * Команды поставляются «провайдерами» — функциями, которые вызываются в момент построения списка
 * и потому всегда видят актуальное состояние компонента. Любой компонент может добавить свои
 * команды через `useCommandProvider('id', () => [...])`, а не-React код — через `registerCommandProvider`.
 */

/** Сочетание клавиш в нотации `Mod+Shift+K`. `Mod` = Cmd на macOS и Ctrl на остальных ОС. */
export type Shortcut = string

export interface AppCommand {
  /** Уникальный id, по нему команду можно вызвать из горячих клавиш: `executeCommand('config.save')` */
  id: string
  title: string
  /** Заголовок группы в палитре. Известные группы сортируются по `COMMAND_GROUP_ORDER`, остальные — в конце. */
  group: string
  /** Дополнительные слова для поиска (синонимы, английские названия). */
  keywords?: string[]
  shortcut?: Shortcut
  icon?: ComponentType<{ className?: string }>
  disabled?: boolean
  /** Показывается тостом, если команду пытаются вызвать горячей клавишей, пока она недоступна. */
  disabledReason?: string
  run: () => void | Promise<void>
}

export type CommandProvider = () => AppCommand[]

export const COMMAND_GROUP_ORDER = ['Конфигурация', 'Сервис', 'Файлы', 'Утилиты', 'Навигация', 'Внешний вид']

const providers = new Map<string, CommandProvider>()
const listeners = new Set<() => void>()
let version = 0

function emit() {
  version++
  listeners.forEach((l) => l())
}

export function registerCommandProvider(id: string, provider: CommandProvider): () => void {
  providers.set(id, provider)
  emit()
  return () => {
    if (providers.get(id) === provider) {
      providers.delete(id)
      emit()
    }
  }
}

/** Сообщить палитре, что состояние, от которого зависят команды, изменилось. */
export function notifyCommandsChanged() {
  emit()
}

export function subscribeCommands(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCommandsVersion() {
  return version
}

export function getCommands(): AppCommand[] {
  const all: AppCommand[] = []
  for (const provider of providers.values()) {
    try {
      all.push(...provider())
    } catch {
      /* сломанный провайдер не должен ломать палитру */
    }
  }
  const rank = (g: string) => {
    const i = COMMAND_GROUP_ORDER.indexOf(g)
    return i === -1 ? COMMAND_GROUP_ORDER.length : i
  }
  return all.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.group) - rank(b.c.group) || a.i - b.i).map((x) => x.c)
}

export function findCommand(id: string): AppCommand | undefined {
  return getCommands().find((c) => c.id === id)
}

export type ExecuteResult = 'ok' | 'missing' | 'disabled'

/** Выполнить команду по id. Возвращает `missing`, если такой команды сейчас нет (например, панель не смонтирована). */
export function executeCommand(id: string): ExecuteResult {
  const cmd = findCommand(id)
  if (!cmd) return 'missing'
  if (cmd.disabled) return 'disabled'
  void cmd.run()
  return 'ok'
}

/**
 * Подключает провайдер команд на время жизни компонента. Функция-провайдер может замыкаться на
 * свежие props/state: хук хранит её в ref и вызывает актуальную версию при каждом построении списка.
 */
export function useCommandProvider(id: string, provider: CommandProvider) {
  const ref = useRef(provider)
  // Без notify: иначе палитра (подписчик) и провайдеры в ней же зацикливаются.
  // Актуальность обеспечивается тем, что список строится заново при каждом рендере палитры и при вызове команды.
  useEffect(() => {
    ref.current = provider
  })
  useEffect(() => registerCommandProvider(id, () => ref.current()), [id])
}

export const OPEN_PALETTE_EVENT = 'xkeen:open-command-palette'

/** Открыть командную палитру из любого места (кнопка в шапке и т.п.). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))
}

export function useCommands(enabled = true): AppCommand[] {
  useSyncExternalStore(subscribeCommands, getCommandsVersion)
  return enabled ? getCommands() : []
}

// ─── Горячие клавиши ───

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)

const KEY_LABELS: Record<string, { mac: string; other: string }> = {
  Mod: { mac: '⌘', other: 'Ctrl' },
  Ctrl: { mac: '⌃', other: 'Ctrl' },
  Shift: { mac: '⇧', other: 'Shift' },
  Alt: { mac: '⌥', other: 'Alt' },
  Enter: { mac: '↵', other: 'Enter' },
  Escape: { mac: 'Esc', other: 'Esc' },
}

/** `Mod+Enter` → `['⌘', '↵']` на macOS, `['Ctrl', 'Enter']` на остальных ОС. */
export function shortcutKeys(shortcut: Shortcut): string[] {
  return shortcut.split('+').map((k) => {
    const label = KEY_LABELS[k]
    if (label) return isMac ? label.mac : label.other
    return k.length === 1 ? k.toUpperCase() : k
  })
}

export function formatShortcut(shortcut: Shortcut): string {
  return shortcutKeys(shortcut).join(isMac ? '' : '+')
}

/** Проверка `KeyboardEvent` на сочетание. Буквы сравниваются по `event.code`, чтобы работало в русской раскладке. */
export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  const parts = shortcut.split('+')
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (mods.has('Mod') !== mod) return false
  if (mods.has('Shift') !== event.shiftKey) return false
  if (mods.has('Alt') !== event.altKey) return false
  if (key.length === 1 && /[a-z]/i.test(key)) return event.code === `Key${key.toUpperCase()}`
  return event.key === key
}
