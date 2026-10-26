import { useEffect } from 'react'
import { create } from 'zustand'
import { apiCall } from './api'

export type NotifyEvents = { service_down: boolean; service_up: boolean; server_down: boolean; update_available: boolean }

export type TelegramSettings = {
  enabled: boolean
  bot_token: string
  chat_id: string
  api_base: string
  events: NotifyEvents
  cooldown_minutes: number
}

export type ScheduledTask = { enabled: boolean; time: string }
export type SchedulerSettings = {
  geo_update: ScheduledTask & { command: string }
  restart_core: ScheduledTask
  backup: ScheduledTask & { keep: number }
}

export type Subscription = { name: string; url: string; enabled: boolean; interval_hours: number; user_agent: string }

export type UptimeSettings = { enabled: boolean; interval_minutes: number }

export type AutomationSettings = {
  notify: { telegram: TelegramSettings }
  scheduler: SchedulerSettings
  subscriptions: { items: Subscription[] }
  uptime: UptimeSettings
}

export const DEFAULT_TG_API = 'https://api.telegram.org'
export const DEFAULT_GEO_COMMAND = '/opt/sbin/xkeen -ug'

export const DEFAULT_AUTOMATION: AutomationSettings = {
  notify: {
    telegram: {
      enabled: false,
      bot_token: '',
      chat_id: '',
      api_base: DEFAULT_TG_API,
      events: { service_down: true, service_up: true, server_down: true, update_available: true },
      cooldown_minutes: 30,
    },
  },
  scheduler: {
    geo_update: { enabled: false, time: '04:30', command: DEFAULT_GEO_COMMAND },
    restart_core: { enabled: false, time: '05:00' },
    backup: { enabled: false, time: '03:30', keep: 7 },
  },
  subscriptions: { items: [] },
  uptime: { enabled: false, interval_minutes: 10 },
}

function mergeDefaults<T>(defaults: T, value: unknown): T {
  if (Array.isArray(defaults)) return (Array.isArray(value) ? value : defaults) as T
  if (defaults && typeof defaults === 'object') {
    const src = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(defaults as Record<string, unknown>)) out[k] = mergeDefaults(v, src[k])
    return out as T
  }
  return (value === undefined || value === null ? defaults : value) as T
}

type AutomationStore = {
  data: AutomationSettings
  loaded: boolean
  set: (data: AutomationSettings) => void
}

const useAutomationStore = create<AutomationStore>((set) => ({
  data: DEFAULT_AUTOMATION,
  loaded: false,
  set: (data) => set({ data, loaded: true }),
}))

/** Загружает секцию automation из /api/settings (один раз за сессию). */
export function useAutomation() {
  const { data, loaded, set } = useAutomationStore()
  useEffect(() => {
    if (loaded) return
    apiCall<any>('GET', 'settings')
      .then((res) => res?.success && set(mergeDefaults(DEFAULT_AUTOMATION, res.automation)))
      .catch(() => {})
  }, [loaded, set])
  return { automation: data, loaded }
}

/**
 * Сохраняет изменённую часть секции automation через PATCH /api/settings (deep-merge на бэкенде).
 * Массивы (подписки) передаются целиком. Возвращает ошибку или null.
 */
export async function patchAutomation(patch: Partial<{ [K in keyof AutomationSettings]: unknown }>): Promise<string | null> {
  try {
    const res = await apiCall<any>('PATCH', 'settings', { automation: patch })
    if (!res?.success) return res?.error || 'Ошибка сохранения'
    const fresh = await apiCall<any>('GET', 'settings')
    if (fresh?.success) useAutomationStore.getState().set(mergeDefaults(DEFAULT_AUTOMATION, fresh.automation))
    return null
  } catch (e: any) {
    return e?.message || 'Ошибка сохранения'
  }
}

// ─── Uptime ───────────────────────────────────────────────────────────────────

export type UptimeData = {
  enabled: boolean
  interval_minutes: number
  now: number
  window_secs: number
  last_run: number | null
  last_error: string | null
  history: Record<string, [number, number][]>
}

type UptimeStore = { data: UptimeData | null; fetchedAt: number; set: (d: UptimeData) => void }
const useUptimeStore = create<UptimeStore>((set) => ({ data: null, fetchedAt: 0, set: (data) => set({ data, fetchedAt: Date.now() }) }))

let uptimeInflight: Promise<void> | null = null
function refreshUptime() {
  if (uptimeInflight) return uptimeInflight
  uptimeInflight = apiCall<any>('GET', 'uptime')
    .then((res) => {
      if (res?.success) useUptimeStore.getState().set(res as UptimeData)
    })
    .catch(() => {})
    .finally(() => {
      uptimeInflight = null
    })
  return uptimeInflight
}

let uptimeSubscribers = 0
let uptimeTimer: number | null = null

/** История аптайма: один общий опрос раз в минуту на все карточки, пока есть хотя бы один подписчик. */
export function useUptime(): UptimeData | null {
  const data = useUptimeStore((s) => s.data)
  useEffect(() => {
    uptimeSubscribers++
    if (Date.now() - useUptimeStore.getState().fetchedAt > 30_000) void refreshUptime()
    if (uptimeTimer === null) uptimeTimer = window.setInterval(() => void refreshUptime(), 60_000)
    return () => {
      uptimeSubscribers--
      if (uptimeSubscribers === 0 && uptimeTimer !== null) {
        window.clearInterval(uptimeTimer)
        uptimeTimer = null
      }
    }
  }, [])
  return data
}

export function formatAgo(ts: number | null | undefined, nowSec = Date.now() / 1000): string {
  if (!ts) return 'никогда'
  const d = Math.max(0, Math.round(nowSec - ts))
  if (d < 60) return 'только что'
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`
  return `${Math.floor(d / 86400)} д назад`
}
