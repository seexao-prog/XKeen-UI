import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBolt,
  IconChevronDown,
  IconLink,
  IconPencil,
  IconPlus,
  IconSearch,
  IconStack2,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall } from '../../lib/api'
import {
  applyMihomoPlan,
  buildXrayChanges,
  emptyGroup,
  isValidTag,
  lineDiff,
  MIHOMO_STRATEGIES,
  slugify,
  XRAY_STRATEGIES,
  xrayOutboundsByTag,
  type FileChange,
  type Managed,
  type MihomoInventory,
  type MihomoPlan,
  type Observer,
  type ProxyGroup,
  type XrayInventory,
  type XrayPlan,
} from '../../lib/proxyGroups'
import {
  appendPingEntries,
  getAppState,
  selectClashProxy,
  syncClashApiPort,
  useAppContext,
  useModalContext,
  usePingHistoryStore,
  useProxiesStore,
} from '../../lib/store'
import { cn } from '../../lib/utils'

type View = 'list' | 'edit' | 'review'

interface LoadResult {
  success: boolean
  error?: string
  core: 'xray' | 'mihomo'
  groups: ProxyGroup[]
  observer: Observer
  managed: Managed
  inventory: XrayInventory | MihomoInventory
  pingUrl: string
}

interface ConfigFile {
  file: string
  content: string
}

const MIHOMO_FILE = '/opt/etc/mihomo/config.yaml'

function lastPing(history: { delay: number }[] | undefined): number | null {
  if (!history?.length) return null
  return history[history.length - 1].delay
}

function PingBadge({ delay }: { delay: number | null | undefined }) {
  if (delay == null) return null
  if (delay <= 0) return <Badge variant="rose">таймаут</Badge>
  return <Badge variant={delay < 300 ? 'emerald' : delay < 800 ? 'amber' : 'rose'}>{delay} мс</Badge>
}

function strategyTitle(g: ProxyGroup) {
  const list = g.core === 'xray' ? XRAY_STRATEGIES : MIHOMO_STRATEGIES
  return list.find((s) => s.id === g.strategy)?.title ?? g.strategy
}

