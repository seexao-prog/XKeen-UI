import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { IconCloudDownload, IconPlus, IconRefresh, IconRss, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { formatAgo, patchAutomation, useAutomation, type Subscription } from '../../lib/automation'
import { useAppActions } from '../../lib/store'

type SubStatus = Subscription & {
  file: string
  last_update: number | null
  last_success: number | null
  last_error: string | null
  count: number
  skipped: number
}

const EMPTY: Subscription = { name: '', url: '', enabled: true, interval_hours: 12, user_agent: '' }

export function SubscriptionsModal({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: () => void
}) {
  const { showToast } = useAppActions()
  const { automation } = useAutomation()
  const items = automation.subscriptions.items
  const [statuses, setStatuses] = useState<SubStatus[]>([])
  const [defaultUa, setDefaultUa] = useState('')
  const [draft, setDraft] = useState<Subscription>(EMPTY)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    apiCall<any>('GET', 'subscriptions')
      .then((res) => {
        if (!res?.success) return
        setStatuses(res.items ?? [])
        setDefaultUa(res.default_user_agent ?? '')
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load, items])

  const saveItems = async (next: Subscription[]) => {
    const err = await patchAutomation({ subscriptions: { items: next } })
    if (err) showToast('Ошибка: ' + err, 'error')
    return !err
  }

  const update = async (name?: string) => {
    setBusy(name ?? '*')
    try {
      const res = await apiCall<any>('POST', 'subscriptions/update', name ? { name } : {}, { timeoutMs: 180_000 })
      if (res?.success) {
        showToast(res.updated ? 'Подписки обновлены, Xray перезапущен' : 'Подписки актуальны')
        if (res.updated) onChanged?.()
      } else showToast(res?.error || 'Ошибка обновления', 'error')
    } catch (e: any) {
      showToast(e.message, 'error')
    }
    setBusy(null)
    load()
  }

  const add = async () => {
    const name = draft.name.trim()
    if (!name || !/^https?:\/\//i.test(draft.url.trim())) {
      showToast('Укажите имя и URL подписки (http/https)', 'error')
      return
    }
    if (await saveItems([...items, { ...draft, name, url: draft.url.trim() }])) {
      setDraft(EMPTY)
      await update(name)
    }
  }

  const remove = async (name: string) => {
    setBusy(name)
    try {
      const res = await apiCall<any>('DELETE', 'subscriptions', { name })
      if (!res?.success) {
        showToast(res?.error || 'Не удалось удалить файл подписки', 'error')
        setBusy(null)
        return
      }
    } catch (e: any) {
      showToast(e.message, 'error')
      setBusy(null)
      return
    }
    if (await saveItems(items.filter((s) => s.name !== name))) {
      showToast(`Подписка «${name}» удалена`)
      onChanged?.()
    }
    setBusy(null)
  }

  const patchItem = (name: string, patch: Partial<Subscription>) => saveItems(items.map((s) => (s.name === name ? { ...s, ...patch } : s)))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] max-w-2xl! flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <IconRss size={22} className="text-chart-2" /> Подписки Xray
          </DialogTitle>
          <DialogDescription>
            Серверы из подписки сохраняются в отдельный файл и автоматически обновляются. Перед заменой конфиг проверяется Xray — при ошибке
            файл не меняется.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 pr-2">
            {items.length === 0 && (
              <div className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">Подписок пока нет</div>
            )}
            {items.map((sub) => {
              const st = statuses.find((s) => s.name === sub.name)
              return (
                <div key={sub.name} className="bg-input-background flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Switch size="sm" checked={sub.enabled} onCheckedChange={(v) => patchItem(sub.name, { enabled: v })} />
                    <span className="truncate text-sm font-medium">{sub.name}</span>
                    {st && st.count > 0 && (
                      <Badge variant="secondary" className="tabular-nums">
                        {st.count} серв.
                      </Badge>
                    )}
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        title="Обновить сейчас"
                        aria-label="Обновить сейчас"
                        disabled={busy !== null}
                        onClick={() => update(sub.name)}
                      >
                        {busy === sub.name ? <Spinner className="size-4" /> : <IconRefresh />}
                      </Button>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        title="Удалить"
                        aria-label="Удалить подписку"
                        className="hover:text-destructive"
                        disabled={busy !== null}
                        onClick={() => remove(sub.name)}
                      >
                        <IconTrash />
                      </Button>
                    </div>
                  </div>
                  <span className="text-muted-foreground truncate font-mono text-[11px]" title={sub.url}>
                    {sub.url}
                  </span>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                    <span className="flex items-center gap-1">
                      Каждые
                      <Input
                        type="number"
                        min={1}
                        max={168}
                        defaultValue={sub.interval_hours}
                        className="h-7 w-16 px-2 text-[12px]"
                        onBlur={(e) => {
                          const v = Math.max(1, Number(e.target.value) || 12)
                          if (v !== sub.interval_hours) void patchItem(sub.name, { interval_hours: v })
                        }}
                      />
                      ч
                    </span>
                    <span className="tabular-nums">Обновлено: {formatAgo(st?.last_success)}</span>
                    {st?.skipped ? <span>пропущено ссылок: {st.skipped}</span> : null}
                    {st?.file && <span className="font-mono text-[11px] opacity-70">{st.file.split('/').pop()}</span>}
                  </div>
                  {st?.last_error && (
                    <div className="text-destructive bg-destructive/10 rounded-md px-2 py-1 text-[12px] break-words">{st.last_error}</div>
                  )}
                </div>
              )
            })}
          </div>
        </ScrollArea>

        <div className="flex shrink-0 flex-col gap-2 border-t pt-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_5rem]">
            <Field className="gap-1">
              <FieldLabel htmlFor="sub-name" className="text-[12px]">
                Имя (латиница)
              </FieldLabel>
              <Input
                id="sub-name"
                value={draft.name}
                placeholder="provider"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="sub-url" className="text-[12px]">
                URL подписки
              </FieldLabel>
              <Input
                id="sub-url"
                value={draft.url}
                placeholder="https://example.com/sub/…"
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              />
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="sub-int" className="text-[12px]">
                Часы
              </FieldLabel>
              <Input
                id="sub-int"
                type="number"
                min={1}
                max={168}
                value={draft.interval_hours}
                onChange={(e) => setDraft({ ...draft, interval_hours: Math.max(1, Number(e.target.value) || 12) })}
              />
            </Field>
          </div>
          <Field className="gap-1">
            <FieldLabel htmlFor="sub-ua" className="text-[12px]">
              User-Agent (необязательно)
            </FieldLabel>
            <Input
              id="sub-ua"
              value={draft.user_agent}
              placeholder={defaultUa}
              onChange={(e) => setDraft({ ...draft, user_agent: e.target.value })}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={busy !== null || items.length === 0} onClick={() => update()}>
              {busy === '*' ? <Spinner className="size-4" /> : <IconCloudDownload data-icon="inline-start" />}
              Обновить все
            </Button>
            <Button className="ml-auto" disabled={busy !== null} onClick={add}>
              <IconPlus data-icon="inline-start" /> Добавить
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
