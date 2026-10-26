import { applyEdits, findNodeAtLocation, modify, parse as parseJsonc, parseTree, type JSONPath } from 'jsonc-parser'

/**
 * Анализатор «тяжёлых» для слабого роутера настроек Xray. Работает над JSONC-файлами из
 * /opt/etc/xray/configs (routing, outbounds, inbounds, log обычно разнесены по файлам).
 * Исправления вносятся точечно через jsonc-parser modify/applyEdits — комментарии и
 * форматирование остальных частей файла сохраняются.
 */

export interface ConfigFile {
  file: string
  content: string
}

export interface FileChange {
  file: string
  before: string
  after: string
}

export type Severity = 'high' | 'medium' | 'low'

export interface Finding {
  id: string
  severity: Severity
  title: string
  description: string
  file: string
  location: string
  /** Есть ли безопасное автоисправление. */
  fixable: boolean
  /** Можно ли включать в «Исправить всё» (без изменения логики маршрутизации/протокола). */
  bulk?: boolean
  fix?: (files: ConfigFile[]) => FileChange[]
}

const FORMAT = { insertSpaces: true, tabSize: 2, eol: '\n' }

function safeParse(content: string): any {
  try {
    return parseJsonc(content, [], { allowTrailingComma: true })
  } catch {
    return undefined
  }
}

function edit(content: string, path: JSONPath, value: unknown): string {
  return applyEdits(content, modify(content, path, value, { formattingOptions: FORMAT }))
}

function fileName(path: string) {
  return path.split('/').pop() ?? path
}

/** Возвращает изменение одного файла, построенное функцией над его текущим содержимым. */
function changeFile(files: ConfigFile[], file: string, update: (content: string) => string): FileChange[] {
  const current = files.find((f) => f.file === file)
  if (!current) return []
  const after = update(current.content)
  return after === current.content ? [] : [{ file, before: current.content, after }]
}

export function isXrayConfigFile(file: string) {
  return file.endsWith('.json') && !file.startsWith('/opt/etc/xkeen')
}

const HEAVY_TRANSPORTS: Record<string, string> = {
  xhttp: 'XHTTP',
  splithttp: 'SplitHTTP',
  grpc: 'gRPC',
  ws: 'WebSocket',
  httpupgrade: 'HTTPUpgrade',
  h2: 'HTTP/2',
  http: 'HTTP/2',
}

