import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { IconAlertTriangle, IconArrowsSplit2, IconPlus, IconSearch, IconTrash, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiCall } from '../../lib/api'
import {
  detectRule,
  fetchQuickRules,
  KIND_HINTS,
  KIND_LABELS,
  newRuleId,
  parseTargetKey,
  saveQuickRules,
  splitInput,
  targetKey,
  useQuickRulesPrefill,
  type QuickRule,
  type QuickRulesResponse,
  type QuickTargetItem,
} from '../../lib/quickRules'
import { getAppState, useAppContext, useCurrentCore, useModalContext } from '../../lib/store'
import type { Config } from '../../lib/types'
import { cn } from '../../lib/utils'

type Targets = NonNullable<QuickRulesResponse['targets']>

const TARGET_KIND_LABEL: Record<QuickTargetItem['kind'], string> = {
  outbound: 'Подключения',
  balancer: 'Балансировщики',
  group: 'Группы',
  proxy: 'Прокси',
  builtin: '',
}

function targetLabel(key: string): string {
  if (key === 'direct') return 'Напрямую'
  if (key === 'block') return 'Блокировать'
  return key.replace(/^proxy:/, '')
}

function serialize(rules: QuickRule[]): string {
  return JSON.stringify(rules.map((r) => [r.id, r.value, r.kind, r.target.type, r.target.tag, r.enabled, r.comment]))
}

/** Подтягивает изменённые бэкендом файлы в редактор, не затирая несохранённые правки. */
async function refreshEditorConfigs(): Promise<boolean> {
  const res = await apiCall<{ success: boolean; configs?: { file: string; content: string }[] }>('GET', 'configs').catch(() => null)
  if (!res?.success || !res.configs) return false
  const { configs, dispatch } = getAppState()
  const fresh = new Map(res.configs.map((c) => [c.file, c.content]))
  let conflict = false
  const next: Config[] = configs.map((c) => {
    const content = fresh.get(c.file)
    if (content === undefined || content === c.savedContent) return c
    if (c.isDirty) {
      conflict = true
      return { ...c, savedContent: content }
    }
    return { ...c, content, savedContent: content }
  })
  for (const [file, content] of fresh) {
    if (!configs.some((c) => c.file === file)) next.push({ file, content, savedContent: content, isDirty: false })
  }
  dispatch({ type: 'SET_CONFIGS', configs: next })
  return conflict
}

