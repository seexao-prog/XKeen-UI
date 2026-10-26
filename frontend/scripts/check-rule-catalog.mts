// Проверка «Каталога правил» на реальном config.yaml (только чтение, файл не меняется):
//   node scripts/check-rule-catalog.mts <path/to/config.yaml> [--online]
// --online — дополнительно запрашивает каталог у GitHub (2 запроса к API) и проверяет поиск и синонимы.
import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import {
  buildCatalogChange,
  catalogFileUrl,
  defaultInsertIndex,
  defaultTemplate,
  detectFromUrl,
  findConnected,
  inspectConfig,
  loadCatalog,
  providerKey,
  searchCatalog,
} from '../src/lib/ruleCatalog.ts'

const text = readFileSync(process.argv[2], 'utf8')
const fails: string[] = []
const ok = (cond: unknown, msg: string) => {
  if (!cond) fails.push(msg)
}

/** Возвращает строки, которые есть в b, но не в a (как мультимножество), и признак «ничего не удалено». */
function addedOnly(a: string, b: string): { added: string[]; removedNothing: boolean } {
  const al = a.split('\n')
  const bl = b.split('\n')
  let i = 0
  const added: string[] = []
  for (const line of bl) {
    if (i < al.length && al[i] === line) i++
    else added.push(line)
  }
  return { added, removedNothing: i === al.length }
}

const inv = inspectConfig(text)
const template = defaultTemplate(inv)
const at = defaultInsertIndex(inv.rules)
console.log(`образец: ${template}; позиция по умолчанию: перед #${at + 1} «${inv.rules[at]?.text}»`)
console.log(`якоря: ${inv.anchors.map((a) => `${a.name}(${a.format}/${a.behavior})`).join(', ')}`)

// ── 1. Gemini: новый селектор с иконкой, образец AI ─────────────────────────────────────────
const gemini = { name: 'google-gemini', kind: 'geosite' as const }
ok(!findConnected(inv, gemini), 'google-gemini уже подключён — тест не показателен')
ok(findConnected(inv, { name: 'youtube', kind: 'geosite' }) === 'youtube@domain', 'findConnected не нашёл youtube@domain')
const icon = 'https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/AI.png'
const r1 = buildCatalogChange(text, {
  url: catalogFileUrl(gemini),
  ...detectFromUrl(catalogFileUrl(gemini)),
  providerName: providerKey('google-gemini', 'domain'),
  target: { mode: 'new', name: 'Gemini', icon, template: 'AI', excludeRu: true, extraVariants: [] },
  insertBefore: at,
})
const d1 = addedOnly(text, r1.text)
console.log('--- Gemini, добавленные строки:\n' + d1.added.join('\n'))
ok(d1.removedNothing, 'Gemini: исходные строки изменились')
const js1 = parseDocument(r1.text).toJS() as Record<string, any>
ok(
  r1.text.includes(
    'google-gemini@domain: { <<: *domain, url: https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/google-gemini.mrs }'
  ),
  'провайдер не через <<: *domain'
)
const ai = js1['proxy-groups'].find((g: any) => g.name === 'AI')
const gem = js1['proxy-groups'].find((g: any) => g.name === 'Gemini')
ok(gem, 'нет группы Gemini')
ok(gem?.type === 'select' && gem?.icon === icon, 'Gemini: type/icon')
// Группы панели (grp-*) из образца не копируются — они добавляются явно
const aiProxies = (ai?.proxies ?? []).filter((p: string) => !p.startsWith('grp-'))
ok(JSON.stringify(gem?.proxies) === JSON.stringify(aiProxies), `Gemini.proxies ≠ AI.proxies: ${JSON.stringify(gem?.proxies)}`)
ok(gem?.['include-all'] === ai?.['include-all'], 'include-all не скопирован')
const aiExclude = String(ai?.['exclude-filter'] ?? '')
  .split('`')
  .filter(Boolean)
const gemExclude = String(gem?.['exclude-filter'] ?? '')
  .split('`')
  .filter(Boolean)
ok(
  gemExclude[0] === '🇷🇺' && aiExclude.every((p) => gemExclude.includes(p)),
  `exclude-filter: ${gem?.['exclude-filter']} vs ${ai?.['exclude-filter']}`
)

