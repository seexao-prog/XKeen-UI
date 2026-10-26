// «Группы прокси»: модель, построение изменений конфигов и построчный diff.
//
// Бэкенд (/api/proxy-groups/preview) считает план: какие балансировщики/группы вписать, какие
// чужие селекторы сузить, что сделать с наблюдателем. Здесь план превращается в новые тексты
// файлов с сохранением комментариев и форматирования (jsonc-parser modify для Xray, точечные
// правки по диапазонам YAML-узлов для Mihomo) — пользователь видит diff и подтверждает.

import { applyEdits, modify, parse as parseJsonc, type FormattingOptions, type JSONPath } from 'jsonc-parser'
import { Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'

export type XrayStrategy = 'smart' | 'leastLoad' | 'leastPing' | 'roundRobin' | 'random'
export type MihomoStrategy = 'smart' | 'url-test' | 'fallback' | 'load-balance' | 'select'

export interface GroupMember {
  name: string
  provider?: string
}

export interface GroupSettings {
  expected?: number | null
  max_rtt?: string | null
  tolerance?: number | null
  baselines?: string[]
  costs?: Record<string, number>
  url?: string | null
  interval?: number | null
  mihomo_tolerance?: number | null
  lazy?: boolean | null
  timeout?: number | null
  max_failed_times?: number | null
  lb_strategy?: string | null
}

export interface ProxyGroup {
  id: string
  name: string
  tag: string
  core: 'xray' | 'mihomo'
  members: GroupMember[]
  strategy: string
  exclusive: boolean
  enabled: boolean
  fallback: string
  settings: GroupSettings
}

export interface Observer {
  destination: string
  interval: string
  sampling: number
  timeout: string
}

export interface Managed {
  mihomo_excludes: Record<string, string>
}

export interface XrayInventory {
  outbounds: { tag: string; protocol: string; file: string }[]
  routing_file: string | null
  balancers: { tag: string; selector: string[]; strategy: string; fallback: string }[]
  rule_balancer_refs: string[]
  burst_observatory_file: string | null
  observatory_file: string | null
  observer_selectors: string[]
  api_addr: string | null
  freedom_tags: string[]
  parse_errors: string[]
}

export interface MihomoInventory {
  proxies: string[]
  providers: string[]
  groups: { name: string; type: string; proxies: string[]; use: string[]; include_all: boolean; filter: string; exclude_filter: string }[]
  rule_targets: string[]
  parse_error: string | null
}

export interface SelectorFix {
  balancer: string
  old: string[]
  new: string[]
  unresolved: string[]
}

export interface Collision {
  group: string
  member: string
  others: string[]
  suggested: string
}

export interface XrayPlan {
  routing_file: string | null
  balancers: unknown[]
  strip_tags: string[]
  selector_fixes: SelectorFix[]
  observer_mode: 'none' | 'own' | 'extend'
  observer_file: string | null
  observer_key: string
  observer_selectors: string[]
  own_file: string
  own_file_content: unknown | null
  collisions: Collision[]
  warnings: string[]
  errors: string[]
}

export interface MihomoFix {
  group: string
  remove_proxies: string[]
  exclude_remove: string | null
  exclude_add: string | null
}

export interface MihomoPlan {
  file: string
  groups: Record<string, unknown>[]
  strip_names: string[]
  fixes: MihomoFix[]
  managed: Managed
  warnings: string[]
  errors: string[]
}

export interface FileChange {
  file: string
  before: string | null
  after: string | null
}

export const XRAY_STRATEGIES: { id: XrayStrategy; title: string; hint: string; observer: boolean }[] = [
  {
    id: 'smart',
    title: 'Умная',
    hint: 'Держит 2 самых стабильных сервера с ровным пингом и чередует их. Не дёргает соединения из-за мелких колебаний, отбрасывает узлы с потерями >25% и пингом >1,5 с. Подходит почти всегда.',
    observer: true,
  },
  {
    id: 'leastPing',
    title: 'Минимальный пинг',
    hint: 'Всегда самый быстрый по последнему замеру. Может часто переключаться, если пинги близки.',
    observer: true,
  },
  {
    id: 'leastLoad',
    title: 'Наименьшая нагрузка (вручную)',
    hint: 'Штатный leastLoad Xray с вашими параметрами: сколько узлов держать, допустимые потери, пороги разброса пинга, веса.',
    observer: true,
  },
  {
    id: 'roundRobin',
    title: 'По кругу',
    hint: 'Новые соединения по очереди на каждый сервер. Без замеров, равномерная нагрузка. С резервом — пропускает мёртвые узлы.',
    observer: false,
  },
  { id: 'random', title: 'Случайно', hint: 'Случайный сервер на каждое соединение. Без замеров.', observer: false },
]

export const MIHOMO_STRATEGIES: { id: MihomoStrategy; title: string; hint: string }[] = [
  {
    id: 'smart',
    title: 'Умная',
    hint: 'Тип smart (если ядро его поддерживает) — сам учится на реальном трафике. Иначе url-test с гистерезисом 50 мс и ленивой проверкой раз в 5 мин.',
  },
  { id: 'url-test', title: 'Минимальный пинг', hint: 'Самый быстрый по проверке URL; переключается, только если выигрыш больше допуска.' },
  { id: 'fallback', title: 'Резервирование', hint: 'Первый живой сервер по порядку. Удобно: основной + запасные.' },
  { id: 'load-balance', title: 'Балансировка', hint: 'Распределение соединений: по хэшу домена, по кругу или «липкие» сессии.' },
  { id: 'select', title: 'Ручной выбор', hint: 'Без автоматики — сервер выбирается вручную во вкладке селекторов.' },
]

export function emptyGroup(core: 'xray' | 'mihomo'): ProxyGroup {
  return { id: '', name: '', tag: '', core, members: [], strategy: 'smart', exclusive: true, enabled: true, fallback: '', settings: {} }
}

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/** Совпадает с бэкендом (proxy_groups::slugify): `grp-<slug>`. */
export function slugify(name: string): string {
  let s = ''
  for (const ch of name.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) s += ch
    else if (ch in TRANSLIT) s += TRANSLIT[ch]
    else if (!s.endsWith('-')) s += '-'
  }
  s = s
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `grp-${s || 'group'}`
}