export function analyzeXray(files: ConfigFile[]): Finding[] {
  const findings: Finding[] = []

  for (const { file, content } of files) {
    const json = safeParse(content)
    if (!json || typeof json !== 'object') continue
    const name = fileName(file)

    // ─── log ───
    const log = json.log
    if (log && typeof log === 'object') {
      const level = String(log.loglevel ?? 'warning').toLowerCase()
      if (level === 'debug' || level === 'info') {
        findings.push({
          id: `${file}:loglevel`,
          severity: level === 'debug' ? 'high' : 'medium',
          title: `Подробный уровень логов: ${level}`,
          description:
            'Xray пишет строку в лог на каждое соединение — это лишняя работа процессора и запись на флешку. Для повседневной работы хватит уровня warning.',
          file,
          location: `${name} → log.loglevel`,
          fixable: true,
          bulk: true,
          fix: (all) => changeFile(all, file, (c) => edit(c, ['log', 'loglevel'], 'warning')),
        })
      }
      const access = typeof log.access === 'string' ? log.access.trim() : ''
      if (access && access.toLowerCase() !== 'none') {
        findings.push({
          id: `${file}:access`,
          severity: 'medium',
          title: 'Включён журнал доступа (access log)',
          description:
            'Каждое соединение записывается в файл. При активном трафике это заметная нагрузка на CPU и флеш-память роутера. Если журнал не нужен для отладки, его стоит выключить ("none").',
          file,
          location: `${name} → log.access`,
          fixable: true,
          bulk: true,
          fix: (all) => changeFile(all, file, (c) => edit(c, ['log', 'access'], 'none')),
        })
      }
      if (log.dnsLog === true) {
        findings.push({
          id: `${file}:dnslog`,
          severity: 'low',
          title: 'Включено логирование DNS-запросов',
          description: 'Каждый DNS-запрос попадает в журнал. Полезно для отладки, но лишнее в обычной работе.',
          file,
          location: `${name} → log.dnsLog`,
          fixable: true,
          bulk: true,
          fix: (all) => changeFile(all, file, (c) => edit(c, ['log', 'dnsLog'], false)),
        })
      }
    }

    // ─── routing.domainStrategy ───
    const strategy = json.routing?.domainStrategy
    if (strategy === 'IPIfNonMatch' || strategy === 'IPOnDemand') {
      findings.push({
        id: `${file}:domainStrategy`,
        severity: strategy === 'IPOnDemand' ? 'high' : 'medium',
        title: `domainStrategy: ${strategy}`,
        description:
          strategy === 'IPOnDemand'
            ? 'Xray резолвит домен в IP для каждого соединения, как только встречает IP-правило. Это DNS-запрос и задержка на каждое новое соединение. AsIs обрабатывает домены без резолва.'
            : 'Если домен не совпал ни с одним доменным правилом, Xray резолвит его и проверяет IP-правила — лишний DNS-запрос на каждое такое соединение. Если IP-правила (geoip) не нужны для доменов, AsIs заметно легче. Проверьте, что маршрутизация после смены работает как задумано.',
        file,
        location: `${name} → routing.domainStrategy`,
        fixable: true,
        fix: (all) => changeFile(all, file, (c) => edit(c, ['routing', 'domainStrategy'], 'AsIs')),
      })
    }

    // ─── inbounds.sniffing ───
    if (Array.isArray(json.inbounds)) {
      json.inbounds.forEach((inbound: any, index: number) => {
        const sniffing = inbound?.sniffing
        if (!sniffing || sniffing.enabled !== true) return
        const tag = inbound.tag ? `«${inbound.tag}»` : `#${index + 1}`
        if (sniffing.routeOnly !== true) {
          findings.push({
            id: `${file}:sniff:${index}`,
            severity: 'medium',
            title: `Sniffing без routeOnly во входящем ${tag}`,
            description:
              'Sniffing подменяет адрес назначения на распознанный домен, из-за чего Xray заново резолвит его и устанавливает соединение по домену. С routeOnly: true домен используется только для маршрутизации — меньше работы и меньше проблем с CDN.',
            file,
            location: `${name} → inbounds[${index}].sniffing`,
            fixable: true,
            bulk: true,
            fix: (all) => changeFile(all, file, (c) => edit(c, ['inbounds', index, 'sniffing', 'routeOnly'], true)),
          })
        }
        const overrides: string[] = Array.isArray(sniffing.destOverride) ? sniffing.destOverride : []
        if (overrides.includes('fakedns') || overrides.includes('fakedns+others')) return
        if (overrides.length > 0 && !hasDomainRules(files)) {
          findings.push({
            id: `${file}:sniff-unused:${index}`,
            severity: 'low',
            title: `Sniffing во входящем ${tag}, но доменных правил нет`,
            description:
              'Sniffing нужен, чтобы маршрутизировать по доменам. В правилах маршрутизации доменов не найдено — разбор TLS/HTTP каждого соединения идёт впустую. Отключать стоит, только если вы уверены, что доменная маршрутизация не нужна.',
            file,
            location: `${name} → inbounds[${index}].sniffing.enabled`,
            fixable: true,
            fix: (all) => changeFile(all, file, (c) => edit(c, ['inbounds', index, 'sniffing', 'enabled'], false)),
          })
        }
      })
    }

    // ─── outbounds ───
    if (Array.isArray(json.outbounds)) {
      json.outbounds.forEach((outbound: any, index: number) => {
        if (!outbound || typeof outbound !== 'object') return
        const tag = outbound.tag ? `«${outbound.tag}»` : `#${index + 1}`
        const base = `${name} → outbounds[${index}]`

        if (outbound.mux?.enabled === true) {
          findings.push({
            id: `${file}:mux:${index}`,
            severity: 'medium',
            title: `Mux включён в ${tag}`,
            description:
              'Mux упаковывает несколько соединений в одно — добавляет работу процессору и плохо сочетается с XTLS Vision (Vision с mux не работает). На слабом роутере обычно быстрее без него.',
            file,
            location: `${base}.mux.enabled`,
            fixable: true,
            bulk: true,
            fix: (all) => changeFile(all, file, (c) => edit(c, ['outbounds', index, 'mux', 'enabled'], false)),
          })
        }

        if (outbound.protocol !== 'vless') return
        const stream = outbound.streamSettings ?? {}
        const network = String(stream.network ?? 'tcp').toLowerCase()
        const security = String(stream.security ?? 'none').toLowerCase()
        const users = collectVlessUsers(outbound)

        if (security === 'reality' && (network === 'tcp' || network === 'raw')) {
          users.forEach(({ path, flow }) => {
            if (flow === 'xtls-rprx-vision') return
            findings.push({
              id: `${file}:vision:${index}:${path.join('.')}`,
              severity: 'high',
              title: `VLESS + Reality без XTLS Vision в ${tag}`,
              description:
                'С flow "xtls-rprx-vision" Xray не шифрует повторно уже зашифрованный TLS-трафик (а на Linux передаёт его почти без участия процессора) — на слабом роутере это главный способ поднять скорость. Важно: на сервере у этого пользователя тоже должен быть flow xtls-rprx-vision (в Reality-подписках обычно так и есть), иначе подключение перестанет работать — после применения проверьте пинг или спидтест. Mux при этом будет отключён.',
              file,
              location: `${base} → flow`,
              fixable: true,
              fix: (all) =>
                changeFile(all, file, (c) => {
                  let next = edit(c, ['outbounds', index, ...path, 'flow'], 'xtls-rprx-vision')
                  if (outbound.mux?.enabled === true) next = edit(next, ['outbounds', index, 'mux', 'enabled'], false)
                  return next
                }),
            })
          })
        }

        if (HEAVY_TRANSPORTS[network]) {
          findings.push({
            id: `${file}:transport:${index}`,
            severity: 'low',
            title: `Транспорт ${HEAVY_TRANSPORTS[network]} в ${tag}`,
            description:
              'Транспорты поверх HTTP (XHTTP, gRPC, WebSocket и т.п.) добавляют свои заголовки и кадрирование и не поддерживают XTLS Vision. Если сервер умеет TCP (RAW) + Reality + Vision, такой профиль будет заметно быстрее на роутере. Меняется на стороне сервера/подписки — автоисправления нет.',
            file,
            location: `${base}.streamSettings.network`,
            fixable: false,
          })
        }
      })
    }
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  return findings.sort((a, b) => order[a.severity] - order[b.severity])
}

function hasDomainRules(files: ConfigFile[]): boolean {
  return files.some(({ content }) => {
    const rules = safeParse(content)?.routing?.rules
    return Array.isArray(rules) && rules.some((r: any) => (Array.isArray(r?.domain) ? r.domain.length > 0 : !!r?.domain))
  })
}

/** Пути (относительно outbound) к пользователям VLESS: settings.vnext[i].users[j] и плоский settings.flow. */
function collectVlessUsers(outbound: any): { path: JSONPath; flow: string }[] {
  const out: { path: JSONPath; flow: string }[] = []
  const vnext = outbound.settings?.vnext
  if (Array.isArray(vnext)) {
    vnext.forEach((server: any, i: number) => {
      if (!Array.isArray(server?.users)) return
      server.users.forEach((user: any, j: number) => {
        out.push({ path: ['settings', 'vnext', i, 'users', j], flow: String(user?.flow ?? '') })
      })
    })
  } else if (outbound.settings && (outbound.settings.address || outbound.settings.id)) {
    out.push({ path: ['settings'], flow: String(outbound.settings.flow ?? '') })
  }
  return out
}

// ─── Блокировка QUIC ───────────────────────────────────────────────────────────

export const QUIC_RULE_TAG = 'xkeen-ui-block-quic'

export interface QuicState {
  /** Файл с routing.rules (куда вставляется правило). */
  routingFile: string | null
  enabled: boolean
  blackholeTag: string | null
  /** Файл с outbounds (куда при необходимости добавляется blackhole). */
  outboundsFile: string | null
  error?: string
}

function isQuicRule(rule: any): boolean {
  if (!rule || typeof rule !== 'object') return false
  if (rule.ruleTag === QUIC_RULE_TAG) return true
  const network = String(rule.network ?? '')
    .toLowerCase()
    .replace(/\s/g, '')
  const port = String(rule.port ?? '').trim()
  return network === 'udp' && port === '443' && !rule.domain && !rule.ip && !rule.inboundTag
}

export function findQuicState(files: ConfigFile[]): QuicState {
  let routingFile: string | null = null
  let outboundsFile: string | null = null
  let blackholeTag: string | null = null
  let enabled = false
  for (const { file, content } of files) {
    const json = safeParse(content)
    if (!json) continue
    if (Array.isArray(json.routing?.rules) && !routingFile) routingFile = file
    if (Array.isArray(json.outbounds)) {
      outboundsFile ??= file
      const bh = json.outbounds.find((o: any) => o?.protocol === 'blackhole' && o?.tag)
      if (bh && !blackholeTag) blackholeTag = bh.tag
    }
  }
  for (const { content } of files) {
    const rules = safeParse(content)?.routing?.rules
    if (!Array.isArray(rules)) continue
    if (rules.some((r: any) => isQuicRule(r) && (!blackholeTag || r.outboundTag === blackholeTag || r.ruleTag === QUIC_RULE_TAG)))
      enabled = true
  }
  if (!routingFile) return { routingFile, enabled, blackholeTag, outboundsFile, error: 'Не найден файл с routing.rules' }
  if (!outboundsFile && !blackholeTag) return { routingFile, enabled, blackholeTag, outboundsFile, error: 'Не найден файл с outbounds' }
  return { routingFile, enabled, blackholeTag, outboundsFile }
}

function uniqueTag(files: ConfigFile[], base: string): string {
  const tags = new Set<string>()
  for (const { content } of files) {
    const outbounds = safeParse(content)?.outbounds
    if (Array.isArray(outbounds)) outbounds.forEach((o: any) => o?.tag && tags.add(o.tag))
  }
  if (!tags.has(base)) return base
  let i = 2
  while (tags.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

/** Изменения для включения/выключения блокировки QUIC (UDP 443). Правило ставится первым. */
export function buildQuicChanges(files: ConfigFile[], enable: boolean): FileChange[] {
  const state = findQuicState(files)
  if (state.error && enable) throw new Error(state.error)
  const working = files.map((f) => ({ ...f }))
  const set = (file: string, content: string) => {
    const target = working.find((f) => f.file === file)
    if (target) target.content = content
  }

  if (enable) {
    let tag = state.blackholeTag
    if (!tag && state.outboundsFile) {
      tag = uniqueTag(files, 'block')
      const target = working.find((f) => f.file === state.outboundsFile)!
      const tree = parseTree(target.content)
      const outboundsNode = tree ? findNodeAtLocation(tree, ['outbounds']) : undefined
      const count = outboundsNode?.children?.length ?? 0
      set(
        target.file,
        applyEdits(
          target.content,
          modify(
            target.content,
            ['outbounds', count],
            { tag, protocol: 'blackhole' },
            { formattingOptions: FORMAT, isArrayInsertion: true }
          )
        )
      )
    }
    const routing = working.find((f) => f.file === state.routingFile)!
    set(
      routing.file,
      applyEdits(
        routing.content,
        modify(
          routing.content,
          ['routing', 'rules', 0],
          { ruleTag: QUIC_RULE_TAG, type: 'field', network: 'udp', port: '443', outboundTag: tag },
          { formattingOptions: FORMAT, isArrayInsertion: true }
        )
      )
    )
  } else {
    for (const target of working) {
      // Удаляем с конца, чтобы индексы не сдвигались.
      const rules = safeParse(target.content)?.routing?.rules
      if (!Array.isArray(rules)) continue
      for (let i = rules.length - 1; i >= 0; i--) {
        if (!isQuicRule(rules[i])) continue
        target.content = removeArrayElement(target.content, ['routing', 'rules', i])
      }
    }
  }

  return working
    .map((f) => ({ file: f.file, before: files.find((o) => o.file === f.file)!.content, after: f.content }))
    .filter((c) => c.before !== c.after)
}

/**
 * Точечно вырезает элемент массива вместе с его запятой и строкой, не трогая соседние элементы и
 * комментарии (modify(..., undefined) в jsonc-parser захватывает комментарий следующего элемента).
 */
export function removeArrayElement(text: string, path: JSONPath): string {
  const tree = parseTree(text)
  const node = tree ? findNodeAtLocation(tree, path) : undefined
  if (!node) return text
  let start = node.offset
  let end = node.offset + node.length
  const isBlank = (ch: string) => ch === ' ' || ch === '\t'

  let lineStart = start
  while (lineStart > 0 && isBlank(text[lineStart - 1])) lineStart--
  const ownLine = lineStart === 0 || text[lineStart - 1] === '\n'

  let after = end
  while (after < text.length && isBlank(text[after])) after++
  if (text[after] === ',') {
    end = after + 1
    if (ownLine) {
      let eol = end
      while (eol < text.length && isBlank(text[eol])) eol++
      if (text[eol] === '\r') eol++
      if (text[eol] === '\n') {
        start = lineStart
        end = eol + 1
      }
    }
  } else {
    // Последний элемент: убираем запятую перед ним (если между ними только пробелы).
    let before = start - 1
    while (before >= 0 && /\s/.test(text[before])) before--
    if (text[before] === ',') start = before
  }
  return text.slice(0, start) + text.slice(end)
}

/** Объединяет изменения нескольких исправлений (последовательно, поверх друг друга). */
export function mergeChanges(files: ConfigFile[], builders: ((files: ConfigFile[]) => FileChange[])[]): FileChange[] {
  let working = files.map((f) => ({ ...f }))
  for (const build of builders) {
    for (const change of build(working)) {
      working = working.map((f) => (f.file === change.file ? { ...f, content: change.after } : f))
    }
  }
  return working
    .map((f) => ({ file: f.file, before: files.find((o) => o.file === f.file)!.content, after: f.content }))
    .filter((c) => c.before !== c.after)
}

// ─── Простой построчный diff для предпросмотра ───────────────────────────────

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string }

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // Отрезаем общий префикс/суффикс, LCS — только по середине (изменения точечные).
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA + 1)
  const midB = b.slice(start, endB + 1)
  const dp: number[][] = Array.from({ length: midA.length + 1 }, () => new Array(midB.length + 1).fill(0))
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const mid: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      mid.push({ type: 'same', text: midA[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ type: 'del', text: midA[i++] })
    else mid.push({ type: 'add', text: midB[j++] })
  }
  while (i < midA.length) mid.push({ type: 'del', text: midA[i++] })
  while (j < midB.length) mid.push({ type: 'add', text: midB[j++] })
  const context = 3
  const head = a.slice(Math.max(0, start - context), start).map((text) => ({ type: 'same' as const, text }))
  const tail = a.slice(endA + 1, endA + 1 + context).map((text) => ({ type: 'same' as const, text }))
  return [...head, ...mid, ...tail]
}
