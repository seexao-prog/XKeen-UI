import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowUp,
  IconFolder,
  IconFolderPlus,
  IconPencil,
  IconPhoto,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { iconUrl, loadIcons } from '../../lib/ruleCatalog'
import {
  FOLDER_NAME_MAX,
  folderOfGroup,
  makeFolderId,
  moveGroupToFolder,
  saveSelectorFolders,
  useFoldersModalFocus,
  validateFolders,
} from '../../lib/selectorFolders'
import { showToast, useModalContext, useProxiesStore, useSettings } from '../../lib/store'
import type { SelectorFolder } from '../../lib/types'
import { cn } from '../../lib/utils'

const SELECTOR_TYPES = new Set(['Selector', 'Fallback', 'URLTest', 'LoadBalance', 'Smart'])
const TYPE_LABEL: Record<string, string> = {
  Selector: 'select',
  URLTest: 'url-test',
  Fallback: 'fallback',
  LoadBalance: 'load-balance',
  Smart: 'smart',
}

type SelectorMeta = { name: string; type: string; icon?: string; hidden: boolean }

/** Селекторы mihomo из Clash API в порядке GLOBAL (как в панели). */
function useSelectorList(): SelectorMeta[] {
  const proxies = useProxiesStore((s) => s.proxies) as Record<string, any>
  return useMemo(() => {
    const list = Object.values(proxies).filter((p: any) => p && SELECTOR_TYPES.has(p.type) && p.name !== 'GLOBAL') as any[]
    const order: string[] = proxies.GLOBAL?.all ?? []
    const pos = new Map(order.map((n, i) => [n, i]))
    return list
      .sort((a, b) => (pos.get(a.name) ?? Infinity) - (pos.get(b.name) ?? Infinity))
      .map((p) => ({ name: p.name, type: p.type, icon: p.icon, hidden: !!p.hidden }))
  }, [proxies])
}

