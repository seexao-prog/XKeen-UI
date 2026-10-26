/**
 * «Каталог правил» (только Mihomo): поиск готовых списков доменов/IP в MetaCubeX/meta-rules-dat и
 * добавление их в config.yaml одним действием — rule-provider + (новый) селектор + правило.
 *
 * Модуль без зависимостей от React/алиасов: его импортирует и UI, и scripts/check-rule-catalog.mts.
 * Правка config.yaml — точечная текстовая (позиции из `yaml`-документа), форматирование и
 * комментарии пользователя не трогаются.
 */
import { isMap, isScalar, isSeq, parseDocument, visit, type Document, type Pair, type YAMLMap, type YAMLSeq } from 'yaml'

// ─── Каталог ────────────────────────────────────────────────────────────────────────────────

export const RULES_REPO = 'MetaCubeX/meta-rules-dat'
export const RULES_BRANCH = 'meta'
export const ICONS_REPO = 'Koolson/Qure'
export const ICONS_BRANCH = 'master'
export const ICONS_DIR = 'IconSet/Color'

export type CatalogKind = 'geosite' | 'geoip'

export interface CatalogEntry {
  /** Имя файла без `.mrs`, например `google-gemini` */
  name: string
  kind: CatalogKind
}

export interface CatalogData {
  ts: number
  geosite: string[]
  geoip: string[]
}

const CATALOG_CACHE_KEY = 'xkeen:ruleCatalog:v1'
const ICONS_CACHE_KEY = 'xkeen:qureIcons:v1'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const GITHUB_API = 'https://api.github.com/repos'

export function catalogFileUrl(e: CatalogEntry): string {
  return `https://raw.githubusercontent.com/${RULES_REPO}/${RULES_BRANCH}/geo/${e.kind}/${e.name}.mrs`
}

export function iconUrl(name: string): string {
  return `https://cdn.jsdelivr.net/gh/${ICONS_REPO}@${ICONS_BRANCH}/${ICONS_DIR}/${encodeURIComponent(name)}.png`
}

function readCache<T extends { ts: number }>(key: string): T | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as T
    return Date.now() - v.ts < CACHE_TTL_MS ? v : null
  } catch {
    return null
  }
}

function writeCache(key: string, value: unknown) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* квота localStorage — работаем без кэша */
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** URL напрямую, затем через GitHub-прокси из настроек (`https://proxy/<url>`). */
function withProxies(url: string, proxies: string[]): string[] {
  return [
    url,
    ...proxies
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `${p.replace(/\/+$/, '')}/${url}`),
  ]
}

/**
 * Имена файлов одной папки репозитория через git trees API (нерекурсивно, `ref:path`) —
 * один запрос на папку. Без токена лимит GitHub — 60 запросов в час с IP, поэтому результат кэшируется.
 */
async function fetchTreeNames(repo: string, ref: string, path: string, ext: string, proxies: string[]): Promise<string[]> {
  const url = `${GITHUB_API}/${repo}/git/trees/${ref}:${path}`
  let lastError = ''
  for (const u of withProxies(url, proxies)) {
    let res: Response
    try {
      res = await fetchWithTimeout(u, 20000, { headers: { Accept: 'application/vnd.github+json' } })
    } catch {
      lastError = 'нет ответа'
      continue
    }
    if (!res.ok) {
      lastError =
        res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
          ? 'исчерпан лимит GitHub API (60 запросов в час)'
          : `HTTP ${res.status}`
      continue
    }
    try {
      const data = (await res.json()) as { tree?: { path: string; type: string }[] }
      if (!Array.isArray(data.tree)) {
        lastError = 'неожиданный ответ'
        continue
      }
      return data.tree
        .filter((t) => t.type === 'blob' && t.path.endsWith(ext))
        .map((t) => t.path.slice(0, -ext.length))
        .sort((a, b) => a.localeCompare(b))
    } catch {
      lastError = 'некорректный ответ'
    }
  }
  throw new Error(`Не удалось получить список файлов ${repo}/${path}: ${lastError}`)
}

export function getCachedCatalog(): CatalogData | null {
  return readCache<CatalogData>(CATALOG_CACHE_KEY)
}