export const isValidTag = (tag: string) => /^[A-Za-z0-9._-]{1,64}$/.test(tag)

// ─── JSONC / Xray ─────────────────────────────────────────────────────────────────────────────

function detectFormatting(text: string): FormattingOptions {
  const m = /\n([ \t]+)"/.exec(text)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (m?.[1].startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol }
  return { insertSpaces: true, tabSize: m ? Math.min(m[1].length, 8) : 2, eol }
}

function setJson(text: string, path: JSONPath, value: unknown): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions: detectFormatting(text) }))
}

function safeParse(text: string): any {
  try {
    return parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false }) ?? {}
  } catch {
    return {}
  }
}

const renameIn = (list: unknown, renames: Record<string, string>) =>
  Array.isArray(list) ? list.map((x) => (typeof x === 'string' && renames[x] ? renames[x] : x)) : list

/** Переименование тегов outbound во всех местах, где на них ссылаются. */
export function renameXrayTags(text: string, renames: Record<string, string>): string {
  if (!Object.keys(renames).length) return text
  let out = text
  const json = safeParse(text)
  const outbounds: any[] = Array.isArray(json.outbounds) ? json.outbounds : []
  outbounds.forEach((o, i) => {
    if (o?.tag && renames[o.tag]) out = setJson(out, ['outbounds', i, 'tag'], renames[o.tag])
    const pt = o?.proxySettings?.tag
    if (pt && renames[pt]) out = setJson(out, ['outbounds', i, 'proxySettings', 'tag'], renames[pt])
    const dp = o?.streamSettings?.sockopt?.dialerProxy
    if (dp && renames[dp]) out = setJson(out, ['outbounds', i, 'streamSettings', 'sockopt', 'dialerProxy'], renames[dp])
  })
  const rules: any[] = Array.isArray(json.routing?.rules) ? json.routing.rules : []
  rules.forEach((r, i) => {
    if (r?.outboundTag && renames[r.outboundTag]) out = setJson(out, ['routing', 'rules', i, 'outboundTag'], renames[r.outboundTag])
  })
  const balancers: any[] = Array.isArray(json.routing?.balancers) ? json.routing.balancers : []
  balancers.forEach((b, i) => {
    if (Array.isArray(b?.selector) && b.selector.some((s: string) => renames[s]))
      out = setJson(out, ['routing', 'balancers', i, 'selector'], renameIn(b.selector, renames))
    if (b?.fallbackTag && renames[b.fallbackTag]) out = setJson(out, ['routing', 'balancers', i, 'fallbackTag'], renames[b.fallbackTag])
  })
  for (const key of ['observatory', 'burstObservatory']) {
    const sel = json[key]?.subjectSelector
    if (Array.isArray(sel) && sel.some((s: string) => renames[s])) out = setJson(out, [key, 'subjectSelector'], renameIn(sel, renames))
  }
  return out
}

