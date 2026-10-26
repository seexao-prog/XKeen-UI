import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBooks,
  IconCheck,
  IconChevronDown,
  IconFoldDown,
  IconLink,
  IconPhoto,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { apiCall } from '../../lib/api'
import { diffLines, foldUnchanged, type DiffLine } from '../../lib/lineDiff'
import {
  buildCatalogChange,
  catalogFileUrl,
  defaultInsertIndex,
  defaultTemplate,
  detectFromUrl,
  findConnected,
  getCachedCatalog,
  iconUrl,
  inspectConfig,
  loadCatalog,
  loadIcons,
  loadPreview,
  prettyName,
  providerKey,
  RU_FILTER,
  searchCatalog,
  suggestIcon,
  uniqueName,
  validateSelectorName,
  type Behavior,
  type CatalogData,
  type CatalogEntry,
  type CatalogKind,
  type Format,
  type SearchHit,
} from '../../lib/ruleCatalog'
import {
  fetchClashProxies,
  fetchClashRuleProviders,
  getAppState,
  showToast,
  syncClashApiPort,
  useAppActions,
  useModalContext,
  useSettings,
} from '../../lib/store'
import { moveGroupToFolder, saveSelectorFolders } from '../../lib/selectorFolders'
import type { Config } from '../../lib/types'
import { cn } from '../../lib/utils'

const MIHOMO_CONFIG = '/opt/etc/mihomo/config.yaml'
const HOT_RELOAD_UNAVAILABLE = 'Hot reload unavailable'

type Source = { kind: 'catalog'; entry: CatalogEntry } | { kind: 'custom'; url: string }
type View = 'search' | 'setup' | 'review'
type IconMode = 'auto' | 'catalog' | 'url' | 'none'

function sourceUrl(s: Source) {
  return s.kind === 'catalog' ? catalogFileUrl(s.entry) : s.url.trim()
}

