// Ручная проверка applyMihomoPlan на реальном config.yaml:
//   node scripts/check-proxy-groups.mts <path/to/config.yaml>
// 1) Добавляет тестовую эксклюзивную группу из первых прокси и проверяет, что YAML остаётся валидным,
//    а вне proxy-groups ничего не меняется.
// 2) Привязка группы к первому select-селектору (в конец и первой), повторное применение без дублей и снятие
//    привязки с возвратом исходного текста байт в байт.
// Файл не входит в сборку (не импортируется приложением).
import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { applyMihomoPlan, type MihomoPlan } from '../src/lib/proxyGroups.ts'

const text = readFileSync(process.argv[2], 'utf8')
const js = parseDocument(text).toJS() as {
  proxies?: { name: string }[]
  'proxy-groups'?: { name: string; type: string; proxies?: string[] }[]
}
const members = (js.proxies ?? []).slice(0, 2).map((p) => p.name)
const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|#]/g, (c) => '\\' + c)
const re = `^(?:${members.map(esc).join('|')})$`
const groupNames = (js['proxy-groups'] ?? []).map((g) => g.name)

const plan: MihomoPlan = {
  file: '/opt/etc/mihomo/config.yaml',
  groups: [
    {
      name: 'grp-test',
      type: 'url-test',
      proxies: members,
      url: 'http://cp.cloudflare.com/generate_204',
      interval: 300,
      tolerance: 50,
      lazy: true,
    },
  ],
  strip_names: ['grp-test'],
  fixes: groupNames.map((group) => ({ group, remove_proxies: [], exclude_remove: null, exclude_add: re })),
  managed: { mihomo_excludes: {} },
  warnings: [],
  errors: [],
} as unknown as MihomoPlan

const out = applyMihomoPlan(text, plan)
const after = parseDocument(out).toJS() as Record<string, unknown> & { 'proxy-groups': { name: string; 'exclude-filter'?: string }[] }
const before = parseDocument(text).toJS() as Record<string, unknown>
const fails: string[] = []
for (const k of Object.keys(before))
  if (k !== 'proxy-groups' && JSON.stringify(before[k]) !== JSON.stringify(after[k])) fails.push(`изменился ключ ${k}`)
const pg = after['proxy-groups']
if (pg.length !== groupNames.length + 1) fails.push(`групп ${pg.length}, ожидалось ${groupNames.length + 1}`)
if (pg[pg.length - 1].name !== 'grp-test') fails.push('новая группа не последняя')
for (const g of pg.slice(0, -1)) if (!g['exclude-filter']?.split('`').includes(re)) fails.push(`нет exclude-filter у ${g.name}`)

// Повторное применение (группа уже есть) — должно убрать старую и добавить заново, без дублей.
const out2 = applyMihomoPlan(out, { ...plan, fixes: [] })
const pg2 = (parseDocument(out2).toJS() as typeof after)['proxy-groups']
if (pg2.filter((g) => g.name === 'grp-test').length !== 1) fails.push('после повторного применения группа задублировалась')