export function buildXrayChanges(
  files: { file: string; content: string }[],
  plan: XrayPlan,
  renames: Record<string, string>,
  acceptedFixes: Set<string>
): { changes: FileChange[]; deletes: string[] } {
  const map = new Map(files.map((f) => [f.file, f.content]))
  const next = new Map(map)

  for (const [file, content] of map) {
    if (file === plan.own_file) continue
    const r = renameXrayTags(content, renames)
    if (r !== content) next.set(file, r)
  }

  if (plan.routing_file) {
    const text = next.get(plan.routing_file) ?? '{}'
    const json = safeParse(text)
    const strip = new Set(plan.strip_tags)
    const fixes = new Map(plan.selector_fixes.filter((f) => acceptedFixes.has(f.balancer)).map((f) => [f.balancer, f.new]))
    const current: any[] = Array.isArray(json.routing?.balancers) ? json.routing.balancers : []
    let out = text
    // Правим точечно, чтобы сохранить комментарии внутри чужих балансировщиков.
    current.forEach((b, i) => {
      if (fixes.has(b?.tag)) out = setJson(out, ['routing', 'balancers', i, 'selector'], fixes.get(b.tag))
    })
    const removeIdx = current.map((b, i) => (strip.has(b?.tag) ? i : -1)).filter((i) => i >= 0)
    for (const i of removeIdx.reverse()) out = setJson(out, ['routing', 'balancers', i], undefined)
    const remaining = current.filter((b) => !strip.has(b?.tag)).length
    if (plan.balancers.length) {
      if (!Array.isArray(json.routing?.balancers)) out = setJson(out, ['routing', 'balancers'], plan.balancers)
      else plan.balancers.forEach((b, k) => (out = setJson(out, ['routing', 'balancers', remaining + k], b)))
    } else if (Array.isArray(json.routing?.balancers) && remaining === 0 && current.length > 0) {
      out = setJson(out, ['routing', 'balancers'], undefined)
    }
    if (out !== text) next.set(plan.routing_file, out)
  }

  if (plan.observer_mode === 'extend' && plan.observer_file && plan.observer_file !== plan.own_file) {
    const text = next.get(plan.observer_file) ?? '{}'
    const out = setJson(text, [plan.observer_key, 'subjectSelector'], plan.observer_selectors)
    if (out !== text) next.set(plan.observer_file, out)
  }

  const deletes: string[] = []
  const ownBefore = map.get(plan.own_file) ?? null
  if (plan.own_file_content) {
    const content =
      '// Создано XKeen UI («Группы прокси»). Не редактируйте вручную — файл перезаписывается панелью.\n' +
      JSON.stringify(plan.own_file_content, null, 2) +
      '\n'
    next.set(plan.own_file, content)
  } else if (ownBefore !== null) {
    next.delete(plan.own_file)
    deletes.push(plan.own_file)
  }

  const changes: FileChange[] = []
  for (const [file, after] of next) {
    const before = map.get(file) ?? null
    if (before !== after) changes.push({ file, before, after })
  }
  for (const d of deletes) changes.push({ file: d, before: ownBefore, after: null })
  changes.sort((a, b) => a.file.localeCompare(b.file))
  return { changes, deletes }
}

/** Outbound-объекты по тегам из всех JSON-конфигов (для пинга участников). */
export function xrayOutboundsByTag(files: { file: string; content: string }[]): Map<string, any> {
  const res = new Map<string, any>()
  for (const f of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    const json = safeParse(f.content)
    if (Array.isArray(json.outbounds)) for (const o of json.outbounds) if (o?.tag) res.set(o.tag, o)
  }
  return res
}

// ─── YAML / Mihomo ────────────────────────────────────────────────────────────────────────────

interface TextEdit {
  start: number
  end: number
  text: string
}

function lineStartOf(text: string, pos: number) {
  return text.lastIndexOf('\n', pos - 1) + 1
}

function lineEndAfter(text: string, pos: number) {
  const nl = text.indexOf('\n', Math.max(pos - 1, 0))
  return nl === -1 ? text.length : nl + 1
}

function emitNode(node: unknown, col: number, flow: boolean): string {
  const d = new Document()
  d.contents = node as any
  if (flow && isMap(d.contents)) (d.contents as YAMLMap).flow = true
  const s = d.toString({ lineWidth: 0, flowCollectionPadding: true }).replace(/\n+$/, '')
  return s
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : ' '.repeat(col) + l))
    .join('\n')
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

function mergeExclude(current: string, remove: string | null, add: string | null): string {
  const parts = current
    .split('`')
    .filter(Boolean)
    .filter((p) => p !== remove)
  if (add && !parts.includes(add)) parts.push(add)
  return parts.join('`')
}

