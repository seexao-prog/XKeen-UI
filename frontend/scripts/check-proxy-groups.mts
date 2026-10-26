// Ручная проверка applyMihomoPlan на реальном config.yaml:
//   node scripts/check-proxy-groups.mts <path/to/config.yaml>
// Добавляет тестовую эксклюзивную группу из первых прокси и проверяет, что YAML остаётся валидным,
// а вне proxy-groups ничего не меняется. Файл не входит в сборку (не импортируется приложением).
import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { applyMihomoPlan, type MihomoPlan } from '../src/lib/proxyGroups.ts'

const text = readFileSync(process.argv[2], 'utf8')
const js = parseDocument(text).toJS() as { proxies?: { name: string }[]; 'proxy-groups'?: { name: string }[] }
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

console.log(
  fails.length
    ? 'FAIL:\n' + fails.join('\n')
    : `OK: ${pg.length} групп, YAML валиден, остальной конфиг не тронут, повторное применение без дублей`
)
process.exit(fails.length ? 1 : 0)