export function ProxyGroupsModal({ onApplied }: { onApplied?: () => void }) {
  const { showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const open = modals.showProxyGroupsModal
  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showProxyGroupsModal', show: false })

  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<LoadResult | null>(null)
  const [files, setFiles] = useState<ConfigFile[]>([])
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [observer, setObserver] = useState<Observer>({ destination: '', interval: '1m', sampling: 5, timeout: '5s' })
  const [view, setView] = useState<View>('list')
  const [editIndex, setEditIndex] = useState<number>(-1)
  const [draft, setDraft] = useState<ProxyGroup | null>(null)
  const [status, setStatus] = useState<Record<string, { selected: string[] }>>({})

  // review
  const [plan, setPlan] = useState<XrayPlan | MihomoPlan | null>(null)
  const [changes, setChanges] = useState<FileChange[]>([])
  const [deletes, setDeletes] = useState<string[]>([])
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [acceptedFixes, setAcceptedFixes] = useState<Set<string>>(new Set())
  const [pendingGroups, setPendingGroups] = useState<ProxyGroup[]>([])
  const [busy, setBusy] = useState(false)
  /** «Сразу выбрать»: тег группы → селекторы, в которых её нужно выбрать после применения. */
  const [selectAfterApply, setSelectAfterApply] = useState<Record<string, string[]>>({})
  const [selectNow, setSelectNow] = useState(true)
  const [focusAttach, setFocusAttach] = useState(false)

  const core = data?.core ?? 'xray'
  const proxies = useProxiesStore((s) => s.proxies)
  const pingHistory = usePingHistoryStore((s) => s.history)
  const mihomoSmart = useMemo(
    () => Object.values(proxies).some((p: any) => typeof p?.type === 'string' && p.type.toLowerCase() === 'smart'),
    [proxies]
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [res, cfg] = await Promise.all([
        apiCall<LoadResult>('GET', 'proxy-groups'),
        apiCall<{ success: boolean; configs?: ConfigFile[] }>('GET', 'configs'),
      ])
      if (!res.success) throw new Error(res.error || 'ошибка загрузки')
      setData(res)
      setGroups(res.groups ?? [])
      setObserver(res.observer)
      setFiles((cfg.configs ?? []).map((c) => ({ file: c.file, content: c.content })))
      setView('list')
      if (res.core === 'xray') {
        apiCall<{ available?: boolean; groups?: Record<string, { selected: string[] }> }>('GET', 'proxy-groups/status')
          .then((s) => setStatus(s.groups ?? {}))
          .catch(() => {})
      }
    } catch (e: any) {
      showToast(`Группы прокси: ${e.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // ─── участники ──────────────────────────────────────────────────────────────────────────
  const candidates = useMemo(() => {
    if (!data) return [] as { name: string; provider?: string; label: string; ping: number | null }[]
    if (data.core === 'xray') {
      const inv = data.inventory as XrayInventory
      return inv.outbounds
        .filter((o) => !['freedom', 'blackhole', 'dns', 'loopback'].includes(o.protocol))
        .map((o) => ({ name: o.tag, label: o.protocol, ping: lastPing(pingHistory[o.tag]) }))
    }
    const inv = data.inventory as MihomoInventory
    const list: { name: string; provider?: string; label: string; ping: number | null }[] = inv.proxies.map((n) => ({
      name: n,
      label: 'прокси',
      ping: lastPing(proxies[n]?.history),
    }))
    const providerOf = new Map<string, string>()
    for (const p of useProxiesStore.getState().proxyProviders as any[]) {
      if (!p?.name || p.name === 'default' || p.vehicleType === 'Compatible') continue
      for (const px of p.proxies ?? []) if (px?.name) providerOf.set(px.name, p.name)
    }
    for (const [name, prov] of providerOf) {
      if (!inv.proxies.includes(name)) list.push({ name, provider: prov, label: prov, ping: lastPing(proxies[name]?.history) })
    }
    return list
  }, [data, pingHistory, proxies])

  const memberOwner = useCallback(
    (name: string, exceptIdx: number) => {
      const i = groups.findIndex((g, idx) => idx !== exceptIdx && g.members.some((m) => m.name === name))
      return i >= 0 ? groups[i] : null
    },
    [groups]
  )

  // ─── редактирование ───────────────────────────────────────────────────────────────────
  function startEdit(index: number, focusAttach = false) {
    setEditIndex(index)
    setDraft(index >= 0 ? structuredClone(groups[index]) : emptyGroup(core))
    setSelectNow(true)
    setFocusAttach(focusAttach)
    setView('edit')
  }

  function commitDraft(): ProxyGroup[] | null {
    if (!draft) return null
    const d = { ...draft, name: draft.name.trim() }
    if (!d.name) return (showToast('Укажите название группы', 'error'), null)
    if (!d.tag) d.tag = slugify(d.name)
    if (!isValidTag(d.tag)) return (showToast('Тег: только латиница, цифры, «-», «_», «.»', 'error'), null)
    if (groups.some((g, i) => i !== editIndex && g.tag === d.tag)) return (showToast('Такой тег уже есть', 'error'), null)
    if (!d.members.length) return (showToast('Выберите хотя бы один сервер', 'error'), null)
    if (d.exclusive) {
      const busyMember = d.members.find((m) => memberOwner(m.name, editIndex))
      if (busyMember)
        return (showToast(`«${busyMember.name}» уже в группе «${memberOwner(busyMember.name, editIndex)!.name}»`, 'error'), null)
    }
    const clash = d.members.find((m) => memberOwner(m.name, editIndex)?.exclusive)
    if (clash)
      return (showToast(`«${clash.name}» закреплён за эксклюзивной группой «${memberOwner(clash.name, editIndex)!.name}»`, 'error'), null)
    if (!d.id) d.id = d.tag
    if (d.core !== 'mihomo') {
      d.attach_to = []
      d.attach_first = false
    }
    // «Сразу выбрать» — только в новых для этой группы селекторах (чтобы не перебивать ручной выбор при каждой правке).
    const prevAttach = editIndex >= 0 && groups[editIndex].tag === d.tag ? (groups[editIndex].attach_to ?? []) : []
    const fresh = (d.attach_to ?? []).filter((s) => !prevAttach.includes(s))
    setSelectAfterApply(selectNow && d.enabled && fresh.length ? { [d.tag]: fresh } : {})
    const next = [...groups]
    if (editIndex >= 0) next[editIndex] = d
    else next.push(d)
    return next
  }

  // ─── применение ───────────────────────────────────────────────────────────────────────
  async function review(next: ProxyGroup[], nextRenames = renames, fixes = acceptedFixes) {
    setBusy(true)
    try {
      const res = await apiCall<{ success: boolean; error?: string; plan: XrayPlan | MihomoPlan; groups: ProxyGroup[] }>(
        'POST',
        'proxy-groups/preview',
        { groups: next, observer, renames: nextRenames, mihomo_smart: mihomoSmart }
      )
      if (!res.success) throw new Error(res.error || 'ошибка')
      const normalized = res.groups ?? next
      setPendingGroups(normalized)
      setPlan(res.plan)
      setRenames(nextRenames)
      if (core === 'xray') {
        const p = res.plan as XrayPlan
        const autoFixes = fixes.size ? fixes : new Set(p.selector_fixes.filter((f) => !f.unresolved.length).map((f) => f.balancer))
        setAcceptedFixes(autoFixes)
        const xrayFiles = files.filter((f) => /\.jsonc?$/.test(f.file) && f.file.startsWith('/opt/etc/xray/configs/'))
        const built = buildXrayChanges(xrayFiles, p, nextRenames, autoFixes)
        setChanges(built.changes)
        setDeletes(built.deletes)
      } else {
        const p = res.plan as MihomoPlan
        const main = files.find((f) => f.file === MIHOMO_FILE)
        if (!main) throw new Error('config.yaml не найден')
        const after = p.errors.length ? main.content : applyMihomoPlan(main.content, p)
        setChanges(after === main.content ? [] : [{ file: MIHOMO_FILE, before: main.content, after }])
        setDeletes([])
      }
      setView('review')
    } catch (e: any) {
      showToast(`Не удалось подготовить изменения: ${e.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  function toggleRename(member: string, suggested: string, on: boolean) {
    const nextRenames = { ...renames }
    if (on) nextRenames[member] = suggested
    else delete nextRenames[member]
    const nextGroups = pendingGroups.map((g) => ({
      ...g,
      members: g.members.map((m) => {
        if (on && m.name === member) return { ...m, name: suggested }
        if (!on && m.name === suggested && renames[member] === suggested) return { ...m, name: member }
        return m
      }),
      fallback: on && g.fallback === member ? suggested : g.fallback,
    }))
    void review(nextGroups, nextRenames)
  }

  function toggleFix(balancer: string, on: boolean) {
    const s = new Set(acceptedFixes)
    if (on) s.add(balancer)
    else s.delete(balancer)
    void review(pendingGroups, renames, s)
  }

  async function apply() {
    if (!plan || plan.errors.length) return
    setBusy(true)
    try {
      const body = {
        groups: pendingGroups,
        observer,
        managed: core === 'mihomo' ? (plan as MihomoPlan).managed : data?.managed,
        files: changes.filter((c) => c.after !== null).map((c) => ({ file: c.file, content: c.after })),
        delete: deletes,
      }
      const res = await apiCall<{ success: boolean; error?: string; needRestart?: boolean }>('PUT', 'proxy-groups', body, {
        timeoutMs: 60000,
      })
      if (!res.success) throw new Error(res.error || 'ошибка')
      if (res.needRestart) {
        const r = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'hardRestart', core: 'mihomo' })
        if (!r.success) throw new Error(r.error || 'ошибка перезапуска')
      }
      showToast('Группы прокси применены')
      setRenames({})
      setAcceptedFixes(new Set())
      onApplied?.()
      if (core === 'mihomo') await selectAttached()
      await load()
    } catch (e: any) {
      showToast(`Не применено: ${e.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /** После hot reload выбирает новую группу в отмеченных селекторах через Clash API (как клик во вкладке селекторов). */
  async function selectAttached() {
    const pairs = Object.entries(selectAfterApply).flatMap(([tag, selectors]) => selectors.map((s) => [s, tag] as const))
    setSelectAfterApply({})
    if (!pairs.length) return
    syncClashApiPort()
    const { clashApiPort, clashApiSecret, clashApiUnix } = getAppState()
    if (!clashApiPort && !clashApiUnix) {
      showToast('Выберите группу в селекторах вручную: Clash API недоступен', 'error')
      return
    }
    const failed: string[] = []
    for (const [selector, tag] of pairs) {
      let ok = false
      // после перезагрузки конфига группа появляется в Clash API не мгновенно
      for (const delay of [0, 700, 1500]) {
        if (delay) await new Promise((r) => setTimeout(r, delay))
        try {
          await selectClashProxy(clashApiPort ?? '', clashApiSecret, clashApiUnix, selector, tag)
          ok = true
          break
        } catch {
          /* повтор */
        }
      }
      if (!ok) failed.push(selector)
    }
    if (failed.length) showToast(`Не удалось выбрать группу в: ${failed.join(', ')}`, 'error')
    else showToast(`Выбрано в селекторах: ${pairs.map(([s]) => s).join(', ')}`)
  }

  function removeGroup(index: number) {
    const next = groups.filter((_, i) => i !== index)
    void review(next)
  }

  function toggleEnabled(index: number, enabled: boolean) {
    const next = groups.map((g, i) => (i === index ? { ...g, enabled } : g))
    void review(next)
  }

  // ─── пинг участников (xray) ─────────────────────────────────────────────────────────────
  const [pinging, setPinging] = useState(false)
  async function pingMembers(names: string[]) {
    if (core !== 'xray' || !names.length) return
    const byTag = xrayOutboundsByTag(files.filter((f) => /\.jsonc?$/.test(f.file)))
    const outbounds = names.map((n) => byTag.get(n)).filter(Boolean)
    if (!outbounds.length) return
    setPinging(true)
    try {
      const r = await apiCall<{
        success: boolean
        error?: string
        results?: { tag: string; success: boolean; latency_ms?: number; error?: string }[]
      }>('POST', 'healthcheck/all', { outbounds }, { timeoutMs: 45000 })
      if (!r.success) throw new Error(r.error || 'ошибка')
      appendPingEntries(
        (r.results ?? []).map((x) => ({ tag: x.tag, delay: x.success ? (x.latency_ms ?? 0) : 0, error: x.success ? undefined : x.error }))
      )
    } catch (e: any) {
      showToast(`Пинг: ${e.message}`, 'error')
    } finally {
      setPinging(false)
    }
  }

  // ─── рендер ─────────────────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent className="w-full max-w-200! p-0!">
        <div className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 pr-8">
              {view !== 'list' && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setView(view === 'review' && draft ? 'edit' : 'list')}
                  disabled={busy}
                >
                  <IconArrowLeft />
                </Button>
              )}
              <IconStack2 size={22} />
              {view === 'list'
                ? 'Группы прокси'
                : view === 'edit'
                  ? editIndex >= 0
                    ? 'Редактирование группы'
                    : 'Новая группа'
                  : 'Проверка изменений'}
            </DialogTitle>
            <DialogDescription>
              {view === 'list' &&
                'Закрепите серверы за группой (например, быстрые — только под YouTube) и выберите, как между ними балансировать. Панель сама впишет группу в конфиг.'}
              {view === 'edit' && 'Серверы эксклюзивной группы не попадут в другие балансировщики и группы.'}
              {view === 'review' && 'Вот что изменится в конфигах. Ничего не записано, пока вы не нажмёте «Применить».'}
            </DialogDescription>
          </DialogHeader>

          {loading || !data ? (
            <div className="text-muted-foreground flex min-h-60 items-center justify-center gap-2 text-sm">
              <Spinner /> Загрузка…
            </div>
          ) : view === 'list' ? (
            <ListView
              groups={groups}
              core={core}
              status={status}
              proxies={proxies}
              busy={busy}
              observer={observer}
              setObserver={setObserver}
              inventory={data.inventory}
              onEdit={startEdit}
              onAttach={(i) => startEdit(i, true)}
              onDelete={removeGroup}
              onToggle={toggleEnabled}
              onApplyObserver={() => void review(groups)}
            />
          ) : view === 'edit' && draft ? (
            <EditView
              draft={draft}
              setDraft={setDraft}
              core={core}
              candidates={candidates}
              memberOwner={(n) => memberOwner(n, editIndex)}
              freedomTags={core === 'xray' ? (data.inventory as XrayInventory).outbounds.map((o) => o.tag) : []}
              pinging={pinging}
              onPing={() => void pingMembers(draft.members.map((m) => m.name))}
              mihomoSmart={mihomoSmart}
              selectors={
                core === 'mihomo' ? (data.inventory as MihomoInventory).groups.filter((g) => !groups.some((x) => x.tag === g.name)) : []
              }
              selectNow={selectNow}
              setSelectNow={setSelectNow}
              focusAttach={focusAttach}
            />
          ) : (
            <ReviewView
              plan={plan}
              changes={changes}
              core={core}
              renames={renames}
              acceptedFixes={acceptedFixes}
              onRename={toggleRename}
              onFix={toggleFix}
              busy={busy}
            />
          )}

          <DialogFooter className="shrink-0">
            {view === 'list' && (
              <Button onClick={() => startEdit(-1)} disabled={loading || busy} className="w-full sm:w-auto">
                <IconPlus /> Создать группу
              </Button>
            )}
            {view === 'edit' && (
              <Button
                onClick={() => {
                  const next = commitDraft()
                  if (next) void review(next)
                }}
                disabled={busy}
                className="w-full sm:w-auto"
              >
                {busy ? <Spinner /> : null} Далее: проверить изменения
              </Button>
            )}
            {view === 'review' && (
              <Button onClick={() => void apply()} disabled={busy || !plan || plan.errors.length > 0} className="w-full sm:w-auto">
                {busy ? <Spinner /> : null} Применить
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Список ─────────────────────────────────────────────────────────────────────────────────

function ListView(props: {
  groups: ProxyGroup[]
  core: 'xray' | 'mihomo'
  status: Record<string, { selected: string[] }>
  proxies: Record<string, any>
  busy: boolean
  observer: Observer
  setObserver: (o: Observer) => void
  inventory: XrayInventory | MihomoInventory
  onEdit: (i: number) => void
  onAttach: (i: number) => void
  onDelete: (i: number) => void
  onToggle: (i: number, on: boolean) => void
  onApplyObserver: () => void
}) {
  const { groups, core, status, proxies, busy } = props
  const [obsOpen, setObsOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const refs = core === 'xray' ? (props.inventory as XrayInventory).rule_balancer_refs : (props.inventory as MihomoInventory).rule_targets
  return (
    <ScrollArea className="h-120 min-h-0" hideScrollbar>
      <div className="flex flex-col gap-2 px-0.5 py-1">
        {groups.length === 0 && (
          <div className="text-muted-foreground flex min-h-50 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm">
            <IconStack2 size={28} className="opacity-60" />
            Групп пока нет
          </div>
        )}
        {groups.map((g, i) => {
          const now = core === 'xray' ? status[g.tag]?.selected?.join(', ') : proxies[g.tag]?.now
          const used = refs.includes(g.tag)
          return (
            <div key={g.id || g.tag} className={cn('rounded-lg border px-3 py-3 transition-colors', !g.enabled && 'opacity-60')}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{g.name}</span>
                    <code className="text-muted-foreground font-mono text-xs">{g.tag}</code>
                    <Badge variant="secondary">{strategyTitle(g)}</Badge>
                    {g.exclusive && <Badge variant="outline">эксклюзивная</Badge>}
                    {used && <Badge variant="sky">в правилах</Badge>}
                  </div>
                  {core === 'mihomo' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {g.attach_to?.length ? (
                        <>
                          <span className="text-muted-foreground text-xs">вариант в селекторах:</span>
                          {g.attach_to.map((s) => (
                            <Badge key={s} variant="secondary">
                              {s}
                              {g.attach_first ? ' ★' : ''}
                            </Badge>
                          ))}
                        </>
                      ) : (
                        <span className="text-muted-foreground text-xs">пока отдельный селектор, ни к чему не привязана</span>
                      )}
                      <Button variant="outline" size="xs" className="ml-1" onClick={() => props.onAttach(i)} disabled={busy}>
                        <IconLink /> {g.attach_to?.length ? 'Изменить' : 'Привязать к селектору'}
                      </Button>
                    </div>
                  )}
                  <div className="text-muted-foreground mt-1 truncate text-xs">
                    {g.members.length} серв.: {g.members.map((m) => m.name).join(', ')}
                  </div>
                  {now && (
                    <div className="mt-1 text-xs">
                      <span className="text-muted-foreground">Сейчас: </span>
                      <span className="font-medium">{now}</span>
                    </div>
                  )}
                </div>
                <Switch checked={g.enabled} disabled={busy} onCheckedChange={(v) => props.onToggle(i, v)} aria-label="Включена" />
                <Button variant="ghost" size="icon-sm" onClick={() => props.onEdit(i)} disabled={busy} aria-label="Изменить">
                  <IconPencil />
                </Button>
                {confirmDelete === i ? (
                  <Button variant="destructive" size="sm" onClick={() => props.onDelete(i)} disabled={busy}>
                    Удалить?
                  </Button>
                ) : (
                  <Button variant="ghost" size="icon-sm" onClick={() => setConfirmDelete(i)} disabled={busy} aria-label="Удалить">
                    <IconTrash />
                  </Button>
                )}
              </div>
            </div>
          )
        })}

        <div className="text-muted-foreground mt-2 rounded-lg border border-dashed p-3 text-xs leading-relaxed">
          {core === 'mihomo' && (
            <>
              Чтобы выбирать группу внутри своего селектора (например, в «AI» вместо «Заблок. сервисы»), нажмите «Привязать к селектору».
              Привязанная группа перестаёт показываться отдельной карточкой. Или направьте домены прямо в группу — в «Маршрутизации доменов»
              или в правилах:{' '}
            </>
          )}
          {core === 'xray' && <>Чтобы направить домены в группу, выберите её тег как цель в «Маршрутизации доменов» или в правилах: </>}
          {core === 'xray' ? (
            <code className="font-mono">"balancerTag": "grp-…"</code>
          ) : (
            <code className="font-mono">DOMAIN-SUFFIX,youtube.com,grp-…</code>
          )}
          .
        </div>

        {core === 'xray' && (
          <div className="rounded-lg border">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-left text-sm font-medium"
              onClick={() => setObsOpen((v) => !v)}
            >
              Наблюдатель (проверка серверов)
              <IconChevronDown size={16} className={cn('transition-transform', obsOpen && 'rotate-180')} />
            </button>
            {obsOpen && (
              <div className="flex flex-col gap-3 border-t px-3 py-3">
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Нужен стратегиям «Умная», «Минимальный пинг», «Наименьшая нагрузка» и группам с резервом. Xray сам шлёт короткий
                  HEAD-запрос через каждый сервер группы — в среднем один раз за интервал. По умолчанию это один запрос в минуту на сервер:
                  на роутере практически незаметно. Чаще 30 с ставить не стоит.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="URL проверки">
                    <Input
                      placeholder="из настроек панели"
                      value={props.observer.destination}
                      onChange={(e) => props.setObserver({ ...props.observer, destination: e.target.value })}
                    />
                  </Field>
                  <Field label="Интервал">
                    <Input
                      value={props.observer.interval}
                      onChange={(e) => props.setObserver({ ...props.observer, interval: e.target.value })}
                    />
                  </Field>
                  <Field label="Окно замеров">
                    <Input
                      type="number"
                      min={2}
                      max={20}
                      value={props.observer.sampling}
                      onChange={(e) => props.setObserver({ ...props.observer, sampling: Number(e.target.value) || 5 })}
                    />
                  </Field>
                  <Field label="Таймаут">
                    <Input
                      value={props.observer.timeout}
                      onChange={(e) => props.setObserver({ ...props.observer, timeout: e.target.value })}
                    />
                  </Field>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={busy || !groups.length}
                  onClick={props.onApplyObserver}
                >
                  Применить параметры наблюдателя
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label className="text-muted-foreground text-xs">{label}</Label>
      {children}
    </div>
  )
}

// ─── Редактор ───────────────────────────────────────────────────────────────────────────────

function EditView(props: {
  draft: ProxyGroup
  setDraft: (g: ProxyGroup) => void
  core: 'xray' | 'mihomo'
  candidates: { name: string; provider?: string; label: string; ping: number | null }[]
  memberOwner: (name: string) => ProxyGroup | null
  freedomTags: string[]
  pinging: boolean
  onPing: () => void
  mihomoSmart: boolean
  selectors: MihomoInventory['groups']
  selectNow: boolean
  setSelectNow: (v: boolean) => void
  focusAttach?: boolean
}) {
  const { draft, setDraft, core, candidates } = props
  const attachRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (props.focusAttach) attachRef.current?.scrollIntoView({ block: 'start' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [query, setQuery] = useState('')
  const [selQuery, setSelQuery] = useState('')
  const [showAllTypes, setShowAllTypes] = useState(false)
  const attached = new Set(draft.attach_to ?? [])
  const memberSet = new Set(draft.members.map((m) => m.name))
  const selectorList = props.selectors.filter(
    (s) =>
      (showAllTypes || s.type === 'select' || attached.has(s.name)) &&
      s.name !== draft.tag &&
      s.name.toLowerCase().includes(selQuery.toLowerCase())
  )
  const hiddenTypes = props.selectors.filter((s) => s.type !== 'select').length
  function toggleSelector(name: string) {
    const next = attached.has(name) ? (draft.attach_to ?? []).filter((n) => n !== name) : [...(draft.attach_to ?? []), name]
    setDraft({ ...draft, attach_to: next })
  }
  const [advanced, setAdvanced] = useState(false)
  const set = (patch: Partial<ProxyGroup>) => setDraft({ ...draft, ...patch })
  const setS = (patch: Partial<ProxyGroup['settings']>) => setDraft({ ...draft, settings: { ...draft.settings, ...patch } })
  const selected = new Set(draft.members.map((m) => m.name))
  const filtered = candidates.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
  const strategies = core === 'xray' ? XRAY_STRATEGIES : MIHOMO_STRATEGIES
  const costs = draft.settings.costs ?? {}

  function toggleMember(c: { name: string; provider?: string }) {
    if (selected.has(c.name)) set({ members: draft.members.filter((m) => m.name !== c.name) })
    else set({ members: [...draft.members, { name: c.name, ...(c.provider ? { provider: c.provider } : {}) }] })
  }

  function togglePreferred(name: string) {
    const next = { ...costs }
    if (next[name]) delete next[name]
    else next[name] = 0.5
    setS({ costs: next })
  }

  return (
    <ScrollArea className="h-120 min-h-0" hideScrollbar>
      <div className="flex flex-col gap-4 px-0.5 py-1">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Название">
            <Input value={draft.name} placeholder="Например, YouTube" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Тег (для правил)">
            <Input
              value={draft.tag}
              placeholder={draft.name ? slugify(draft.name) : 'grp-…'}
              onChange={(e) => set({ tag: e.target.value.trim() })}
              className="font-mono"
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
          <div>
            <div className="text-sm font-medium">Эксклюзивная</div>
            <div className="text-muted-foreground text-xs">Серверы группы убираются из остальных балансировщиков и групп</div>
          </div>
          <Switch checked={draft.exclusive} onCheckedChange={(v) => set({ exclusive: v })} />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm">
              Серверы <span className="text-muted-foreground">({draft.members.length})</span>
            </Label>
            {core === 'xray' && (
              <Button variant="outline" size="sm" onClick={props.onPing} disabled={props.pinging || !draft.members.length}>
                {props.pinging ? <Spinner /> : <IconBolt />} Пинг выбранных
              </Button>
            )}
          </div>
          <div className="relative">
            <IconSearch size={14} className="text-muted-foreground absolute top-1/2 left-2.5 -translate-y-1/2" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по тегу/имени" className="pl-8" />
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border">
            {filtered.length === 0 && <div className="text-muted-foreground p-4 text-center text-sm">Ничего не найдено</div>}
            {filtered.map((c) => {
              const owner = props.memberOwner(c.name)
              const blocked = !selected.has(c.name) && !!owner && (owner.exclusive || draft.exclusive)
              const isSel = selected.has(c.name)
              return (
                <div
                  key={`${c.provider ?? ''}/${c.name}`}
                  className={cn(
                    'flex items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0',
                    blocked ? 'opacity-50' : 'hover:bg-accent/40 cursor-pointer'
                  )}
                  onClick={() => !blocked && toggleMember(c)}
                >
                  <Checkbox checked={isSel} disabled={blocked} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{c.name}</span>
                  {owner && <Badge variant={owner.exclusive ? 'amber' : 'secondary'}>в «{owner.name}»</Badge>}
                  <span className="text-muted-foreground hidden text-xs sm:inline">{c.label}</span>
                  <PingBadge delay={c.ping} />
                  {core === 'xray' && isSel && (draft.strategy === 'smart' || draft.strategy === 'leastLoad') && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground cursor-pointer"
                      title="Предпочтительный: выбирается чаще"
                      onClick={(e) => {
                        e.stopPropagation()
                        togglePreferred(c.name)
                      }}
                    >
                      {costs[c.name] ? <IconStarFilled size={15} className="text-amber-500" /> : <IconStar size={15} />}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-sm">Балансировка</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {strategies.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => set({ strategy: s.id })}
                className={cn(
                  'cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors',
                  draft.strategy === s.id
                    ? 'border-foreground bg-accent/60'
                    : 'border-border hover:bg-accent/40 hover:border-(--focus-border)'
                )}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  {s.title}
                  {s.id === 'smart' && <Badge variant="emerald">рекомендуется</Badge>}
                  {s.id === 'smart' && core === 'mihomo' && !props.mihomoSmart && <Badge variant="secondary">url-test</Badge>}
                </div>
                <div className="text-muted-foreground mt-1 text-xs leading-relaxed">{s.hint}</div>
              </button>
            ))}
          </div>
        </div>

        {core === 'mihomo' && (
          <div ref={attachRef} className="flex scroll-mt-2 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm">
                Показывать в селекторах <span className="text-muted-foreground">({attached.size})</span>
              </Label>
              {hiddenTypes > 0 && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
                  onClick={() => setShowAllTypes((v) => !v)}
                >
                  {showAllTypes ? 'Только select' : `Все типы (+${hiddenTypes})`}
                </button>
              )}
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Группа появится вариантом выбора в отмеченных селекторах — например, в «AI» можно будет выбрать её вместо «Заблок. сервисы».
              Панель допишет её в <code className="font-mono">proxies</code> селектора, а саму группу скроет из списка селекторов (
              <code className="font-mono">hidden: true</code>), чтобы она не висела отдельной карточкой. Снимите отметку — всё вернётся.
            </p>
            {props.selectors.length > 6 && (
              <div className="relative">
                <IconSearch size={14} className="text-muted-foreground absolute top-1/2 left-2.5 -translate-y-1/2" />
                <Input value={selQuery} onChange={(e) => setSelQuery(e.target.value)} placeholder="Поиск селектора" className="pl-8" />
              </div>
            )}
            <div className="max-h-48 overflow-y-auto rounded-lg border">
              {selectorList.length === 0 && <div className="text-muted-foreground p-4 text-center text-sm">Селекторов нет</div>}
              {selectorList.map((s) => {
                const cycle = memberSet.has(s.name)
                const isSel = attached.has(s.name)
                return (
                  <div
                    key={s.name}
                    className={cn(
                      'flex items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0',
                      cycle ? 'opacity-50' : 'hover:bg-accent/40 cursor-pointer'
                    )}
                    onClick={() => !cycle && toggleSelector(s.name)}
                    title={cycle ? 'Этот селектор — участник группы: получится цикл' : undefined}
                  >
                    <Checkbox checked={isSel} disabled={cycle} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    {s.type !== 'select' && <Badge variant="secondary">{s.type}</Badge>}
                    {s.proxies.includes(draft.tag) && !isSel && <Badge variant="outline">уже вписана вручную</Badge>}
                    <span className="text-muted-foreground hidden text-xs sm:inline">{s.proxies.length} вар.</span>
                  </div>
                )
              })}
            </div>
            {attached.size > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Вариант по умолчанию</div>
                    <div className="text-muted-foreground text-xs">
                      Поставить первой в списке — mihomo выбирает её, если в селекторе ещё ничего не выбрано
                    </div>
                  </div>
                  <Switch checked={!!draft.attach_first} onCheckedChange={(v) => set({ attach_first: v })} />
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={props.selectNow} onCheckedChange={(v) => props.setSelectNow(!!v)} />
                  Сразу выбрать эту группу в новых отмеченных селекторах
                </label>
              </div>
            )}
          </div>
        )}

        {core === 'xray' && (
          <Field label="Резерв, если все серверы группы недоступны">
            <Select value={draft.fallback || '__none'} onValueChange={(v) => set({ fallback: v === '__none' ? '' : v })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="__none">Не задан (основной outbound)</SelectItem>
                  {props.freedomTags
                    .filter((t) => !selected.has(t))
                    .map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}

        <div className="rounded-lg border">
          <button
            type="button"
            className="flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-left text-sm font-medium"
            onClick={() => setAdvanced((v) => !v)}
          >
            Дополнительные параметры
            <IconChevronDown size={16} className={cn('transition-transform', advanced && 'rotate-180')} />
          </button>
          {advanced && (
            <div className="grid grid-cols-2 gap-3 border-t px-3 py-3 sm:grid-cols-4">
              {core === 'xray' && (draft.strategy === 'smart' || draft.strategy === 'leastLoad') && (
                <>
                  <Field label="Держать лучших">
                    <Input
                      type="number"
                      min={1}
                      placeholder="2"
                      value={draft.settings.expected ?? ''}
                      onChange={(e) => setS({ expected: e.target.value ? Number(e.target.value) : null })}
                    />
                  </Field>
                  <Field label="Макс. пинг">
                    <Input
                      placeholder="1500ms"
                      value={draft.settings.max_rtt ?? ''}
                      onChange={(e) => setS({ max_rtt: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Допуст. потери (0–1)">
                    <Input
                      type="number"
                      step="0.05"
                      min={0}
                      max={1}
                      placeholder="0.25"
                      value={draft.settings.tolerance ?? ''}
                      onChange={(e) => setS({ tolerance: e.target.value ? Number(e.target.value) : null })}
                    />
                  </Field>
                  <Field label="Пороги разброса">
                    <Input
                      placeholder="150ms, 400ms"
                      value={(draft.settings.baselines ?? []).join(', ')}
                      onChange={(e) =>
                        setS({
                          baselines: e.target.value
                            .split(',')
                            .map((x) => x.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </Field>
                </>
              )}
              {core === 'xray' && !['smart', 'leastLoad'].includes(draft.strategy) && (
                <p className="text-muted-foreground col-span-full text-xs">У этой стратегии нет дополнительных параметров.</p>
              )}
              {core === 'mihomo' && draft.strategy !== 'select' && (
                <>
                  <Field label="URL проверки" className="col-span-2">
                    <Input
                      placeholder="из настроек панели"
                      value={draft.settings.url ?? ''}
                      onChange={(e) => setS({ url: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Интервал, с">
                    <Input
                      type="number"
                      placeholder="300"
                      value={draft.settings.interval ?? ''}
                      onChange={(e) => setS({ interval: e.target.value ? Number(e.target.value) : null })}
                    />
                  </Field>
                  <Field label="Таймаут, мс">
                    <Input
                      type="number"
                      placeholder="5000"
                      value={draft.settings.timeout ?? ''}
                      onChange={(e) => setS({ timeout: e.target.value ? Number(e.target.value) : null })}
                    />
                  </Field>
                  {(draft.strategy === 'url-test' || (draft.strategy === 'smart' && !props.mihomoSmart)) && (
                    <Field label="Допуск, мс">
                      <Input
                        type="number"
                        placeholder="50"
                        value={draft.settings.mihomo_tolerance ?? ''}
                        onChange={(e) => setS({ mihomo_tolerance: e.target.value ? Number(e.target.value) : null })}
                      />
                    </Field>
                  )}
                  <Field label="Отказов до смены">
                    <Input
                      type="number"
                      placeholder="3"
                      value={draft.settings.max_failed_times ?? ''}
                      onChange={(e) => setS({ max_failed_times: e.target.value ? Number(e.target.value) : null })}
                    />
                  </Field>
                  {draft.strategy === 'load-balance' && (
                    <Field label="Способ" className="col-span-2">
                      <Select value={draft.settings.lb_strategy || 'consistent-hashing'} onValueChange={(v) => setS({ lb_strategy: v })}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="consistent-hashing">По домену (consistent-hashing)</SelectItem>
                            <SelectItem value="round-robin">По кругу</SelectItem>
                            <SelectItem value="sticky-sessions">Липкие сессии</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                  <div className="col-span-2 flex items-center gap-2 self-end pb-2 text-sm">
                    <Switch checked={draft.settings.lazy ?? true} onCheckedChange={(v) => setS({ lazy: v })} />
                    Проверять только при использовании
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

// ─── Проверка изменений ─────────────────────────────────────────────────────────────────────

function ReviewView(props: {
  plan: XrayPlan | MihomoPlan | null
  changes: FileChange[]
  core: 'xray' | 'mihomo'
  renames: Record<string, string>
  acceptedFixes: Set<string>
  onRename: (member: string, suggested: string, on: boolean) => void
  onFix: (balancer: string, on: boolean) => void
  busy: boolean
}) {
  const { plan, changes, core } = props
  if (!plan) return null
  const xplan = core === 'xray' ? (plan as XrayPlan) : null
  return (
    <ScrollArea className="h-120 min-h-0" hideScrollbar>
      <div className="flex flex-col gap-3 px-0.5 py-1">
        {plan.errors.map((e) => (
          <div key={e} className="border-destructive/40 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0" /> {e}
          </div>
        ))}
        {plan.warnings.map((w) => (
          <div
            key={w}
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
          >
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0" /> {w}
          </div>
        ))}

        {xplan?.collisions.length ? (
          <div className="rounded-lg border px-3 py-2.5">
            <div className="text-sm font-medium">Пересечение тегов</div>
            <p className="text-muted-foreground mb-2 text-xs">
              Xray выбирает серверы балансировщика по префиксу тега: «a» захватывает и «a1». Переименуйте сервер, чтобы группа взяла ровно
              его.
            </p>
            {xplan.collisions.map((c) => (
              <label key={c.member} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                <Checkbox
                  checked={props.renames[c.member] === c.suggested || props.renames[c.member] !== undefined}
                  disabled={props.busy}
                  onCheckedChange={(v) => props.onRename(c.member, c.suggested, !!v)}
                />
                <span>
                  <code className="font-mono">{c.member}</code> захватывает <code className="font-mono">{c.others.join(', ')}</code> →
                  переименовать в <code className="font-mono">{c.suggested}</code>
                </span>
              </label>
            ))}
          </div>
        ) : null}
        {Object.entries(props.renames)
          .filter(([m]) => !xplan?.collisions.some((c) => c.member === m))
          .map(([m, n]) => (
            <label key={m} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
              <Checkbox checked disabled={props.busy} onCheckedChange={() => props.onRename(m, n, false)} />
              Переименование <code className="font-mono">{m}</code> → <code className="font-mono">{n}</code>
            </label>
          ))}

        {xplan?.selector_fixes.length ? (
          <div className="rounded-lg border px-3 py-2.5">
            <div className="text-sm font-medium">Чужие балансировщики захватывают серверы эксклюзивных групп</div>
            {xplan.selector_fixes.map((f) => (
              <label key={f.balancer} className="flex cursor-pointer items-start gap-2 py-1.5 text-sm">
                <Checkbox
                  checked={props.acceptedFixes.has(f.balancer)}
                  disabled={props.busy}
                  onCheckedChange={(v) => props.onFix(f.balancer, !!v)}
                />
                <span className="min-w-0">
                  Сузить селектор <code className="font-mono">{f.balancer}</code>:{' '}
                  <span className="text-muted-foreground font-mono text-xs line-through">{f.old.join(', ')}</span> →{' '}
                  <span className="font-mono text-xs">{f.new.join(', ') || '—'}</span>
                </span>
              </label>
            ))}
          </div>
        ) : null}

        {core === 'mihomo' && (plan as MihomoPlan).fixes.length > 0 && (
          <div className="text-muted-foreground rounded-lg border px-3 py-2.5 text-xs leading-relaxed">
            Эксклюзивность: из чужих групп убираются серверы групп, группам с include-all/use добавляется exclude-filter с точными именами.
          </div>
        )}

        {xplan && xplan.observer_mode !== 'none' && (
          <div className="text-muted-foreground rounded-lg border px-3 py-2.5 text-xs">
            Наблюдатель:{' '}
            {xplan.observer_mode === 'own'
              ? `свой burstObservatory в ${xplan.own_file}`
              : `расширен ${xplan.observer_key} в ${xplan.observer_file}`}{' '}
            — {xplan.observer_selectors.length} серв.
          </div>
        )}

        {changes.length === 0 ? (
          <div className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">Конфиги не меняются</div>
        ) : (
          changes.map((c) => <FileDiff key={c.file} change={c} />)
        )}
      </div>
    </ScrollArea>
  )
}

function FileDiff({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(true)
  const lines = useMemo(() => lineDiff(change.before ?? '', change.after ?? ''), [change])
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  return (
    <div className="overflow-hidden rounded-lg border">
      <button
        type="button"
        className="bg-muted/40 flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        <IconChevronDown size={14} className={cn('transition-transform', !open && '-rotate-90')} />
        <span className="min-w-0 flex-1 truncate font-mono">{change.file}</span>
        {change.before === null && <Badge variant="emerald">новый</Badge>}
        {change.after === null && <Badge variant="rose">удаляется</Badge>}
        <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
        <span className="text-red-600 dark:text-red-400">−{removed}</span>
      </button>
      {open && (
        <div className="overflow-x-auto font-mono text-[12px] leading-5">
          {lines.map((l, i) =>
            l.kind === 'skip' ? (
              <div key={i} className="text-muted-foreground bg-muted/30 px-3 py-0.5 text-[11px]">
                ⋯ {l.count} строк без изменений
              </div>
            ) : (
              <div
                key={i}
                className={cn(
                  'flex whitespace-pre',
                  l.kind === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                  l.kind === 'del' && 'bg-red-500/10 text-red-700 dark:text-red-300'
                )}
              >
                <span className="text-muted-foreground w-10 shrink-0 pr-2 text-right select-none">{l.a ?? ''}</span>
                <span className="text-muted-foreground w-10 shrink-0 pr-2 text-right select-none">{l.b ?? ''}</span>
                <span className="w-4 shrink-0 select-none">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                <span className="pr-3">{l.text}</span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