function sourceFile(s: Source) {
  if (s.kind === 'catalog') return s.entry.name
  const m = /\/([^/?#]+?)(?:\.(?:mrs|list|ya?ml|txt))?(?:[?#].*)?$/i.exec(s.url.trim())
  return (m?.[1] ?? 'list').replace(/@.*$/, '')
}

function useMihomoConfig(): { config: Config | null; text: string } {
  const { configs } = getAppState()
  const cfg = configs.find((c) => c.file === MIHOMO_CONFIG) ?? configs.find((c) => c.file.endsWith('/config.yaml')) ?? null
  return { config: cfg, text: cfg?.savedContent ?? '' }
}

/** Подсветка совпадения в имени. */
function Highlight({ text, range }: { text: string; range?: [number, number] }) {
  if (!range) return <>{text}</>
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="text-foreground rounded-sm bg-amber-400/30 px-0.5">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  )
}

export function RuleCatalogModal() {
  const { modals, dispatch } = useModalContext()
  const { showToast: toast } = useAppActions()
  const open = modals.showRuleCatalogModal
  const githubProxies = useSettings((s) => s.githubProxies)
  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showRuleCatalogModal', show: false })

  const [view, setView] = useState<View>('search')
  const [catalog, setCatalog] = useState<CatalogData | null>(() => getCachedCatalog())
  const [catalogError, setCatalogError] = useState('')
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<CatalogKind | 'all'>('all')
  const [selected, setSelected] = useState<SearchHit | null>(null)
  const [customUrl, setCustomUrl] = useState('')
  const [preview, setPreview] = useState<{ key: string; lines: string[]; total: number } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [source, setSource] = useState<Source | null>(null)
  const [busy, setBusy] = useState(false)

  const { config, text } = useMihomoConfig()
  const inv = useMemo(() => {
    try {
      return text ? inspectConfig(text) : null
    } catch {
      return null
    }
  }, [text])

  async function refreshCatalog(force: boolean) {
    setLoadingCatalog(true)
    setCatalogError('')
    try {
      setCatalog(await loadCatalog(githubProxies, force))
    } catch (e) {
      setCatalogError((e as Error).message)
    } finally {
      setLoadingCatalog(false)
    }
  }

  useEffect(() => {
    if (open && !catalog) void refreshCatalog(false)
    if (open) setView('search')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const results = useMemo(() => (catalog ? searchCatalog(catalog, query, kind) : { hits: [], total: 0 }), [catalog, query, kind])

  useEffect(() => {
    if (!selected) return
    const key = `${selected.kind}/${selected.name}`
    setPreview(null)
    setPreviewError('')
    let alive = true
    loadPreview(selected, githubProxies)
      .then((p) => alive && setPreview({ key, ...p }))
      .catch((e) => alive && setPreviewError((e as Error).message))
    return () => {
      alive = false
    }
  }, [selected, githubProxies])

  function pick(s: Source) {
    setSource(s)
    setView('setup')
  }

  const customValid = /^https?:\/\/\S+\.(mrs|list|ya?ml|txt)(\?\S*)?$/i.test(customUrl.trim())

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent className="w-full max-w-215! p-0!">
        <div className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 pr-8">
              {view !== 'search' && (
                <Button variant="ghost" size="icon-sm" onClick={() => setView(view === 'review' ? 'setup' : 'search')} disabled={busy}>
                  <IconArrowLeft />
                </Button>
              )}
              <IconBooks size={22} />
              {view === 'search' ? 'Каталог правил' : view === 'setup' ? 'Подключение списка' : 'Проверка изменений'}
            </DialogTitle>
            <DialogDescription>
              {view === 'search' &&
                'Готовые списки доменов и IP из MetaCubeX/meta-rules-dat. Выберите список — панель сама добавит провайдер, селектор и правило в config.yaml.'}
              {view === 'setup' && 'Название, иконка, куда направлять трафик и где поставить правило.'}
              {view === 'review' && 'Вот что изменится в config.yaml. Ничего не записано, пока вы не нажмёте «Применить».'}
            </DialogDescription>
          </DialogHeader>

          {!config || !inv ? (
            <div className="text-muted-foreground flex min-h-60 items-center justify-center gap-2 text-sm">
              {config ? 'config.yaml не разбирается — исправьте ошибки в редакторе' : 'config.yaml не найден'}
            </div>
          ) : view === 'search' ? (
            <SearchView
              catalog={catalog}
              loading={loadingCatalog}
              error={catalogError}
              onRefresh={() => void refreshCatalog(true)}
              query={query}
              setQuery={setQuery}
              kind={kind}
              setKind={setKind}
              results={results}
              selected={selected}
              setSelected={setSelected}
              preview={selected && preview?.key === `${selected.kind}/${selected.name}` ? preview : null}
              previewError={previewError}
              connected={(e) => findConnected(inv, e)}
              onPick={(e) => pick({ kind: 'catalog', entry: e })}
              customUrl={customUrl}
              setCustomUrl={setCustomUrl}
              customValid={customValid}
              onPickCustom={() => pick({ kind: 'custom', url: customUrl.trim() })}
            />
          ) : source ? (
            <SetupFlow
              key={sourceUrl(source)}
              source={source}
              text={text}
              config={config}
              inv={inv}
              view={view}
              setView={setView}
              busy={busy}
              setBusy={setBusy}
              githubProxies={githubProxies}
              onDone={() => {
                toast('Список подключён')
                close()
              }}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Поиск ──────────────────────────────────────────────────────────────────────────────────

function SearchView(props: {
  catalog: CatalogData | null
  loading: boolean
  error: string
  onRefresh: () => void
  query: string
  setQuery: (v: string) => void
  kind: CatalogKind | 'all'
  setKind: (v: CatalogKind | 'all') => void
  results: { hits: SearchHit[]; total: number }
  selected: SearchHit | null
  setSelected: (h: SearchHit | null) => void
  preview: { lines: string[]; total: number } | null
  previewError: string
  connected: (e: CatalogEntry) => string | null
  onPick: (e: CatalogEntry) => void
  customUrl: string
  setCustomUrl: (v: string) => void
  customValid: boolean
  onPickCustom: () => void
}) {
  const { catalog, results, selected } = props
  const [customOpen, setCustomOpen] = useState(false)
  const age = catalog ? Math.round((Date.now() - catalog.ts) / 3600000) : 0
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <IconSearch size={14} className="text-muted-foreground absolute top-1/2 left-2.5 -translate-y-1/2" />
          <Input
            autoFocus
            value={props.query}
            onChange={(e) => props.setQuery(e.target.value)}
            placeholder="Например: gemini, chatgpt, ютуб, netflix"
            className="pl-8"
          />
        </div>
        <div className="flex gap-1.5">
          {(['all', 'geosite', 'geoip'] as const).map((k) => (
            <Button key={k} variant={props.kind === k ? 'default' : 'outline'} size="sm" className="h-9" onClick={() => props.setKind(k)}>
              {k === 'all' ? 'Все' : k === 'geosite' ? 'Домены' : 'IP'}
            </Button>
          ))}
        </div>
      </div>

      <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
        <span>
          {catalog
            ? `${catalog.geosite.length} списков доменов, ${catalog.geoip.length} списков IP · обновлено ${age ? `${age} ч назад` : 'только что'}`
            : props.loading
              ? 'Загрузка каталога…'
              : ''}
        </span>
        <button
          type="button"
          className="hover:text-foreground flex cursor-pointer items-center gap-1"
          onClick={props.onRefresh}
          disabled={props.loading}
        >
          {props.loading ? <Spinner className="size-3" /> : <IconRefresh size={13} />} Обновить каталог
        </button>
      </div>

      {props.error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <IconAlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div>
            {props.error}. Проверьте доступ к GitHub или добавьте GitHub-прокси в Настройках → Обновления. Можно вставить ссылку вручную
            ниже.
          </div>
        </div>
      )}

      <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-[1fr_1fr]">
        <ScrollArea className="h-80 min-h-0 rounded-lg border" hideScrollbar>
          {!catalog && props.loading ? (
            <div className="text-muted-foreground flex h-80 items-center justify-center gap-2 text-sm">
              <Spinner /> Загрузка…
            </div>
          ) : results.hits.length === 0 ? (
            <div className="text-muted-foreground flex h-80 items-center justify-center text-sm">Ничего не найдено</div>
          ) : (
            <div className="flex flex-col">
              {results.hits.map((h) => {
                const conn = props.connected(h)
                const isSel = selected?.name === h.name && selected?.kind === h.kind
                return (
                  <button
                    key={`${h.kind}/${h.name}`}
                    type="button"
                    onClick={() => props.setSelected(h)}
                    onDoubleClick={() => props.onPick(h)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0',
                      isSel ? 'bg-accent/70' : 'hover:bg-accent/40'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                      <Highlight text={h.name} range={h.match} />
                    </span>
                    {h.viaSynonym && <Badge variant="secondary">{h.viaSynonym}</Badge>}
                    {conn && <Badge variant="emerald">подключён</Badge>}
                    <Badge variant="outline">{h.kind === 'geosite' ? 'домены' : 'IP'}</Badge>
                  </button>
                )
              })}
              {results.total > results.hits.length && (
                <div className="text-muted-foreground px-3 py-2 text-center text-xs">
                  Показаны первые {results.hits.length} из {results.total} — уточните запрос
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <div className="flex h-80 min-h-0 flex-col gap-2 rounded-lg border p-3">
          {selected ? (
            <>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{selected.name}</span>
                <Badge variant="outline">{selected.kind}</Badge>
              </div>
              {props.connected(selected) && (
                <div className="text-muted-foreground text-xs">
                  Уже подключён как <code className="font-mono">{props.connected(selected)}</code> — можно направить его в другой селектор.
                </div>
              )}
              <div className="bg-muted/30 min-h-0 flex-1 overflow-auto rounded-md p-2 font-mono text-[11.5px] leading-5">
                {props.preview ? (
                  <>
                    {props.preview.lines.map((l, i) => (
                      <div key={i} className="truncate">
                        {l}
                      </div>
                    ))}
                    {props.preview.total > props.preview.lines.length && (
                      <div className="text-muted-foreground mt-1 font-sans">…и ещё {props.preview.total - props.preview.lines.length}</div>
                    )}
                  </>
                ) : props.previewError ? (
                  <div className="text-muted-foreground font-sans">Предпросмотр недоступен</div>
                ) : (
                  <div className="text-muted-foreground flex items-center gap-2 font-sans">
                    <Spinner className="size-3" /> Загрузка содержимого…
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">{props.preview ? `${props.preview.total} записей` : ''}</span>
                <Button size="sm" onClick={() => props.onPick(selected)}>
                  Подключить
                </Button>
              </div>
            </>
          ) : (
            <div className="text-muted-foreground flex h-full items-center justify-center text-center text-sm">
              Выберите список слева, чтобы посмотреть его содержимое
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-left text-sm font-medium"
          onClick={() => setCustomOpen((v) => !v)}
        >
          <span className="flex items-center gap-2">
            <IconLink size={15} /> Свой URL
          </span>
          <IconChevronDown size={15} className={cn('transition-transform', !customOpen && '-rotate-90')} />
        </button>
        {customOpen && (
          <div className="flex flex-col gap-2 border-t px-3 py-3">
            <div className="flex gap-2">
              <Input
                value={props.customUrl}
                onChange={(e) => props.setCustomUrl(e.target.value)}
                placeholder="https://…/list.mrs, .list, .yaml"
                className="font-mono"
              />
              <Button onClick={props.onPickCustom} disabled={!props.customValid}>
                Далее
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Формат определяется по расширению (.mrs — бинарный, .list/.txt — текст, .yaml), тип — по пути (geoip → IP, иначе домены или
              classical).
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Мастер ─────────────────────────────────────────────────────────────────────────────────

function SetupFlow(props: {
  source: Source
  text: string
  config: Config
  inv: NonNullable<ReturnType<typeof inspectConfig>>
  view: View
  setView: (v: View) => void
  busy: boolean
  setBusy: (v: boolean) => void
  githubProxies: string[]
  onDone: () => void
}) {
  const { source, text, inv } = props
  const url = sourceUrl(source)
  const file = sourceFile(source)
  const detected = detectFromUrl(url)
  const isIp = source.kind === 'catalog' ? source.entry.kind === 'geoip' : detected.behavior === 'ipcidr'
  const [format, setFormat] = useState<Format>(detected.format)
  const [behavior, setBehavior] = useState<Behavior>(isIp ? 'ipcidr' : detected.behavior)
  const connected = source.kind === 'catalog' ? findConnected(inv, source.entry) : (inv.providers.find((p) => p.url === url)?.name ?? null)
  const [reuse, setReuse] = useState(!!connected)

  const takenProviders = useMemo(() => new Set(inv.providers.map((p) => p.name)), [inv])
  const [providerName, setProviderName] = useState(() => uniqueName(providerKey(file, isIp ? 'ipcidr' : detected.behavior), takenProviders))
  const takenGroups = useMemo(() => new Set([...inv.groups.map((g) => g.name), ...inv.proxies]), [inv])
  const [name, setName] = useState(() => uniqueName(prettyName(file), takenGroups))
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const userSelectors = inv.groups.filter((g) => !g.panel)
  const [existing, setExisting] = useState(() => userSelectors.find((g) => g.type === 'select')?.name ?? 'DIRECT')
  const [template, setTemplate] = useState<string>(() => defaultTemplate(inv) ?? '__none')
  const templateGroup = inv.groups.find((g) => g.name === template)
  const [excludeRu, setExcludeRu] = useState(true)
  const panelGroups = inv.groups.filter((g) => g.panel)
  const [extras, setExtras] = useState<string[]>([])
  const [insertBefore, setInsertBefore] = useState(() => defaultInsertIndex(inv.rules))
  const selectorFolders = useSettings((s) => s.selectorFolders)
  const [folderId, setFolderId] = useState('__none')

  const [iconMode, setIconMode] = useState<IconMode>('auto')
  const [icons, setIcons] = useState<string[] | null>(null)
  const [iconQuery, setIconQuery] = useState('')
  const [iconPick, setIconPick] = useState<string | null>(null)
  const [iconCustom, setIconCustom] = useState('')
  useEffect(() => {
    loadIcons(props.githubProxies)
      .then(setIcons)
      .catch(() => setIcons([]))
  }, [props.githubProxies])
  const autoIcon = icons ? (suggestIcon(icons, name) ?? suggestIcon(icons, file)) : null
  const icon =
    mode === 'existing'
      ? undefined
      : iconMode === 'auto'
        ? autoIcon
          ? iconUrl(autoIcon)
          : undefined
        : iconMode === 'catalog'
          ? iconPick
            ? iconUrl(iconPick)
            : undefined
          : iconMode === 'url'
            ? iconCustom.trim() || undefined
            : undefined

  const nameError = mode === 'new' ? (validateSelectorName(name) ?? (takenGroups.has(name.trim()) ? 'Такое имя уже занято' : null)) : null

  const plan = useMemo(() => {
    try {
      return {
        result: buildCatalogChange(text, {
          url,
          format,
          behavior,
          providerName,
          reuseProvider: reuse ? connected : null,
          target:
            mode === 'existing'
              ? { mode: 'existing', group: existing }
              : {
                  mode: 'new',
                  name,
                  icon,
                  template: template === '__none' ? null : template,
                  excludeRu,
                  extraVariants: extras,
                },
          insertBefore,
        }),
        error: '',
      }
    } catch (e) {
      return { result: null, error: (e as Error).message }
    }
  }, [text, url, format, behavior, providerName, reuse, connected, mode, existing, name, icon, template, excludeRu, extras, insertBefore])

  async function apply() {
    if (!plan.result) return
    props.setBusy(true)
    try {
      const after = plan.result.text
      const res = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs?validate=mihomo', {
        file: props.config.file,
        content: after,
      })
      const hotUnavailable = res.error === HOT_RELOAD_UNAVAILABLE
      if (!res.success && !hotUnavailable)
        throw new Error(
          res.error === 'Validation failed' ? 'Mihomo отклонил конфиг — изменения откатены, подробности в журнале' : res.error || 'ошибка'
        )
      if (hotUnavailable) {
        showToast('Clash API недоступен — выполняем полный перезапуск', 'warning')
        const r = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'hardRestart', core: 'mihomo' })
        if (!r.success) throw new Error(r.error || 'ошибка перезапуска')
      }
      const { configs, dispatch } = getAppState()
      const idx = configs.findIndex((c) => c.file === props.config.file)
      if (idx >= 0) {
        const cur = configs[idx]
        if (cur.isDirty)
          showToast('В редакторе были несохранённые правки config.yaml — они сохранены поверх новой версии не будут', 'warning')
        dispatch({
          type: 'SET_CONFIGS',
          configs: configs.map((c, i) => (i === idx ? { ...c, content: after, savedContent: after, isDirty: false } : c)),
        })
      }
      syncClashApiPort()
      const st = getAppState()
      if (st.clashApiPort || st.clashApiUnix) {
        await Promise.all([
          fetchClashProxies(st.clashApiPort ?? '', st.clashApiSecret, true, st.clashApiUnix),
          fetchClashRuleProviders(st.clashApiPort ?? '', st.clashApiSecret, st.clashApiUnix),
        ]).catch(() => undefined)
      }
      if (mode === 'new' && folderId !== '__none') {
        const folders = getAppState().settings.selectorFolders
        const err = await saveSelectorFolders(moveGroupToFolder(folders, name.trim(), folderId))
        if (err) showToast(`Селектор создан, но не добавлен в папку: ${err}`, 'warning')
      }
      props.onDone()
    } catch (e) {
      showToast(`Не применено: ${(e as Error).message}`, 'error')
    } finally {
      props.setBusy(false)
    }
  }

  if (props.view === 'review') {
    return (
      <>
        <ReviewDiff before={text} after={plan.result?.text ?? text} file={props.config.file} warnings={plan.result?.warnings ?? []} />
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => props.setView('setup')} disabled={props.busy}>
            Назад
          </Button>
          <Button onClick={() => void apply()} disabled={props.busy || !plan.result}>
            {props.busy ? <Spinner /> : <IconCheck />} Применить
          </Button>
        </DialogFooter>
      </>
    )
  }

  const matchIdx = inv.rules.findIndex((r) => r.text.startsWith('MATCH,'))

  return (
    <>
      <ScrollArea className="h-120 min-h-0" hideScrollbar>
        <div className="flex flex-col gap-4 px-0.5 py-1">
          <div className="flex flex-col gap-1 rounded-lg border px-3 py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="font-mono">{file}</span>
              <Badge variant="outline">{behavior}</Badge>
              <Badge variant="outline">{format}</Badge>
            </div>
            <div className="text-muted-foreground font-mono text-[11px] break-all">{url}</div>
            {source.kind === 'custom' && (
              <div className="mt-1.5 flex flex-wrap gap-2">
                <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
                  <SelectTrigger size="sm" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="mrs">mrs</SelectItem>
                    <SelectItem value="text">text</SelectItem>
                    <SelectItem value="yaml">yaml</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={behavior} onValueChange={(v) => setBehavior(v as Behavior)}>
                  <SelectTrigger size="sm" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="domain">domain</SelectItem>
                    <SelectItem value="ipcidr">ipcidr</SelectItem>
                    <SelectItem value="classical">classical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {connected ? (
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <div>
                <div className="text-sm font-medium">Использовать уже подключённый провайдер</div>
                <div className="text-muted-foreground text-xs">
                  <code className="font-mono">{connected}</code> уже скачивает этот список — новый провайдер не нужен
                </div>
              </div>
              <Switch checked={reuse} onCheckedChange={setReuse} />
            </label>
          ) : null}
          {!reuse && (
            <Field label="Имя провайдера в rule-providers">
              <Input value={providerName} onChange={(e) => setProviderName(e.target.value.trim())} className="font-mono" />
            </Field>
          )}

          <div className="flex flex-col gap-2">
            <Label className="text-sm">Куда направлять трафик</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  ['new', 'Новый селектор', 'Отдельная карточка, в которой выбираете сервер для этого списка'],
                  ['existing', 'В существующий', 'В уже имеющийся селектор, группу, DIRECT или REJECT'],
                ] as const
              ).map(([id, title, hint]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMode(id)}
                  className={cn(
                    'cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors',
                    mode === id ? 'border-foreground bg-accent/60' : 'border-border hover:bg-accent/40 hover:border-(--focus-border)'
                  )}
                >
                  <div className="text-sm font-medium">{title}</div>
                  <div className="text-muted-foreground mt-1 text-xs">{hint}</div>
                </button>
              ))}
            </div>
          </div>

          {mode === 'existing' ? (
            <Field label="Селектор или группа">
              <Select value={existing} onValueChange={(v) => setExisting(String(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectGroup>
                    <SelectLabel>Встроенные</SelectLabel>
                    <SelectItem value="DIRECT">DIRECT — напрямую</SelectItem>
                    <SelectItem value="REJECT">REJECT — блокировать</SelectItem>
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>Группы</SelectLabel>
                    {inv.groups.map((g) => (
                      <SelectItem key={g.name} value={g.name}>
                        {g.name} <span className="text-muted-foreground text-xs">{g.type}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <>
              <Field label="Название селектора">
                <Input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} />
                {nameError && <span className="text-destructive text-xs">{nameError}</span>}
              </Field>

              <div className="flex flex-col gap-2">
                <Label className="text-sm">Иконка</Label>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ['auto', 'Подобрать'],
                      ['catalog', 'Из набора Qure'],
                      ['url', 'Своя ссылка'],
                      ['none', 'Без иконки'],
                    ] as const
                  ).map(([id, label]) => (
                    <Button key={id} size="sm" variant={iconMode === id ? 'default' : 'outline'} onClick={() => setIconMode(id)}>
                      {label}
                    </Button>
                  ))}
                </div>
                {iconMode === 'auto' && (
                  <div className="text-muted-foreground flex items-center gap-2 text-xs">
                    {icons === null ? (
                      <>
                        <Spinner className="size-3" /> Загрузка набора иконок…
                      </>
                    ) : autoIcon ? (
                      <>
                        <img src={iconUrl(autoIcon)} alt="" className="size-6 rounded" /> {autoIcon}
                      </>
                    ) : (
                      'Подходящая иконка не найдена — выберите из набора или укажите ссылку'
                    )}
                  </div>
                )}
                {iconMode === 'catalog' && (
                  <div className="flex flex-col gap-2">
                    <Input value={iconQuery} onChange={(e) => setIconQuery(e.target.value)} placeholder="Поиск иконки" />
                    <div className="grid max-h-40 grid-cols-6 gap-1.5 overflow-y-auto rounded-lg border p-2 sm:grid-cols-10">
                      {(icons ?? [])
                        .filter((n) => n.toLowerCase().includes(iconQuery.trim().toLowerCase()))
                        .slice(0, 120)
                        .map((n) => (
                          <button
                            key={n}
                            type="button"
                            title={n}
                            onClick={() => setIconPick(n)}
                            className={cn(
                              'flex aspect-square cursor-pointer items-center justify-center rounded-md border p-1',
                              iconPick === n ? 'border-foreground bg-accent/60' : 'hover:bg-accent/40 border-transparent'
                            )}
                          >
                            <img src={iconUrl(n)} alt={n} loading="lazy" className="size-full object-contain" />
                          </button>
                        ))}
                    </div>
                  </div>
                )}
                {iconMode === 'url' && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={iconCustom}
                      onChange={(e) => setIconCustom(e.target.value)}
                      placeholder="https://…/icon.png"
                      className="font-mono"
                    />
                    {iconCustom.trim() ? (
                      <img src={iconCustom.trim()} alt="" className="size-8 rounded" />
                    ) : (
                      <IconPhoto className="text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>

              <Field label="Образец (какие варианты будут в селекторе)">
                <Select value={template} onValueChange={(v) => setTemplate(String(v))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="__none">Без образца — только DIRECT</SelectItem>
                    {userSelectors.map((g) => (
                      <SelectItem key={g.name} value={g.name}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {templateGroup && (
                  <span className="text-muted-foreground text-xs">
                    Скопируются варианты {templateGroup.includeAll ? 'все серверы + ' : ''}
                    {templateGroup.proxies.filter((p) => !p.startsWith('grp-')).join(', ') || '—'}
                  </span>
                )}
              </Field>

              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                <div>
                  <div className="text-sm font-medium">Без российских серверов</div>
                  <div className="text-muted-foreground text-xs">
                    Исключить серверы с {RU_FILTER} в имени (нужно для сервисов, которые блокируют российские IP)
                  </div>
                </div>
                <Switch checked={excludeRu} onCheckedChange={setExcludeRu} />
              </label>

              <Field label="Папка в панели (необязательно)">
                <Select value={folderId} onValueChange={(v) => setFolderId(String(v))}>
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {folderId === '__none' ? 'Без папки' : (selectorFolders.find((f) => f.id === folderId)?.name ?? 'Без папки')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="__none">Без папки</SelectItem>
                    {selectorFolders.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-xs">
                  {selectorFolders.length
                    ? 'Только вид панели: новый селектор покажется внутри выбранной папки, конфиг не меняется'
                    : 'Папок пока нет — создать их можно кнопкой «Папки» в панели селекторов'}
                </span>
              </Field>

              {panelGroups.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2.5">
                  <div className="text-sm font-medium">Группы прокси панели вариантом</div>
                  {panelGroups.map((g) => (
                    <label key={g.name} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={extras.includes(g.name)}
                        onCheckedChange={(v) => setExtras((prev) => (v ? [...prev, g.name] : prev.filter((x) => x !== g.name)))}
                      />
                      <span className="font-mono text-[13px]">{g.name}</span>
                      <span className="text-muted-foreground text-xs">{g.type}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}

          <Field label="Поставить правило перед">
            <Select value={String(insertBefore)} onValueChange={(v) => setInsertBefore(Number(v))}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {insertBefore < inv.rules.length ? `#${insertBefore + 1} ${inv.rules[insertBefore].text}` : 'В конец списка'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent position="popper" className="max-h-80">
                {inv.rules.map((r) => (
                  <SelectItem key={r.index} value={String(r.index)}>
                    <span className="text-muted-foreground w-7 shrink-0 text-xs">#{r.index + 1}</span>
                    <span className="truncate font-mono text-[12px]">{r.text}</span>
                  </SelectItem>
                ))}
                <SelectItem value={String(inv.rules.length)}>В конец списка</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-muted-foreground text-xs">
              Правила проверяются сверху вниз. По умолчанию — сразу после блокировок, чтобы узкий список сработал раньше общих (category-ai,
              refilter).
            </span>
            {matchIdx >= 0 && insertBefore > matchIdx && (
              <span className="text-destructive flex items-center gap-1 text-xs">
                <IconAlertTriangle size={13} /> Ниже MATCH правило никогда не сработает
              </span>
            )}
          </Field>

          {plan.error && (
            <div className="text-destructive flex items-start gap-2 rounded-lg border border-current/30 p-3 text-xs">
              <IconAlertTriangle size={15} className="mt-0.5 shrink-0" /> {plan.error}
            </div>
          )}
          {plan.result?.warnings.map((w) => (
            <div
              key={w}
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
            >
              <IconAlertTriangle size={15} className="mt-0.5 shrink-0" /> {w}
            </div>
          ))}
        </div>
      </ScrollArea>
      <DialogFooter className="shrink-0">
        <Button onClick={() => props.setView('review')} disabled={!plan.result || !!nameError}>
          Далее
        </Button>
      </DialogFooter>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className="text-muted-foreground text-xs">{label}</Label>
      {children}
    </div>
  )
}

function ReviewDiff({ before, after, file, warnings }: { before: string; after: string; file: string; warnings: string[] }) {
  const diff = useMemo(() => diffLines(before, after), [before, after])
  const rows = useMemo(() => foldUnchanged(diff.lines), [diff.lines])
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  return (
    <ScrollArea className="h-120 min-h-0" hideScrollbar>
      <div className="flex flex-col gap-3 px-0.5 py-1">
        {warnings.map((w) => (
          <div
            key={w}
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
          >
            <IconAlertTriangle size={15} className="mt-0.5 shrink-0" /> {w}
          </div>
        ))}
        <div className="overflow-hidden rounded-lg border">
          <div className="bg-muted/40 flex items-center gap-2 px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono">{file}</span>
            <span className="text-green-600 dark:text-green-400">+{diff.added}</span>
            <span className="text-red-600 dark:text-red-400">−{diff.removed}</span>
          </div>
          <div className="overflow-x-auto font-mono text-[12px] leading-5">
            {rows.map((row, i) =>
              row.type === 'fold' ? (
                expanded.has(row.id) ? (
                  row.lines.map((l, j) => <DiffRow key={`${i}-${j}`} line={l} />)
                ) : (
                  <button
                    key={`f${row.id}`}
                    type="button"
                    className="text-muted-foreground hover:text-foreground bg-muted/30 flex w-full cursor-pointer items-center gap-2 px-3 py-0.5 font-sans text-[11px]"
                    onClick={() => setExpanded((p) => new Set(p).add(row.id))}
                  >
                    <IconFoldDown size={13} /> {row.lines.length} строк без изменений
                  </button>
                )
              ) : (
                <DiffRow key={i} line={row} />
              )
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        'flex whitespace-pre',
        line.type === 'add' && 'bg-green-500/10 text-green-800 dark:text-green-300',
        line.type === 'del' && 'bg-red-500/10 text-red-800 dark:text-red-300'
      )}
    >
      <span className="text-muted-foreground w-10 shrink-0 pr-2 text-right select-none">{line.type === 'add' ? '' : line.oldNo}</span>
      <span className="text-muted-foreground w-10 shrink-0 pr-2 text-right select-none">{line.type === 'del' ? '' : line.newNo}</span>
      <span className="w-4 shrink-0 select-none">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
      <span className="pr-3">{line.text}</span>
    </div>
  )
}

export function openRuleCatalog() {
  setTimeout(() => getAppState().dispatch({ type: 'SHOW_MODAL', modal: 'showRuleCatalogModal', show: true }), 0)
}