export function FolderIcon({ icon, className }: { icon?: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (icon && !broken)
    return <img src={icon} alt="" className={cn('size-5 shrink-0 rounded-sm object-contain', className)} onError={() => setBroken(true)} />
  return <IconFolder className={cn('text-muted-foreground size-5 shrink-0', className)} />
}

export function SelectorFoldersModal() {
  const { modals, dispatch } = useModalContext()
  const open = modals.showSelectorFoldersModal
  const saved = useSettings((s) => s.selectorFolders)
  const githubProxies = useSettings((s) => s.githubProxies)
  const focus = useFoldersModalFocus()
  const selectors = useSelectorList()
  const [folders, setFolders] = useState<SelectorFolder[]>(saved)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setFolders(saved)
    setEditing(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const dirty = JSON.stringify(folders) !== JSON.stringify(saved)
  const error = validateFolders(folders)
  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showSelectorFoldersModal', show: false })
  const focusGroup = open ? focus.group : null

  function addFolder() {
    const name = 'Новая папка'
    const id = makeFolderId(
      name,
      folders.map((f) => f.id)
    )
    const groups = focusGroup ? [focusGroup] : []
    setFolders((prev) => [
      ...(focusGroup ? prev.map((f) => ({ ...f, groups: f.groups.filter((g) => g !== focusGroup) })) : prev),
      { id, name, icon: '', groups },
    ])
    setEditing(id)
  }

  function update(id: string, patch: Partial<SelectorFolder>) {
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }

  function move(index: number, dir: -1 | 1) {
    setFolders((prev) => {
      const next = [...prev]
      const j = index + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  async function save() {
    setBusy(true)
    const err = await saveSelectorFolders(folders)
    setBusy(false)
    if (err) return showToast(err, 'error')
    showToast('Папки сохранены')
    close()
  }

  const current = folders.find((f) => f.id === editing) ?? null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent className="w-full max-w-160! p-0!">
        <div className="flex max-h-[85dvh] flex-col gap-4 p-5">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              {current && (
                <Button variant="ghost" size="icon-sm" onClick={() => setEditing(null)} aria-label="Назад">
                  <IconArrowLeft />
                </Button>
              )}
              <IconFolder size={20} /> {current ? current.name || 'Папка' : 'Папки селекторов'}
            </DialogTitle>
            <DialogDescription>
              Только внешний вид панели: селекторы группируются в сворачиваемые папки, конфиг mihomo не меняется. Папки общие для всех
              браузеров.
            </DialogDescription>
          </DialogHeader>

          {current ? (
            <FolderEditor
              folder={current}
              folders={folders}
              selectors={selectors}
              githubProxies={githubProxies}
              onChange={(patch) => update(current.id, patch)}
              onToggleGroup={(g) =>
                setFolders((prev) => {
                  const inThis = current.groups.includes(g)
                  return moveGroupToFolder(prev, g, inThis ? null : current.id)
                })
              }
            />
          ) : (
            <ScrollArea className="max-h-110 min-h-40" hideScrollbar>
              <div className="flex flex-col gap-2 px-0.5 py-1">
                {focusGroup && (
                  <div className="rounded-lg border border-dashed px-3 py-2.5 text-sm">
                    <div className="mb-2">
                      Переместить <span className="font-medium">«{focusGroup}»</span> в папку:
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {folders.map((f) => (
                        <Button
                          key={f.id}
                          size="sm"
                          variant={f.groups.includes(focusGroup) ? 'default' : 'outline'}
                          onClick={() => setFolders((prev) => moveGroupToFolder(prev, focusGroup, f.id))}
                        >
                          <FolderIcon icon={f.icon} className="size-4" /> {f.name}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant={folderOfGroup(folders, focusGroup) ? 'outline' : 'default'}
                        onClick={() => setFolders((prev) => moveGroupToFolder(prev, focusGroup, null))}
                      >
                        Без папки
                      </Button>
                      <Button size="sm" variant="outline" onClick={addFolder}>
                        <IconFolderPlus /> В новую
                      </Button>
                    </div>
                  </div>
                )}
                {folders.length === 0 && (
                  <div className="text-muted-foreground flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm">
                    <IconFolder size={28} className="opacity-60" />
                    Папок пока нет
                  </div>
                )}
                {folders.map((f, i) => {
                  const present = f.groups.filter((g) => selectors.some((s) => s.name === g))
                  const missing = f.groups.length - present.length
                  return (
                    <div key={f.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                      <FolderIcon icon={f.icon} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">{f.name}</span>
                          <Badge variant="secondary">{present.length}</Badge>
                          {missing > 0 && <Badge variant="outline">нет в конфиге: {missing}</Badge>}
                        </div>
                        <div className="text-muted-foreground truncate text-xs">{f.groups.join(', ') || 'пусто'}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Выше">
                          <IconArrowUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => move(i, 1)}
                          disabled={i === folders.length - 1}
                          aria-label="Ниже"
                        >
                          <IconArrowDown />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditing(f.id)} aria-label="Изменить">
                          <IconPencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setFolders((prev) => prev.filter((x) => x.id !== f.id))}
                          aria-label="Удалить папку"
                          title="Удалить папку (селекторы вернутся в общий список)"
                        >
                          <IconTrash />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          )}

          {error && <div className="text-destructive text-xs">{error}</div>}

          <DialogFooter className="shrink-0">
            {current ? (
              <Button variant="outline" onClick={() => setEditing(null)}>
                Готово
              </Button>
            ) : (
              <Button variant="outline" onClick={addFolder}>
                <IconPlus /> Создать папку
              </Button>
            )}
            <Button onClick={() => void save()} disabled={busy || !dirty || !!error}>
              {busy && <Spinner />} Сохранить
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FolderEditor(props: {
  folder: SelectorFolder
  folders: SelectorFolder[]
  selectors: SelectorMeta[]
  githubProxies: string[]
  onChange: (patch: Partial<SelectorFolder>) => void
  onToggleGroup: (group: string) => void
}) {
  const { folder, folders, selectors } = props
  const [query, setQuery] = useState('')
  const [iconsOpen, setIconsOpen] = useState(false)
  const [icons, setIcons] = useState<string[] | null>(null)
  const [iconQuery, setIconQuery] = useState('')

  useEffect(() => {
    if (!iconsOpen || icons) return
    loadIcons(props.githubProxies)
      .then(setIcons)
      .catch(() => setIcons([]))
  }, [iconsOpen, icons, props.githubProxies])

  const q = query.trim().toLowerCase()
  const list = selectors.filter((s) => !q || s.name.toLowerCase().includes(q))
  // Имена из папки, которых сейчас нет в конфиге, — показываем, чтобы их можно было убрать.
  const missing = folder.groups.filter((g) => !selectors.some((s) => s.name === g))

  return (
    <ScrollArea className="max-h-110 min-h-0" hideScrollbar>
      <div className="flex flex-col gap-4 px-0.5 py-1">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-xs">Название</Label>
            <Input
              value={folder.name}
              maxLength={FOLDER_NAME_MAX}
              onChange={(e) => props.onChange({ name: e.target.value })}
              placeholder="Например, AI"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-xs">Иконка</Label>
            <div className="flex items-center gap-2">
              <FolderIcon icon={folder.icon} className="size-8" />
              <Button variant="outline" size="sm" onClick={() => setIconsOpen((v) => !v)}>
                <IconPhoto /> Выбрать
              </Button>
              {folder.icon && (
                <Button variant="ghost" size="sm" onClick={() => props.onChange({ icon: '' })}>
                  Убрать
                </Button>
              )}
            </div>
          </div>
        </div>

        {iconsOpen && (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <Input
              value={folder.icon}
              onChange={(e) => props.onChange({ icon: e.target.value })}
              placeholder="Своя ссылка: https://…/icon.png"
              className="font-mono"
            />
            <Input value={iconQuery} onChange={(e) => setIconQuery(e.target.value)} placeholder="Поиск в наборе Qure" />
            <div className="grid max-h-40 grid-cols-8 gap-1.5 overflow-y-auto sm:grid-cols-10">
              {icons === null ? (
                <div className="text-muted-foreground col-span-full flex items-center gap-2 text-xs">
                  <Spinner className="size-3" /> Загрузка набора иконок…
                </div>
              ) : icons.length === 0 ? (
                <div className="text-muted-foreground col-span-full text-xs">Набор иконок недоступен — укажите ссылку</div>
              ) : (
                icons
                  .filter((n) => n.toLowerCase().includes(iconQuery.trim().toLowerCase()))
                  .slice(0, 120)
                  .map((n) => (
                    <button
                      key={n}
                      type="button"
                      title={n}
                      onClick={() => props.onChange({ icon: iconUrl(n) })}
                      className={cn(
                        'flex aspect-square cursor-pointer items-center justify-center rounded-md border p-1',
                        folder.icon === iconUrl(n) ? 'border-foreground bg-accent/60' : 'hover:bg-accent/40 border-transparent'
                      )}
                    >
                      <img src={iconUrl(n)} alt={n} loading="lazy" className="size-full object-contain" />
                    </button>
                  ))
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label className="text-sm">
            Селекторы в папке <span className="text-muted-foreground">({folder.groups.length})</span>
          </Label>
          <div className="relative">
            <IconSearch size={14} className="text-muted-foreground absolute top-1/2 left-2.5 -translate-y-1/2" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск селектора" className="pl-8" />
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border">
            {list.length === 0 && missing.length === 0 && (
              <div className="text-muted-foreground p-4 text-center text-sm">
                {selectors.length ? 'Ничего не найдено' : 'Селекторы не загружены — откройте панель селекторов'}
              </div>
            )}
            {list.map((s) => {
              const inThis = folder.groups.includes(s.name)
              const other = !inThis ? folders.find((f) => f.id !== folder.id && f.groups.includes(s.name)) : null
              return (
                <div
                  key={s.name}
                  className="hover:bg-accent/40 flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0"
                  onClick={() => props.onToggleGroup(s.name)}
                >
                  <Checkbox checked={inThis} />
                  {s.icon ? <img src={s.icon} alt="" className="size-4 shrink-0 object-contain" /> : <span className="size-4 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {other && <Badge variant="amber">в «{other.name}» — перенести</Badge>}
                  {s.hidden && <Badge variant="outline">скрытый</Badge>}
                  <span className="text-muted-foreground text-xs">{TYPE_LABEL[s.type] ?? s.type}</span>
                </div>
              )
            })}
            {missing.map((g) => (
              <div
                key={`missing-${g}`}
                className="hover:bg-accent/40 flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-sm opacity-70 last:border-b-0"
                onClick={() => props.onToggleGroup(g)}
              >
                <Checkbox checked />
                <span className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{g}</span>
                <Badge variant="outline">нет в конфиге</Badge>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            Порядок селекторов в папке — в порядке отметки. Селектор может лежать только в одной папке.
          </p>
        </div>
      </div>
    </ScrollArea>
  )
}
