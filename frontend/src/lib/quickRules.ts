import { create } from 'zustand'
import { apiCall } from './api'
import { getAppState } from './store'

export type QuickRuleKind = 'domain' | 'full' | 'keyword' | 'regexp' | 'geosite' | 'ip' | 'cidr' | 'geoip'
export type QuickTargetType = 'direct' | 'block' | 'proxy'

export interface QuickRuleTarget {
  type: QuickTargetType
  tag: string
}

export interface QuickRule {
  id: string
  value: string
  kind: QuickRuleKind
  target: QuickRuleTarget
  enabled: boolean
  comment: string
  created: number
}

export interface QuickTargetItem {
  tag: string
  kind: 'outbound' | 'balancer' | 'group' | 'proxy' | 'builtin'
  protocol?: string
}

export interface QuickRulesResponse {
  success: boolean
  error?: string
  core?: 'xray' | 'mihomo'
  rules?: QuickRule[]
  targets?: { items: QuickTargetItem[]; directTag?: string | null; blockTag?: string | null; routingFile?: string }
  warnings?: string[]
  warning?: string | null
}

export const KIND_LABELS: Record<QuickRuleKind, string> = {
  domain: 'Домен',
  full: 'Точный домен',
  keyword: 'Ключевое слово',
  regexp: 'Регулярное выражение',
  geosite: 'Geosite',
  ip: 'IP-адрес',
  cidr: 'Подсеть',
  geoip: 'GeoIP',
}

export const KIND_HINTS: Record<QuickRuleKind, string> = {
  domain: 'вместе с поддоменами',
  full: 'только этот адрес',
  keyword: 'домены, содержащие слово',
  regexp: 'по шаблону',
  geosite: 'категория из geosite',
  ip: '',
  cidr: '',
  geoip: 'страна/категория из geoip',
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:.]*$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/
const PREFIXES: [string, QuickRuleKind][] = [
  ['geosite:', 'geosite'],
  ['geoip:', 'geoip'],
  ['keyword:', 'keyword'],
  ['regexp:', 'regexp'],
  ['full:', 'full'],
  ['domain:', 'domain'],
]

function isIp(value: string): boolean {
  return IPV4.test(value) || (IPV6.test(value) && value.split(':').length >= 3)
}

/** Разбирает одну строку ввода в вид правила. Возвращает ошибку, если ввод некорректен. */
export function detectRule(raw: string, exact: boolean): { kind: QuickRuleKind; value: string } | { error: string } {
  let value = raw.trim()
  if (!value) return { error: 'Пустое значение' }
  for (const [prefix, kind] of PREFIXES) {
    if (value.toLowerCase().startsWith(prefix)) {
      const rest = value.slice(prefix.length).trim()
      if (!rest) return { error: `Не указано значение после «${prefix}»` }
      return { kind, value: kind === 'regexp' ? rest : rest.toLowerCase() }
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).hostname
    } catch {
      return { error: `Некорректный адрес «${raw}»` }
    }
  }
  value = value.replace(/^\[|\]$/g, '')
  if (value.includes('/')) {
    const [ip, mask] = value.split('/')
    if (isIp(ip) && /^\d{1,3}$/.test(mask)) return { kind: 'cidr', value: `${ip}/${mask}` }
    value = value.split('/')[0]
  }
  if (isIp(value)) return { kind: 'ip', value }
  const domain = value.toLowerCase().replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '').replace(/:\d+$/, '')
  let ascii = domain
  try {
    ascii = new URL(`http://${domain}`).hostname
  } catch {
    /* оставляем как есть, ниже проверим */
  }
  if (!DOMAIN.test(ascii) || !ascii.includes('.')) return { error: `Некорректный домен «${raw.trim()}»` }
  return { kind: exact ? 'full' : 'domain', value: ascii }
}

/** Делит пачку ввода: перенос строки, запятая, пробел, точка с запятой. */
export function splitInput(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function targetKey(target: QuickRuleTarget): string {
  return target.type === 'proxy' ? `proxy:${target.tag}` : target.type
}

export function parseTargetKey(key: string): QuickRuleTarget {
  if (key.startsWith('proxy:')) return { type: 'proxy', tag: key.slice(6) }
  return { type: key === 'block' ? 'block' : 'direct', tag: '' }
}

export function newRuleId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function fetchQuickRules(core?: string) {
  return apiCall<QuickRulesResponse>('GET', core ? `quick-rules?core=${encodeURIComponent(core)}` : 'quick-rules')
}

export function saveQuickRules(core: string, rules: QuickRule[]) {
  return apiCall<QuickRulesResponse>('PUT', 'quick-rules', { core, rules })
}

// ─── Открытие модалки с предзаполненным доменом (из соединений / проверки маршрута) ───

export const useQuickRulesPrefill = create<{ value: string; nonce: number }>(() => ({ value: '', nonce: 0 }))

export function openQuickRules(prefill?: string) {
  if (prefill) useQuickRulesPrefill.setState((s) => ({ value: prefill, nonce: s.nonce + 1 }))
  setTimeout(() => getAppState().dispatch({ type: 'SHOW_MODAL', modal: 'showQuickRulesModal', show: true }), 0)
}