export async function loadCatalog(proxies: string[], force = false): Promise<CatalogData> {
  if (!force) {
    const cached = getCachedCatalog()
    if (cached) return cached
  }
  const [geosite, geoip] = await Promise.all([
    fetchTreeNames(RULES_REPO, RULES_BRANCH, 'geo/geosite', '.mrs', proxies),
    fetchTreeNames(RULES_REPO, RULES_BRANCH, 'geo/geoip', '.mrs', proxies),
  ])
  const data: CatalogData = { ts: Date.now(), geosite, geoip }
  writeCache(CATALOG_CACHE_KEY, data)
  return data
}

export async function loadIcons(proxies: string[], force = false): Promise<string[]> {
  if (!force) {
    const cached = readCache<{ ts: number; names: string[] }>(ICONS_CACHE_KEY)
    if (cached) return cached.names
  }
  const names = await fetchTreeNames(ICONS_REPO, ICONS_BRANCH, ICONS_DIR, '.png', proxies)
  writeCache(ICONS_CACHE_KEY, { ts: Date.now(), names })
  return names
}

/**
 * Предпросмотр: рядом с каждым `.mrs` в meta-rules-dat лежит текстовый `.list` с тем же содержимым.
 * Сначала jsDelivr (CORS, CDN), затем raw.githubusercontent и прокси.
 */
export async function loadPreview(e: CatalogEntry, proxies: string[], limit = 50): Promise<{ lines: string[]; total: number }> {
  const path = `geo/${e.kind}/${e.name}.list`
  const urls = [
    `https://cdn.jsdelivr.net/gh/${RULES_REPO}@${RULES_BRANCH}/${path}`,
    ...withProxies(`https://raw.githubusercontent.com/${RULES_REPO}/${RULES_BRANCH}/${path}`, proxies),
  ]
  for (const u of urls) {
    try {
      const res = await fetchWithTimeout(u, 15000)
      if (!res.ok) continue
      const all = (await res.text())
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
      return { lines: all.slice(0, limit), total: all.length }
    } catch {
      /* следующий источник */
    }
  }
  throw new Error('Не удалось загрузить содержимое списка')
}

// ─── Поиск ──────────────────────────────────────────────────────────────────────────────────

/** Частые запросы → имена файлов в geosite. */
export const SYNONYMS: Record<string, string[]> = {
  chatgpt: ['openai'],
  чатгпт: ['openai'],
  gpt: ['openai'],
  openai: ['openai'],
  claude: ['anthropic'],
  клод: ['anthropic'],
  anthropic: ['anthropic'],
  gemini: ['google-gemini'],
  джемини: ['google-gemini'],
  bard: ['google-gemini'],
  grok: ['xai'],
  грок: ['xai'],
  perplexity: ['perplexity'],
  перплексити: ['perplexity'],
  deepseek: ['deepseek'],
  дипсик: ['deepseek'],
  copilot: ['github-copilot', 'microsoft'],
  копилот: ['github-copilot'],
  нейросети: ['category-ai-!cn'],
  ии: ['category-ai-!cn'],
  ai: ['category-ai-!cn'],
  ютуб: ['youtube'],
  телеграм: ['telegram'],
  телеграмм: ['telegram'],
  инстаграм: ['instagram'],
  фейсбук: ['facebook'],
  нетфликс: ['netflix'],
  дискорд: ['discord'],
  твиттер: ['twitter'],
  x: ['twitter'],
  тикток: ['tiktok'],
  спотифай: ['spotify'],
  твич: ['twitch'],
  гугл: ['google'],
  гитхаб: ['github'],
  стим: ['steam'],
  реддит: ['reddit'],
  ватсап: ['whatsapp'],
  whatsapp: ['whatsapp'],
  эппл: ['apple'],
  майкрософт: ['microsoft'],
  амазон: ['amazon'],
  клаудфлер: ['cloudflare'],
}

export interface SearchHit extends CatalogEntry {
  score: number
  /** Диапазон совпадения в имени (для подсветки), если совпадение текстовое */
  match?: [number, number]
  viaSynonym?: string
}