// Вариант с группой панели впереди
const panelGroup = inv.groups.find((g) => g.panel)?.name
if (panelGroup) {
  const rx = buildCatalogChange(text, {
    url: catalogFileUrl(gemini),
    ...detectFromUrl(catalogFileUrl(gemini)),
    providerName: providerKey('google-gemini', 'domain'),
    target: { mode: 'new', name: 'Gemini', template: 'AI', excludeRu: true, extraVariants: [panelGroup] },
    insertBefore: at,
  })
  const gx = (parseDocument(rx.text).toJS() as any)['proxy-groups'].find((g: any) => g.name === 'Gemini')
  ok(gx?.proxies?.[0] === panelGroup, `группа панели не первой: ${JSON.stringify(gx?.proxies)}`)
}
const rules1: string[] = js1.rules
ok(rules1[at] === 'RULE-SET,google-gemini@domain,Gemini', `правило не на позиции ${at}: ${rules1[at]}`)
ok(rules1[rules1.length - 1] === 'MATCH,DIRECT', 'MATCH не последний')
const userGroups = js1['proxy-groups'].filter((g: any) => !String(g.name).startsWith('grp-'))
ok(userGroups[userGroups.length - 1].name === 'Gemini', 'Gemini не после последнего пользовательского селектора')
for (const k of Object.keys(parseDocument(text).toJS())) {
  if (['proxy-groups', 'rule-providers', 'rules'].includes(k)) continue
  ok(JSON.stringify((parseDocument(text).toJS() as any)[k]) === JSON.stringify(js1[k]), `изменился ключ ${k}`)
}
// Повторное создание — ошибка
let dupErr = ''
try {
  buildCatalogChange(r1.text, {
    url: catalogFileUrl(gemini),
    ...detectFromUrl(catalogFileUrl(gemini)),
    providerName: providerKey('google-gemini', 'domain'),
    target: { mode: 'new', name: 'Gemini', template: 'AI', excludeRu: true, extraVariants: [] },
    insertBefore: at,
  })
} catch (e) {
  dupErr = (e as Error).message
}
ok(dupErr, 'повторное создание не дало ошибку')
console.log(`повтор → «${dupErr}»`)
let commaErr = ''
try {
  buildCatalogChange(text, {
    url: catalogFileUrl(gemini),
    ...detectFromUrl(catalogFileUrl(gemini)),
    providerName: 'x@domain',
    target: { mode: 'new', name: 'A, B', excludeRu: false, extraVariants: [] },
    insertBefore: at,
  })
} catch (e) {
  commaErr = (e as Error).message
}
ok(/Запятая/.test(commaErr), 'запятая в названии не запрещена')

// ── 2. geoip: no-resolve и якорь ipcidr, в существующий селектор ───────────────────────────
const tg = { name: 'telegram', kind: 'geoip' as const }
const tgUrl = catalogFileUrl(tg)
ok(detectFromUrl(tgUrl).behavior === 'ipcidr', 'geoip → ipcidr')
const r2 = buildCatalogChange(text, {
  url: tgUrl,
  ...detectFromUrl(tgUrl),
  providerName: 'telegram-geoip@ipcidr',
  target: { mode: 'existing', group: 'Telegram' },
  insertBefore: at,
})
const d2 = addedOnly(text, r2.text)
console.log('--- geoip в существующий селектор, добавленные строки:\n' + d2.added.join('\n'))
ok(d2.removedNothing && d2.added.length === 2, `geoip: ожидалось 2 новые строки, получено ${d2.added.length}`)
ok(r2.text.includes('<<: *ipcidr'), 'geoip: нет <<: *ipcidr')
const rules2: string[] = (parseDocument(r2.text).toJS() as any).rules
ok(rules2[at] === 'RULE-SET,telegram-geoip@ipcidr,Telegram,no-resolve', `geoip правило: ${rules2[at]}`)
ok(
  (parseDocument(r2.text).toJS() as any)['proxy-groups'].length === (parseDocument(text).toJS() as any)['proxy-groups'].length,
  'geoip: добавилась группа'
)

// ── 3. Свой URL .list → classical/text, без якоря a3 при другом interval ────────────────────
const custom = 'https://example.com/lists/my-sites.list'
const det = detectFromUrl(custom)
ok(det.format === 'text' && det.behavior === 'classical', `свой .list: ${JSON.stringify(det)}`)
const r3 = buildCatalogChange(text, {
  url: custom,
  ...det,
  providerName: 'my-sites@classical',
  target: { mode: 'existing', group: 'DIRECT' },
  insertBefore: at,
})
ok(
  r3.text.includes('my-sites@classical: { <<: *classical, url: https://example.com/lists/my-sites.list }'),
  'свой .list: не через <<: *classical'
)

console.log(
  fails.length ? 'FAIL:\n' + fails.join('\n') : 'OK: config.yaml валиден, правки только добавляют строки, повтор и запятая отклоняются'
)

// ── 4. Онлайн: каталог и синонимы ───────────────────────────────────────────────────────────
if (process.argv.includes('--online')) {
  const data = await loadCatalog([], true)
  console.log(`каталог: geosite ${data.geosite.length}, geoip ${data.geoip.length}`)
  for (const [q, want] of [
    ['chatgpt', 'openai'],
    ['claude', 'anthropic'],
    ['gemini', 'google-gemini'],
    ['ютуб', 'youtube'],
    ['grok', 'xai'],
  ]) {
    const top = searchCatalog(data, q, 'all').hits[0]
    console.log(`  «${q}» → ${top?.name} (${top?.kind})`)
    ok(top?.name === want, `поиск «${q}» не нашёл ${want}`)
  }
  ok(data.geosite.length > 1000 && data.geoip.length > 100, 'каталог подозрительно мал')
  if (fails.length) console.log('FAIL:\n' + fails.join('\n'))
}
process.exit(fails.length ? 1 : 0)