/** Применяет план к config.yaml, меняя только затронутые элементы proxy-groups. */
export function applyMihomoPlan(text: string, plan: MihomoPlan): string {
  const doc = parseDocument(text)
  if (doc.errors.length) throw new Error(`config.yaml: ${doc.errors[0].message}`)
  const root = doc.contents
  if (!isMap(root)) throw new Error('config.yaml: корень не словарь')
  const groupsNode = root.get('proxy-groups', true)
  const strip = new Set(plan.strip_names)
  const fixes = new Map(plan.fixes.map((f) => [f.group, f]))
  const edits: TextEdit[] = []

  if (groupsNode && !isSeq(groupsNode)) throw new Error('proxy-groups должен быть списком')
  if (isSeq(groupsNode) && groupsNode.flow && groupsNode.items.length)
    throw new Error('proxy-groups в однострочном виде не поддерживается — разверните его в список')

  let lastEnd = -1
  let itemCol = 2
  let dashIndent = 0
  if (isSeq(groupsNode)) {
    for (const item of groupsNode.items) {
      if (!isMap(item) || !item.range) continue
      const [start, valueEnd] = item.range
      const ls = lineStartOf(text, start)
      itemCol = start - ls
      dashIndent = Math.max(0, itemCol - 2)
      lastEnd = lineEndAfter(text, valueEnd)
      const nameNode = item.get('name', true)
      const name = isScalar(nameNode) ? String(nameNode.value) : ''
      if (strip.has(name)) {
        edits.push({ start: ls, end: lineEndAfter(text, valueEnd), text: '' })
        continue
      }
      const fix = fixes.get(name)
      if (!fix) continue
      const clone = item.clone() as YAMLMap
      if (fix.remove_proxies.length) {
        const proxies = clone.get('proxies', true)
        if (isSeq(proxies)) proxies.items = proxies.items.filter((p) => !(isScalar(p) && fix.remove_proxies.includes(String(p.value))))
      }
      if (fix.exclude_add || fix.exclude_remove) {
        const cur = clone.get('exclude-filter')
        const merged = mergeExclude(typeof cur === 'string' ? cur : '', fix.exclude_remove, fix.exclude_add)
        if (merged) clone.set('exclude-filter', merged)
        else clone.delete('exclude-filter')
      }
      edits.push({ start, end: valueEnd, text: emitNode(clone, itemCol, !!item.flow).replace(/\n$/, '') })
    }
  }

  if (plan.groups.length) {
    const blocks = plan.groups.map((g) => `${' '.repeat(dashIndent)}- ${emitNode(doc.createNode(g), dashIndent + 2, false)}\n`).join('')
    if (isSeq(groupsNode) && groupsNode.items.length && lastEnd >= 0) {
      edits.push({ start: lastEnd, end: lastEnd, text: (text[lastEnd - 1] === '\n' ? '' : '\n') + blocks })
    } else if (isSeq(groupsNode) && groupsNode.range) {
      // пустой список `proxy-groups: []`
      edits.push({ start: groupsNode.range[0], end: groupsNode.range[1], text: '\n' + blocks.replace(/\n$/, '') })
    } else {
      edits.push({ start: text.length, end: text.length, text: (text.endsWith('\n') || !text ? '' : '\n') + 'proxy-groups:\n' + blocks })
    }
  }
  const out = applyTextEdits(text, edits)
  const check = parseDocument(out)
  if (check.errors.length) throw new Error(`Не удалось собрать config.yaml: ${check.errors[0].message}`)
  return out
}

// ─── Построчный diff ─────────────────────────────────────────────────────────────────────────

export type DiffLine = { kind: 'ctx' | 'add' | 'del' | 'skip'; text: string; a?: number; b?: number; count?: number }

export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  const ops: DiffLine[] = []
  if (am.length * bm.length > 4_000_000) {
    am.forEach((t, i) => ops.push({ kind: 'del', text: t, a: pre + i + 1 }))
    bm.forEach((t, i) => ops.push({ kind: 'add', text: t, b: pre + i + 1 }))
  } else {
    const n = am.length
    const m = bm.length
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ kind: 'ctx', text: am[i], a: pre + i + 1, b: pre + j + 1 })
        i++
        j++
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        ops.push({ kind: 'add', text: bm[j], b: pre + j + 1 })
        j++
      } else {
        ops.push({ kind: 'del', text: am[i], a: pre + i + 1 })
        i++
      }
    }
  }
  const full: DiffLine[] = [
    ...a.slice(0, pre).map((t, i) => ({ kind: 'ctx' as const, text: t, a: i + 1, b: i + 1 })),
    ...ops,
    ...a.slice(a.length - suf).map((t, k) => ({ kind: 'ctx' as const, text: t, a: a.length - suf + k + 1, b: b.length - suf + k + 1 })),
  ]
  // сворачиваем неизменённое
  const keep = new Array(full.length).fill(false)
  full.forEach((l, idx) => {
    if (l.kind !== 'ctx') for (let k = Math.max(0, idx - context); k <= Math.min(full.length - 1, idx + context); k++) keep[k] = true
  })
  const res: DiffLine[] = []
  let skipped = 0
  full.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) res.push({ kind: 'skip', text: '', count: skipped })
      skipped = 0
      res.push(l)
    } else skipped++
  })
  if (skipped) res.push({ kind: 'skip', text: '', count: skipped })
  return res
}