function TargetSelect({
  value,
  onChange,
  targets,
  core,
  className,
  size = 'default',
}: {
  value: string
  onChange: (value: string) => void
  targets: Targets
  core: string
  className?: string
  size?: 'sm' | 'default'
}) {
  const proxyItems = targets.items.filter((t) => t.kind !== 'builtin')
  const groups = (['group', 'balancer', 'outbound', 'proxy'] as const)
    .map((kind) =>
      proxyItems.filter((t) => t.kind === kind && !(core === 'xray' && (t.protocol === 'freedom' || t.protocol === 'blackhole')))
    )
    .filter((g) => g.length > 0)
  const items: Record<string, string> = { direct: 'Напрямую', block: 'Блокировать' }
  for (const t of proxyItems) items[`proxy:${t.tag}`] = t.tag
  if (value.startsWith('proxy:') && !(value in items)) items[value] = `${value.slice(6)} (не найдено)`

  return (
    <Select value={value} items={items} onValueChange={onChange}>
      <SelectTrigger size={size} popper className={cn('min-w-0', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-80">
        <SelectGroup>
          <SelectItem value="direct">Напрямую</SelectItem>
          <SelectItem value="block">Блокировать</SelectItem>
        </SelectGroup>
        {groups.map((group) => (
          <SelectGroup key={group[0].kind}>
            <SelectLabel>{TARGET_KIND_LABEL[group[0].kind]}</SelectLabel>
            {group.map((t) => (
              <SelectItem key={`${t.kind}:${t.tag}`} value={`proxy:${t.tag}`}>
                <span className="truncate">{t.tag}</span>
                {t.protocol && <span className="text-muted-foreground ml-auto text-xs">{t.protocol}</span>}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {value.startsWith('proxy:') && !proxyItems.some((t) => `proxy:${t.tag}` === value) && (
          <SelectGroup>
            <SelectItem value={value}>{items[value]}</SelectItem>
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  )
}

export function QuickRulesModal() {
  const { showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const core = useCurrentCore()
  const prefill = useQuickRulesPrefill()
  const open = modals.showQuickRulesModal

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [rules, setRules] = useState<QuickRule[]>([])
  const [savedKey, setSavedKey] = useState('[]')
  const [targets, setTargets] = useState<Targets>({ items: [] })
  const [warnings, setWarnings] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [exact, setExact] = useState(false)
  const [newTarget, setNewTarget] = useState('direct')
  const [search, setSearch] = useState('')

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showQuickRulesModal', show: false })
  const dirty = serialize(rules) !== savedKey

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchQuickRules(core)
      if (!data.success) throw new Error(data.error || 'Не удалось загрузить правила')
      const list = data.rules ?? []
      setRules(list)
      setSavedKey(serialize(list))
      setTargets(data.targets ?? { items: [] })
      setWarnings(data.warnings ?? [])
    } catch (e: any) {
      showToast(e.message, 'error')
    }
    setLoading(false)
  }, [core, showToast])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (prefill.nonce > 0) setInput(prefill.value)
  }, [prefill.nonce, prefill.value])

  const parsed = useMemo(() => splitInput(input).map((raw) => ({ raw, result: detectRule(raw, exact) })), [input, exact])
  const valid = parsed.filter((p) => !('error' in p.result))
  const invalid = parsed.filter((p) => 'error' in p.result)

  function addRules() {
    if (!valid.length) return
    const target = parseTargetKey(newTarget)
    const now = Math.floor(Date.now() / 1000)
    let added = 0
    let updated = 0
    setRules((prev) => {
      const next = [...prev]
      for (const { result } of valid) {
        if ('error' in result) continue
        const idx = next.findIndex((r) => r.kind === result.kind && r.value === result.value)
        if (idx >= 0) {
          next[idx] = { ...next[idx], target, enabled: true }
          updated++
        } else {
          next.unshift({ id: newRuleId(), value: result.value, kind: result.kind, target, enabled: true, comment: '', created: now })
          added++
        }
      }
      return next
    })
    setInput(invalid.map((p) => p.raw).join('\n'))
    setTimeout(() => {
      if (added || updated) showToast(`Добавлено: ${added}${updated ? `, обновлено: ${updated}` : ''}. Нажмите «Применить»`)
    }, 0)
  }

  function updateRule(id: string, patch: Partial<QuickRule>) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function removeRule(id: string) {
    setRules((prev) => prev.filter((r) => r.id !== id))
  }

  async function apply() {
    const hasDirtyEditor = getAppState().configs.some((c) => c.isDirty)
    if (
      hasDirtyEditor &&
      !confirm('В редакторе есть несохранённые изменения. Быстрые правила применятся к сохранённым файлам. Продолжить?')
    )
      return
    setSaving(true)
    try {
      const res = await saveQuickRules(core, rules)
      if (!res.success) throw new Error(res.error || 'Не удалось применить правила')
      const list = res.rules ?? rules
      setRules(list)
      setSavedKey(serialize(list))
      if (res.warning) showToast(res.warning, 'warning')
      else showToast('Правила применены')
      const conflict = await refreshEditorConfigs()
      if (conflict) showToast('Файл конфигурации изменён на диске, а в редакторе есть несохранённые правки', 'warning')
    } catch (e: any) {
      showToast(e.message, 'error')
    }
    setSaving(false)
  }

  function requestClose() {
    if (dirty && !confirm('Изменения не применены. Закрыть без сохранения?')) return
    close()
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rules
    return rules.filter(
      (r) => r.value.includes(q) || targetLabel(targetKey(r.target)).toLowerCase().includes(q) || r.comment.toLowerCase().includes(q)
    )
  }, [rules, search])

  const enabledCount = rules.filter((r) => r.enabled).length

  return (
    <Dialog open={open} onOpenChange={(o) => !o && requestClose()}>
      <DialogContent
        className="flex flex-col gap-4 overflow-hidden"
        style={{ maxHeight: '92vh', maxWidth: '44rem', width: 'calc(100vw - 2rem)' }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pb-3">
            <IconArrowsSplit2 size={22} />
            Маршрутизация доменов
          </DialogTitle>
          <DialogDescription>
            Направьте домен или IP напрямую, в блок или через выбранное подключение — без ручной правки конфига. Эти правила проверяются
            раньше остальных.
          </DialogDescription>
        </DialogHeader>

        <div className="border-border bg-card shrink-0 space-y-3 rounded-lg border p-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                addRules()
              }
            }}
            placeholder={'youtube.com\n1.2.3.0/24, geosite:category-ads-all'}
            className="max-h-32 min-h-14 font-mono text-[13px]"
            spellCheck={false}
          />
          {parsed.length > 0 && (
            <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
              {parsed.map(({ raw, result }, i) =>
                'error' in result ? (
                  <Badge key={`${raw}-${i}`} variant="destructive" className="rounded-sm" title={result.error}>
                    {raw}
                  </Badge>
                ) : (
                  <Badge key={`${raw}-${i}`} variant="outline" className="rounded-sm font-mono" title={KIND_HINTS[result.kind]}>
                    <span className="text-muted-foreground font-sans">{KIND_LABELS[result.kind]}</span> {result.value}
                  </Badge>
                )
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-muted-foreground mr-auto flex cursor-pointer items-center gap-2 text-[13px] font-normal">
              <Switch size="sm" checked={exact} onCheckedChange={setExact} />
              Только точный домен (без поддоменов)
            </Label>
            <TargetSelect value={newTarget} onChange={setNewTarget} targets={targets} core={core} className="w-48" />
            <Button onClick={addRules} disabled={!valid.length || loading}>
              <IconPlus /> Добавить{valid.length > 1 ? ` (${valid.length})` : ''}
            </Button>
          </div>
        </div>

        {warnings.length > 0 && (
          <Alert className="shrink-0 border-amber-500/20 p-2.5 text-amber-600 dark:text-amber-400">
            <IconAlertTriangle />
            <AlertDescription className="text-xs">{warnings.join('; ')}</AlertDescription>
          </Alert>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <InputGroup className="h-8 flex-1">
              <InputGroupAddon>
                <IconSearch className="size-4" />
              </InputGroupAddon>
              <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по правилам" />
              {search && (
                <InputGroupAddon align="inline-end">
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setSearch('')}>
                    <IconX className="size-4" />
                  </button>
                </InputGroupAddon>
              )}
            </InputGroup>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {enabledCount} / {rules.length}
            </span>
          </div>

          <div className="border-border min-h-24 flex-1 scrollbar-thin overflow-y-auto rounded-lg border">
            {loading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-2/3" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-muted-foreground flex h-24 items-center justify-center px-4 text-center text-[13px]">
                {rules.length ? 'Ничего не найдено' : 'Правил пока нет. Добавьте домен выше.'}
              </div>
            ) : (
              <ul className="divide-border divide-y">
                {filtered.map((rule) => (
                  <li
                    key={rule.id}
                    className={cn('flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap', !rule.enabled && 'opacity-55')}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate font-mono text-[13px]" title={rule.value}>
                        {rule.value}
                      </span>
                      <Badge variant="secondary" className="shrink-0 rounded-sm text-[10px]" title={KIND_HINTS[rule.kind]}>
                        {KIND_LABELS[rule.kind]}
                      </Badge>
                    </div>
                    <TargetSelect
                      size="sm"
                      value={targetKey(rule.target)}
                      onChange={(key) => updateRule(rule.id, { target: parseTargetKey(key) })}
                      targets={targets}
                      core={core}
                      className="w-40 text-[13px]"
                    />
                    <Switch checked={rule.enabled} onCheckedChange={(enabled) => updateRule(rule.id, { enabled })} aria-label="Включено" />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeRule(rule.id)}
                      aria-label="Удалить"
                      title="Удалить — домен пойдёт по обычным правилам"
                    >
                      <IconTrash className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-muted-foreground shrink-0 text-xs">
            Чтобы домен снова шёл по обычным правилам, удалите или выключите его.{' '}
            {core === 'xray'
              ? `Правила вставляются в начало routing.rules файла ${targets.routingFile ?? '05_routing.json'} с меткой xkeen-ui-quick.`
              : 'Правила хранятся в rule-providers xkeen-ui-quick-* и подключаются в начало rules файла config.yaml.'}
          </p>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={requestClose}>
            {dirty ? 'Отмена' : 'Закрыть'}
          </Button>
          <Button onClick={apply} disabled={!dirty || saving || loading}>
            {saving && <Spinner className="size-4" />}
            Применить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