export function searchCatalog(
  data: CatalogData,
  query: string,
  kind: CatalogKind | 'all',
  limit = 200
): { hits: SearchHit[]; total: number } {
  const q = query.trim().toLowerCase()
  const kinds: CatalogKind[] = kind === 'all' ? ['geosite', 'geoip'] : [kind]
  const synonymTargets = new Map<string, string>()
  if (q) {
    for (const [key, targets] of Object.entries(SYNONYMS)) {
      if (key === q || (q.length >= 3 && key.startsWith(q))) for (const t of targets) if (!synonymTargets.has(t)) synonymTargets.set(t, key)
    }
  }
  const hits: SearchHit[] = []
  for (const k of kinds) {
    for (const name of data[k]) {
      const lower = name.toLowerCase()
      if (!q) {
        hits.push({ name, kind: k, score: 3 })
        continue
      }
      const syn = synonymTargets.get(name)
      const at = lower.indexOf(q)
      if (syn && k === 'geosite') hits.push({ name, kind: k, score: -1, viaSynonym: syn, match: at >= 0 ? [at, at + q.length] : undefined })
      else if (lower === q) hits.push({ name, kind: k, score: 0, match: [0, q.length] })
      else if (lower.startsWith(q)) hits.push({ name, kind: k, score: 1, match: [0, q.length] })
      else if (at >= 0) hits.push({ name, kind: k, score: 2, match: [at, at + q.length] })
    }
  }
  hits.sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind))
  return { hits: hits.slice(0, limit), total: hits.length }
}

// ─── Имена ──────────────────────────────────────────────────────────────────────────────────

const PRETTY: Record<string, string> = {
  openai: 'ChatGPT',
  anthropic: 'Claude',
  'google-gemini': 'Gemini',
  xai: 'Grok',
  perplexity: 'Perplexity',
  deepseek: 'DeepSeek',
  'github-copilot': 'Copilot',
  'category-ai-!cn': 'AI',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  github: 'GitHub',
  whatsapp: 'WhatsApp',
  linkedin: 'LinkedIn',
  paypal: 'PayPal',
  playstation: 'PlayStation',
  soundcloud: 'SoundCloud',
  onedrive: 'OneDrive',
  bbc: 'BBC',
  cnn: 'CNN',
  hbo: 'HBO',
  'category-games': 'Games',
}

export function prettyName(file: string): string {
  if (PRETTY[file]) return PRETTY[file]
  const base = file
    .replace(/@.*$/, '')
    .replace(/-!?cn$/i, '')
    .replace(/^category-/, '')
  return base
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function providerKey(file: string, behavior: Behavior): string {
  const base =
    file
      .replace(/-!cn$/i, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'list'
  return `${base}@${behavior}`
}

export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  const at = base.indexOf('@')
  const [head, tail] = at >= 0 ? [base.slice(0, at), base.slice(at)] : [base, '']
  for (let i = 2; ; i++) if (!taken.has(`${head}-${i}${tail}`)) return `${head}-${i}${tail}`
}

/** Подбор иконки Qure по названию: точное совпадение → начинается с → содержит. */
export function suggestIcon(names: string[], query: string): string | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, '')
  if (!q) return null
  return (
    names.find((n) => n.toLowerCase() === q) ??
    names.find((n) => n.toLowerCase().startsWith(q)) ??
    (q.length >= 4 ? names.find((n) => n.toLowerCase().includes(q)) : undefined) ??
    null
  )
}

// ─── Разбор config.yaml ─────────────────────────────────────────────────────────────────────

export type Behavior = 'domain' | 'ipcidr' | 'classical'
export type Format = 'mrs' | 'text' | 'yaml'

export interface InvGroup {
  name: string
  type: string
  includeAll: boolean
  proxies: string[]
  /** Группа «Групп прокси» панели (тег grp-*) */
  panel: boolean
}

export interface InvProvider {
  name: string
  url: string
}

export interface InvAnchor {
  name: string
  type?: string
  format?: string
  behavior?: string
  interval?: number
}

export interface InvRule {
  index: number
  text: string
  target: string
}

export interface CatalogInventory {
  groups: InvGroup[]
  proxies: string[]
  providers: InvProvider[]
  anchors: InvAnchor[]
  rules: InvRule[]
}

const BUILTIN_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']
const RULE_OPTIONS = new Set(['no-resolve', 'src'])

export function ruleTarget(rule: string): string {
  const parts = rule.split(',').map((s) => s.trim())
  let i = parts.length - 1
  while (i > 0 && RULE_OPTIONS.has(parts[i])) i--
  return parts[i] ?? ''
}

function parse(text: string): Document.Parsed {
  const doc = parseDocument(text)
  if (doc.errors.length) throw new Error(`config.yaml не разбирается: ${doc.errors[0].message.split('\n')[0]}`)
  if (!isMap(doc.contents)) throw new Error('config.yaml: корень не словарь')
  return doc
}

