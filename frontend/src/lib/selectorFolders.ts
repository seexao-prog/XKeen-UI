/**
 * «Папки для селекторов» — чисто визуальная группировка селекторов mihomo в панели.
 * Конфиг ядра не меняется: папки хранятся в настройках панели, `ui.selector_folders` в /api/settings.
 */
import { create } from 'zustand'
import { apiCall } from './api'
import { getAppState } from './store'
import type { SelectorFolder } from './types'

export const FOLDER_NAME_MAX = 40
const COLLAPSED_KEY = 'xkeen-ui:selector-folders-collapsed'

/** Приводит ответ /api/settings (`ui.selector_folders`) к массиву папок. */
export function normalizeSelectorFolders(raw: unknown): SelectorFolder[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      id: String(f.id ?? '').trim(),
      name: String(f.name ?? '').trim(),
      icon: typeof f.icon === 'string' ? f.icon : '',
      groups: Array.isArray(f.groups) ? f.groups.map((g) => String(g)).filter(Boolean) : [],
    }))
    .filter((f) => f.id && f.name)
}

/** Ошибка валидации (те же правила, что на бэкенде) или null. */
export function validateFolders(folders: SelectorFolder[]): string | null {
  const ids = new Set<string>()
  const owner = new Map<string, string>()
  for (const f of folders) {
    const name = f.name.trim()
    if (!name) return 'Имя папки не может быть пустым'
    if ([...name].length > FOLDER_NAME_MAX) return `Имя папки «${name}» длиннее ${FOLDER_NAME_MAX} символов`
    if (!f.id.trim()) return `У папки «${name}» нет id`
    if (ids.has(f.id)) return `id папки «${f.id}» повторяется`
    ids.add(f.id)
    for (const g of f.groups) {
      const prev = owner.get(g)
      if (prev !== undefined) return `Селектор «${g}» уже лежит в папке «${prev}»`
      owner.set(g, name)
    }
  }
  return null
}

/** Уникальный id из имени: латиница/цифры, иначе случайный. */
export function makeFolderId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || `f-${Math.random().toString(36).slice(2, 8)}`
  let id = base
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`
  return id
}

/** Сохраняет папки в настройки панели (PATCH /api/settings) и обновляет стор. Возвращает текст ошибки или null. */
export async function saveSelectorFolders(folders: SelectorFolder[]): Promise<string | null> {
  const clean = folders.map((f) => ({
    id: f.id.trim(),
    name: f.name.trim(),
    icon: f.icon.trim(),
    groups: [...new Set(f.groups.map((g) => g.trim()).filter(Boolean))],
  }))
  const err = validateFolders(clean)
  if (err) return err
  try {
    const res = await apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { ui: { selector_folders: clean } })
    if (!res?.success) return res?.error || 'Не удалось сохранить папки'
  } catch (e) {
    return (e as Error).message || 'Не удалось сохранить папки'
  }
  getAppState().dispatch({ type: 'SET_SETTINGS', settings: { selectorFolders: clean } })
  return null
}

/** Кладёт селектор в папку (или убирает из всех при folderId = null), сохраняя остальное. */
export function moveGroupToFolder(folders: SelectorFolder[], group: string, folderId: string | null): SelectorFolder[] {
  return folders.map((f) => {
    const without = f.groups.filter((g) => g !== group)
    return f.id === folderId ? { ...f, groups: [...without, group] } : { ...f, groups: without }
  })
}

export function folderOfGroup(folders: SelectorFolder[], group: string): SelectorFolder | null {
  return folders.find((f) => f.groups.includes(group)) ?? null
}

// ─── Раскладка панели ────────────────────────────────────────────────────────

export type SelectorLayoutItem<T> = { kind: 'selector'; item: T } | { kind: 'folder'; folder: SelectorFolder; items: T[] }

/**
 * Раскладывает видимые селекторы с учётом папок. Папка встаёт на место первого видимого селектора,
 * который в неё входит; внутри — в порядке, заданном в папке. Отсутствующие имена пропускаются,
 * пустые (после фильтров) папки не показываются.
 */
export function layoutSelectors<T>(items: T[], getName: (t: T) => string, folders: SelectorFolder[]): SelectorLayoutItem<T>[] {
  if (!folders.length) return items.map((item) => ({ kind: 'selector', item }))
  const byName = new Map(items.map((t) => [getName(t), t]))
  const folderOf = new Map<string, SelectorFolder>()
  for (const f of folders) for (const g of f.groups) if (!folderOf.has(g)) folderOf.set(g, f)
  const out: SelectorLayoutItem<T>[] = []
  const placed = new Set<string>()
  for (const t of items) {
    const f = folderOf.get(getName(t))
    if (!f) {
      out.push({ kind: 'selector', item: t })
      continue
    }
    if (placed.has(f.id)) continue
    placed.add(f.id)
    const inside = f.groups.map((g) => byName.get(g)).filter((x): x is T => x !== undefined)
    if (inside.length) out.push({ kind: 'folder', folder: f, items: inside })
  }
  return out
}

// ─── Свёрнутость (per browser) ───────────────────────────────────────────────

function readCollapsed(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export const useFolderCollapse = create<{
  collapsed: Record<string, boolean>
  toggle: (id: string) => void
  set: (id: string, v: boolean) => void
}>((set, get) => ({
  collapsed: readCollapsed(),
  toggle: (id) => get().set(id, !get().collapsed[id]),
  set: (id, v) => {
    const next = { ...get().collapsed, [id]: v }
    if (!v) delete next[id]
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
    } catch {
      /* приватный режим — просто не запоминаем */
    }
    set({ collapsed: next })
  },
}))

/** Какой селектор предложить к переносу при открытии модалки («Переместить в папку…»). */
export const useFoldersModalFocus = create<{ group: string | null; nonce: number }>(() => ({ group: null, nonce: 0 }))

/** Открыть модалку управления папками; `group` — сразу предложить переместить этот селектор. */
export function openSelectorFoldersModal(group?: string) {
  useFoldersModalFocus.setState((s) => ({ group: group ?? null, nonce: s.nonce + 1 }))
  setTimeout(() => getAppState().dispatch({ type: 'SHOW_MODAL', modal: 'showSelectorFoldersModal', show: true }), 0)
}