// ─── Привязка к селектору ───
const selects = (js['proxy-groups'] ?? []).filter((g) => g.type === 'select')
const target = selects.find((g) => g.name === (process.argv[3] ?? 'YouTube')) ?? selects[0]
const attachResults: string[] = []
if (!target) fails.push('в конфиге нет select-селектора для проверки привязки')
else {
  const origList = target.proxies ?? []
  const listOf = (yaml: string) =>
    ((parseDocument(yaml).toJS() as typeof js)['proxy-groups'] ?? []).find((g) => g.name === target.name)?.proxies ?? []
  const bare = (fix: Partial<MihomoPlan['fixes'][number]>) =>
    ({
      ...plan,
      groups: [],
      strip_names: [],
      fixes: [{ group: target.name, remove_proxies: [], exclude_remove: null, exclude_add: null, ...fix }],
    }) as MihomoPlan
  const checkOthers = (yaml: string, label: string) => {
    const a = parseDocument(yaml).toJS() as Record<string, unknown> & { 'proxy-groups': { name: string }[] }
    for (const k of Object.keys(before))
      if (k !== 'proxy-groups' && JSON.stringify(before[k]) !== JSON.stringify(a[k])) fails.push(`${label}: изменился ключ ${k}`)
    const bg = (before['proxy-groups'] as { name: string }[]).filter((g) => g.name !== target.name)
    const ag = a['proxy-groups'].filter((g) => g.name !== target.name)
    if (JSON.stringify(bg) !== JSON.stringify(ag)) fails.push(`${label}: изменились другие группы`)
  }
  for (const first of [false, true]) {
    const label = first ? `«${target.name}», первой` : `«${target.name}», в конец`
    const attached = applyMihomoPlan(text, bare(first ? { prepend_proxies: ['grp-test'] } : { add_proxies: ['grp-test'] }))
    const list = listOf(attached)
    const expected = first ? ['grp-test', ...origList] : [...origList, 'grp-test']
    if (JSON.stringify(list) !== JSON.stringify(expected)) fails.push(`${label}: proxies = ${JSON.stringify(list)}`)
    checkOthers(attached, label)
    // повторное применение с пустым планом ничего не меняет
    if (applyMihomoPlan(attached, bare({})) !== attached) fails.push(`${label}: повторное применение изменило текст`)
    // снятие привязки — исходный текст байт в байт
    const detached = applyMihomoPlan(attached, bare({ remove_proxies: ['grp-test'] }))
    if (detached !== text) fails.push(`${label}: после снятия привязки текст не совпал с исходным`)
    // перестановка: из конца в начало и обратно
    const moved = applyMihomoPlan(
      attached,
      bare(
        first
          ? { remove_proxies: ['grp-test'], add_proxies: ['grp-test'] }
          : { remove_proxies: ['grp-test'], prepend_proxies: ['grp-test'] }
      )
    )
    const movedExpected = first ? [...origList, 'grp-test'] : ['grp-test', ...origList]
    if (JSON.stringify(listOf(moved)) !== JSON.stringify(movedExpected))
      fails.push(`${label}: перестановка дала ${JSON.stringify(listOf(moved))}`)
    // вместе с созданием группы и exclude-filter в той же группе (полное пересобирание узла)
    const combined = applyMihomoPlan(text, {
      ...plan,
      fixes: plan.fixes.map((f) =>
        f.group === target.name ? { ...f, ...(first ? { prepend_proxies: ['grp-test'] } : { add_proxies: ['grp-test'] }) } : f
      ),
    })
    if (JSON.stringify(listOf(combined)) !== JSON.stringify(expected))
      fails.push(`${label} + exclude-filter: proxies = ${JSON.stringify(listOf(combined))}`)
    attachResults.push(`${label}: ${JSON.stringify(list)}`)
    if (first) {
      const tl = attached.split('\n').find((l) => l.includes('grp-test'))
      attachResults.push(`  строка в config.yaml: ${tl?.trim()}`)
    }
  }
}

// ─── Синтетика: блочный список, отсутствие proxies, кавычки/запятые в именах ───
const synth = `proxy-groups:
  - name: Block # комментарий
    type: select
    proxies:
      - "🇺🇸 США, Атланта"
      - DIRECT # прямое
  - name: NoList
    type: select
    include-all: true
  - name: Flow
    type: select
    proxies: [a, "b, c"]
rules:
  - MATCH,DIRECT
`
const sFix = (group: string, fix: Partial<MihomoPlan['fixes'][number]>) =>
  ({
    ...plan,
    groups: [],
    strip_names: [],
    fixes: [{ group, remove_proxies: [], exclude_remove: null, exclude_add: null, ...fix }],
  }) as MihomoPlan
const sList = (yaml: string, name: string) =>
  ((parseDocument(yaml).toJS() as typeof js)['proxy-groups'] ?? []).find((g) => g.name === name)?.proxies ?? null
for (const [group, orig] of [
  ['Block', ['🇺🇸 США, Атланта', 'DIRECT']],
  ['NoList', null],
  ['Flow', ['a', 'b, c']],
] as const) {
  for (const first of [false, true]) {
    const name = 'grp-x, y'
    const out1 = applyMihomoPlan(synth, sFix(group, first ? { prepend_proxies: [name] } : { add_proxies: [name] }))
    const base = orig ? [...orig] : []
    const exp = first ? [name, ...base] : [...base, name]
    if (JSON.stringify(sList(out1, group)) !== JSON.stringify(exp))
      fails.push(`synth ${group} first=${first}: ${JSON.stringify(sList(out1, group))}`)
    if (!out1.includes('# комментарий') || !out1.includes('# прямое')) fails.push(`synth ${group}: потеряны комментарии`)
    const back = applyMihomoPlan(out1, sFix(group, { remove_proxies: [name] }))
    if (orig && back !== synth) fails.push(`synth ${group} first=${first}: снятие не вернуло исходный текст`)
    if (!orig && JSON.stringify(sList(back, group) ?? []) !== '[]')
      fails.push(`synth ${group}: после снятия ${JSON.stringify(sList(back, group))}`)
  }
}

console.log(
  fails.length
    ? 'FAIL:\n' + fails.join('\n')
    : `OK: ${pg.length} групп, YAML валиден, остальной конфиг не тронут, повторное применение без дублей\n` +
        `OK: привязка к селектору (в конец/первой), перестановка, снятие — исходный текст байт в байт\n` +
        attachResults.join('\n')
)
process.exit(fails.length ? 1 : 0)