function str(node: unknown): string {
  return isScalar(node) ? String(node.value ?? '') : ''
}

function pairsOf(map: YAMLMap): Pair[] {
  return map.items as Pair[]
}

export function inspectConfig(text: string): CatalogInventory {
  const doc = parse(text)
  const root = doc.contents as YAMLMap
  const inv: CatalogInventory = { groups: [], proxies: [], providers: [], anchors: [], rules: [] }

  const proxies = root.get('proxies', true)
  if (isSeq(proxies)) for (const p of proxies.items) if (isMap(p)) inv.proxies.push(str(p.get('name', true)))

  const groups = root.get('proxy-groups', true)
  if (isSeq(groups)) {
    for (const g of groups.items) {
      if (!isMap(g)) continue
      const name = str(g.get('name', true))
      const proxiesNode = g.get('proxies', true)
      inv.groups.push({
        name,
        type: str(g.get('type', true)),
        includeAll: [g.get('include-all'), g.get('include-all-proxies')].some((v) => v === true),
        proxies: isSeq(proxiesNode) ? proxiesNode.items.map(str) : [],
        panel: name.startsWith('grp-'),
      })
    }
  }

  const providers = root.get('rule-providers', true)
  if (isMap(providers)) {
    for (const p of pairsOf(providers)) {
      const v = p.value
      inv.providers.push({ name: str(p.key), url: isMap(v) ? str(v.get('url', true)) : '' })
    }
  }

  visit(doc, {
    Map(_, node) {
      if (!node.anchor) return
      const v = node.toJSON() as Record<string, unknown>
      inv.anchors.push({
        name: node.anchor,
        type: typeof v.type === 'string' ? v.type : undefined,
        format: typeof v.format === 'string' ? v.format : undefined,
        behavior: typeof v.behavior === 'string' ? v.behavior : undefined,
        interval: typeof v.interval === 'number' ? v.interval : undefined,
      })
    },
  })

  const rules = root.get('rules', true)
  if (isSeq(rules)) rules.items.forEach((r, index) => inv.rules.push({ index, text: str(r), target: ruleTarget(str(r)) }))
  return inv
}

/** Провайдер, уже подключающий этот файл каталога (сравнение по имени файла и папке geosite/geoip). */
export function findConnected(inv: CatalogInventory, e: CatalogEntry): string | null {
  for (const p of inv.providers) {
    const m = /\/([^/?#]+?)\.(mrs|list|ya?ml|txt)(?:[?#].*)?$/i.exec(p.url)
    if (!m || m[1] !== e.name) continue
    const otherKind = e.kind === 'geosite' ? '/geoip/' : '/geosite/'
    if (p.url.includes(otherKind)) continue
    return p.name
  }
  return null
}

/** Позиция по умолчанию: сразу после REJECT-правил, стоящих до первого «широкого» правила. */
export function defaultInsertIndex(rules: InvRule[]): number {
  const isReject = (t: string) => t.startsWith('REJECT')
  const firstBroad = rules.findIndex((r) => /^(RULE-SET|GEOSITE|GEOIP|MATCH|AND|OR|NOT|SUB-RULE)\b/.test(r.text) && !isReject(r.target))
  const end = firstBroad < 0 ? rules.length : firstBroad
  let lastReject = -1
  for (let i = 0; i < end; i++) if (isReject(rules[i].target)) lastReject = i
  return lastReject >= 0 ? lastReject + 1 : end
}

/** Самый «типичный» селектор: select + include-all с самым частым набором proxies (как AI/YouTube). */
export function defaultTemplate(inv: CatalogInventory): string | null {
  const candidates = inv.groups.filter((g) => g.type === 'select' && g.includeAll && !g.panel)
  if (!candidates.length) return inv.groups.find((g) => g.type === 'select' && !g.panel)?.name ?? null
  const counts = new Map<string, number>()
  for (const g of candidates) counts.set(JSON.stringify(g.proxies), (counts.get(JSON.stringify(g.proxies)) ?? 0) + 1)
  let best = candidates[0]
  for (const g of candidates) if ((counts.get(JSON.stringify(g.proxies)) ?? 0) > (counts.get(JSON.stringify(best.proxies)) ?? 0)) best = g
  return best.name
}

/** Формат/поведение по ссылке: geosite→domain, geoip→ipcidr; .list/.txt — text, .yaml — yaml. */
export function detectFromUrl(url: string): { format: Format; behavior: Behavior } {
  const path = url.split(/[?#]/)[0].toLowerCase()
  const format: Format = path.endsWith('.mrs') ? 'mrs' : /\.ya?ml$/.test(path) ? 'yaml' : 'text'
  const behavior: Behavior = /\/geoip\/|@ipcidr|ipcidr|geoip/.test(path)
    ? 'ipcidr'
    : /\/geosite\/|@domain|geosite/.test(path) || format === 'mrs'
      ? 'domain'
      : 'classical'
  return { format, behavior }
}

// ─── Правка config.yaml ─────────────────────────────────────────────────────────────────────

export const RU_FILTER = '🇷🇺'

export type CatalogTarget =
  | {
      mode: 'new'
      name: string
      icon?: string
      /** Селектор-образец, из которого копируются include-all*, proxies, use, filter, exclude-filter */
      template?: string | null
      excludeRu: boolean
      /** Дополнительные варианты в начало proxies (например, группы панели grp-*) */
      extraVariants: string[]
    }
  | { mode: 'existing'; group: string }

export interface CatalogPlanInput {
  url: string
  format: Format
  behavior: Behavior
  interval?: number
  /** Имя нового rule-provider */
  providerName: string
  /** Использовать уже подключённый провайдер вместо нового */
  reuseProvider?: string | null
  target: CatalogTarget
  /** Индекс правила, перед которым вставить (rules.length — в конец) */
  insertBefore: number
}

export interface CatalogPlanResult {
  text: string
  providerName: string
  groupName: string
  ruleLine: string
  warnings: string[]
}

const COPY_KEYS = [
  'include-all',
  'include-all-proxies',
  'include-all-providers',
  'proxies',
  'use',
  'filter',
  'exclude-filter',
  'exclude-type',
]
const YAML_RESERVED =
  /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+|\.inf|\.nan)$/i

/** Скаляр YAML: как есть, если безопасно, иначе в двойных кавычках. В flow-контексте `[ ]` нельзя `,[]{}`. */
export function yamlScalar(s: string, flow = false): string {
  const unsafe =
    !s ||
    s !== s.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /: |:$| #|[\n\r\t]/.test(s) ||
    (flow && /[,[\]{}]/.test(s)) ||
    YAML_RESERVED.test(s)
  return unsafe ? JSON.stringify(s) : s
}

function lineStartOf(text: string, pos: number) {
  return text.lastIndexOf('\n', pos - 1) + 1
}

function lineEndAfter(text: string, pos: number) {
  const nl = text.indexOf('\n', Math.max(pos - 1, 0))
  return nl === -1 ? text.length : nl + 1
}

function columnOf(text: string, pos: number) {
  return pos - lineStartOf(text, pos)
}

function nl(text: string) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Позиция начала строки, следующей за последним значащим символом узла (хвостовые пустые строки узла не входят). */
function afterContent(text: string, start: number, end: number) {
  const contentEnd = start + text.slice(start, end).replace(/\s+$/, '').length
  return lineEndAfter(text, contentEnd)
}

export function validateSelectorName(name: string): string | null {
  if (!name.trim()) return 'Укажите название'
  if (name !== name.trim()) return 'Название не должно начинаться или заканчиваться пробелом'
  if (name.includes(',')) return 'Запятая в названии недопустима (ломает правило RULE-SET)'
  if (/[\n\r\t]/.test(name)) return 'Недопустимые символы в названии'
  if (name.length > 64) return 'Слишком длинное название'
  if (BUILTIN_TARGETS.includes(name.toUpperCase())) return 'Это зарезервированное имя Mihomo'
  return null
}

export function validateProviderName(name: string): string | null {
  if (!/^[\w.@!-]+$/.test(name)) return 'Имя провайдера: только латиница, цифры и . _ - @'
  return null
}

interface Edit {
  at: number
  text: string
}

export function buildCatalogChange(text: string, input: CatalogPlanInput): CatalogPlanResult {
  const doc = parse(text)
  const root = doc.contents as YAMLMap
  const inv = inspectConfig(text)
  const NL = nl(text)
  const edits: Edit[] = []
  const warnings: string[] = []

  if (!/^https?:\/\/\S+$/i.test(input.url)) throw new Error('Некорректная ссылка на список')
  if (input.format === 'mrs' && input.behavior === 'classical') throw new Error('Формат mrs поддерживает только domain и ipcidr')

  // ── rule-provider ─────────────────────────────────────────────────────────────────────────
  let providerName = input.reuseProvider ?? input.providerName
  if (input.reuseProvider) {
    if (!inv.providers.some((p) => p.name === input.reuseProvider)) throw new Error(`Провайдер «${input.reuseProvider}» не найден`)
  } else {
    providerName = input.providerName.trim()
    const err = validateProviderName(providerName)
    if (err) throw new Error(err)
    if (inv.providers.some((p) => p.name === providerName)) throw new Error(`Провайдер «${providerName}» уже есть в rule-providers`)
    const interval = input.interval ?? 86400
    const anchor = inv.anchors.find(
      (a) => a.type === 'http' && a.format === input.format && a.behavior === input.behavior && (a.interval ?? 86400) === interval
    )
    const fields = anchor
      ? [`<<: *${anchor.name}`, `url: ${yamlScalar(input.url, true)}`]
      : [
          `type: http`,
          `format: ${input.format}`,
          `behavior: ${input.behavior}`,
          `interval: ${interval}`,
          `url: ${yamlScalar(input.url, true)}`,
        ]

    const rpPair = pairsOf(root).find((p) => str(p.key) === 'rule-providers')
    const rp = rpPair?.value
    if (isMap(rp) && rp.items.length) {
      if (rp.flow) throw new Error('rule-providers записан в одну строку — разверните его, чтобы добавить провайдер')
      const pairs = pairsOf(rp)
      const httpPairs = pairs.filter((p) => isMap(p.value) && (p.value.get('url') !== undefined || p.value.get('type') === 'http'))
      const after = httpPairs[httpPairs.length - 1] ?? pairs[pairs.length - 1]
      const keyNode = after.key as { range?: [number, number, number] }
      const valueNode = after.value as { range?: [number, number, number] } | null
      const ind = ' '.repeat(columnOf(text, keyNode.range![0]))
      const flowStyle = isMap(after.value) && (after.value as YAMLMap).flow
      const key = yamlScalar(providerName)
      const entry = flowStyle
        ? `${ind}${key}: { ${fields.join(', ')} }${NL}`
        : `${ind}${key}:${NL}${fields.map((f) => `${ind}  ${f}${NL}`).join('')}`
      const end = valueNode?.range?.[1] ?? keyNode.range![1]
      edits.push({ at: afterContent(text, keyNode.range![0], end), text: entry })
    } else if (rpPair && (rp === null || (isScalar(rp) && rp.value === null))) {
      const keyRange = (rpPair.key as { range: [number, number, number] }).range
      edits.push({ at: lineEndAfter(text, keyRange[1]), text: `  ${yamlScalar(providerName)}: { ${fields.join(', ')} }${NL}` })
    } else if (rpPair && isMap(rp)) {
      throw new Error('rule-providers записан как {} — замените на пустой блок и повторите')
    } else if (!rpPair) {
      const prefix = text.endsWith('\n') || !text ? '' : NL
      edits.push({
        at: text.length,
        text: `${prefix}${NL}rule-providers:${NL}  ${yamlScalar(providerName)}: { ${fields.join(', ')} }${NL}`,
      })
    } else {
      throw new Error('rule-providers должен быть словарём')
    }
  }

  // ── селектор ──────────────────────────────────────────────────────────────────────────────
  let groupName: string
  if (input.target.mode === 'existing') {
    groupName = input.target.group
    if (!BUILTIN_TARGETS.includes(groupName) && !inv.groups.some((g) => g.name === groupName) && !inv.proxies.includes(groupName))
      throw new Error(`Группа «${groupName}» не найдена`)
    if (groupName.includes(',')) throw new Error('Имя группы с запятой нельзя использовать в правиле')
  } else {
    const t = input.target
    groupName = t.name.trim()
    const err = validateSelectorName(t.name)
    if (err) throw new Error(err)
    if (inv.groups.some((g) => g.name === groupName) || inv.proxies.includes(groupName))
      throw new Error(`«${groupName}» уже есть среди групп или прокси — выберите другое название`)
    if (t.icon && !/^https?:\/\/\S+$/i.test(t.icon)) throw new Error('Ссылка на иконку должна начинаться с http(s)://')

    const pg = root.get('proxy-groups', true)
    if (pg && !isSeq(pg)) throw new Error('proxy-groups должен быть списком')
    if (isSeq(pg) && pg.flow && pg.items.length) throw new Error('proxy-groups записан в одну строку — разверните его')
    const items = isSeq(pg) ? (pg as YAMLSeq).items.filter(isMap) : []
    const template = t.template ? items.find((g) => str(g.get('name', true)) === t.template) : undefined
    if (t.template && !template) throw new Error(`Образец «${t.template}» не найден`)

    // Ключи образца
    let proxiesList: string[] = []
    let proxiesFlow = true
    let excludeParts: string[] = []
    const copied: { key: string; raw: string }[] = []
    if (template) {
      for (const p of pairsOf(template)) {
        const key = str(p.key)
        if (!COPY_KEYS.includes(key)) continue
        if (key === 'proxies') {
          if (isSeq(p.value)) {
            // Группы панели (grp-*) в образце привязаны через «Группы прокси» — не копируем их молча,
            // пользователь добавляет их явно (extraVariants).
            proxiesList = p.value.items.map(str).filter((n) => !n.startsWith('grp-'))
            proxiesFlow = !!p.value.flow
          }
          copied.push({ key, raw: '' })
          continue
        }
        if (key === 'exclude-filter') {
          excludeParts = str(p.value).split('`').filter(Boolean)
          copied.push({ key, raw: '' })
          continue
        }
        const kr = (p.key as { range: [number, number, number] }).range
        const vr = (p.value as { range?: [number, number, number] } | null)?.range
        const raw = text.slice(kr[0], vr ? vr[1] : kr[1]).replace(/\s+$/, '')
        copied.push({ key, raw })
      }
    }
    if (!copied.some((c) => c.key === 'proxies')) copied.push({ key: 'proxies', raw: '' })
    if (!copied.some((c) => c.key === 'exclude-filter')) copied.push({ key: 'exclude-filter', raw: '' })

    const extras = t.extraVariants.filter((v) => !proxiesList.includes(v))
    for (const v of extras) {
      if (v.includes(',')) throw new Error(`Вариант «${v}» содержит запятую`)
      if (!inv.groups.some((g) => g.name === v) && !inv.proxies.includes(v) && !BUILTIN_TARGETS.includes(v))
        throw new Error(`Вариант «${v}» не найден`)
    }
    proxiesList = [...extras, ...proxiesList]
    excludeParts = excludeParts.filter((p) => p !== RU_FILTER)
    if (t.excludeRu) excludeParts = [RU_FILTER, ...excludeParts]

    const includesAll = copied.some((c) => c.key.startsWith('include-all')) || copied.some((c) => c.key === 'use')
    if (!proxiesList.length && !includesAll) proxiesList = ['DIRECT']

    // Отступы — как у существующих элементов списка
    let dashCol = 2
    let itemCol = 4
    let insertAt: number
    let blankSep = false
    if (isSeq(pg) && items.length) {
      const userItems = items.filter((g) => !str(g.get('name', true)).startsWith('grp-'))
      const after = userItems[userItems.length - 1] ?? items[items.length - 1]
      const r = after.range!
      const ls = lineStartOf(text, r[0])
      itemCol = r[0] - ls
      dashCol = Math.max(0, text.slice(ls, r[0]).lastIndexOf('-'))
      insertAt = afterContent(text, r[0], r[1])
      // Разделены ли элементы пустой строкой
      const second = items[1]?.range
      if (second) {
        const prevLineStart = lineStartOf(text, lineStartOf(text, second[0]) - 1)
        blankSep = text.slice(prevLineStart, lineStartOf(text, second[0])).trim() === ''
      }
    } else if (isSeq(pg) || pg === null || pg === undefined) {
      const pgPair = pairsOf(root).find((p) => str(p.key) === 'proxy-groups')
      if (pgPair) {
        const kr = (pgPair.key as { range: [number, number, number] }).range
        insertAt = lineEndAfter(text, kr[1])
        if (isSeq(pg) && pg.flow) throw new Error('proxy-groups записан в одну строку — разверните его')
      } else {
        const prefix = text.endsWith('\n') || !text ? '' : NL
        edits.push({ at: text.length, text: `${prefix}${NL}proxy-groups:${NL}` })
        insertAt = text.length
      }
    } else {
      throw new Error('proxy-groups должен быть списком')
    }

    const pad = ' '.repeat(itemCol)
    const lines: string[] = [
      `${' '.repeat(dashCol)}-${' '.repeat(Math.max(1, itemCol - dashCol - 1))}name: ${yamlScalar(groupName)}`,
      `${pad}type: select`,
    ]
    if (t.icon) lines.push(`${pad}icon: ${yamlScalar(t.icon)}`)
    for (const c of copied) {
      if (c.key === 'proxies') {
        if (!proxiesList.length) continue
        if (proxiesFlow) lines.push(`${pad}proxies: [ ${proxiesList.map((p) => yamlScalar(p, true)).join(', ')} ]`)
        else lines.push(`${pad}proxies:`, ...proxiesList.map((p) => `${pad}  - ${yamlScalar(p)}`))
      } else if (c.key === 'exclude-filter') {
        if (excludeParts.length) lines.push(`${pad}exclude-filter: ${yamlScalar(excludeParts.join('`'))}`)
      } else {
        // raw уже содержит отступ продолжения строк от образца; первая строка — без отступа
        lines.push(pad + c.raw)
      }
    }
    const lead = insertAt === text.length && text && !text.endsWith('\n') ? NL : ''
    const block = lead + (blankSep && isSeq(pg) && items.length ? NL : '') + lines.join(NL) + NL
    edits.push({ at: insertAt, text: block })
  }

  // ── правило ───────────────────────────────────────────────────────────────────────────────
  const ruleLine = `RULE-SET,${providerName},${groupName}${input.behavior === 'ipcidr' ? ',no-resolve' : ''}`
  const rulesPair = pairsOf(root).find((p) => str(p.key) === 'rules')
  const rules = rulesPair?.value
  if (inv.rules.some((r) => r.text === ruleLine)) throw new Error('Такое правило уже есть')
  if (isSeq(rules) && rules.items.length) {
    if (rules.flow) throw new Error('rules записан в одну строку — разверните его')
    const k = Math.max(0, Math.min(input.insertBefore, rules.items.length))
    const ref = rules.items[Math.min(k, rules.items.length - 1)] as { range: [number, number, number] }
    const ls = lineStartOf(text, ref.range[0])
    const dash = Math.max(0, text.slice(ls, ref.range[0]).lastIndexOf('-'))
    const at = k < rules.items.length ? ls : afterContent(text, ref.range[0], ref.range[2])
    const lead = at === text.length && !text.endsWith('\n') ? NL : ''
    edits.push({ at, text: `${lead}${' '.repeat(dash)}- ${yamlScalar(ruleLine)}${NL}` })
    const matchIdx = inv.rules.findIndex((r) => r.text.startsWith('MATCH,'))
    if (matchIdx >= 0 && k > matchIdx) warnings.push('Правило окажется ниже MATCH и никогда не сработает — выберите позицию выше')
  } else if (rulesPair) {
    if (!(rules === null || (isScalar(rules) && rules.value === null) || (isSeq(rules) && !rules.items.length)))
      throw new Error('rules должен быть списком')
    const kr = (rulesPair.key as { range: [number, number, number] }).range
    if (isSeq(rules)) throw new Error('rules записан как [] — замените на пустой блок и повторите')
    edits.push({ at: lineEndAfter(text, kr[1]), text: `  - ${yamlScalar(ruleLine)}${NL}` })
  } else {
    const prefix = text.endsWith('\n') || !text ? '' : NL
    edits.push({ at: text.length, text: `${prefix}${NL}rules:${NL}  - ${yamlScalar(ruleLine)}${NL}` })
  }

  // ── применение правок (с конца, чтобы позиции не съезжали) ─────────────────────────────────
  // При совпадении позиций сначала применяется более поздняя правка — так итоговый порядок совпадает с порядком push.
  let out = text
  const ops = edits.map((e, order) => ({ ...e, order })).sort((a, b) => b.at - a.at || b.order - a.order)
  for (const op of ops) out = out.slice(0, op.at) + op.text + out.slice(op.at)

  const check = parseDocument(out)
  if (check.errors.length) throw new Error(`Не удалось собрать config.yaml: ${check.errors[0].message.split('\n')[0]}`)
  return { text: out, providerName, groupName, ruleLine, warnings }
}
