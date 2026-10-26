import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { IconDevices, IconInfoCircle, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'

interface Device {
  mac: string
  ip: string
  name: string
  online: boolean
  policy: string
  in_proxy: boolean
  forced: boolean
}

interface DevicesResponse {
  success: boolean
  error?: string
  mode?: 'policy' | 'exclude_list'
  policy?: string | null
  policy_full?: string | null
  devices?: Device[]
}

export function DevicesModal() {
  const { showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const open = modals.showDevicesModal
  const [data, setData] = useState<DevicesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyMac, setBusyMac] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showOffline, setShowOffline] = useState(false)
  const [restartNeeded, setRestartNeeded] = useState(false)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showDevicesModal', show: false })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiCall<DevicesResponse>('GET', 'devices', undefined, { timeoutMs: 15000 })
      setData(res)
      if (!res.success) showToast(res.error || 'Не удалось получить список устройств', 'error')
    } catch (e: any) {
      showToast(`Не удалось получить список устройств: ${e?.message ?? e}`, 'error')
    }
    setLoading(false)
  }, [showToast])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function toggle(device: Device, enabled: boolean) {
    setBusyMac(device.mac)
    try {
      const res = await apiCall<{ success: boolean; error?: string; restart_required?: boolean }>(
        'POST',
        'devices/proxy',
        { mac: device.mac, enabled },
        { timeoutMs: 20000 }
      )
      if (!res.success) {
        showToast(res.error || 'Не удалось изменить настройку устройства', 'error')
      } else {
        const label = device.name || device.ip || device.mac
        showToast(enabled ? `${label}: трафик идёт через прокси` : `${label}: трафик идёт напрямую`)
        if (res.restart_required) setRestartNeeded(true)
        setData((prev) =>
          prev?.devices ? { ...prev, devices: prev.devices.map((d) => (d.mac === device.mac ? { ...d, in_proxy: enabled } : d)) } : prev
        )
      }
    } catch (e: any) {
      showToast(`Ошибка: ${e?.message ?? e}`, 'error')
    }
    setBusyMac(null)
  }

  async function restartXkeen() {
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Перезапуск...' })
    const r = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'hardRestart' }).catch((e) => ({
      success: false,
      error: String(e),
    }))
    dispatch({ type: 'SET_SERVICE_STATUS', status: r.success ? 'running' : 'stopped' })
    showToast(r.success ? 'XKeen перезапущен, исключения применены' : `Ошибка перезапуска: ${r.error}`, r.success ? 'success' : 'error')
    if (r.success) setRestartNeeded(false)
  }

  const devices = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (data?.devices ?? []).filter(
      (d) => (showOffline || d.online || d.in_proxy) && (!q || [d.name, d.ip, d.mac].some((v) => v.toLowerCase().includes(q)))
    )
  }, [data, filter, showOffline])

  const hiddenOffline = (data?.devices ?? []).filter((d) => !d.online && !d.in_proxy).length
  const inProxy = (data?.devices ?? []).filter((d) => d.in_proxy).length

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="flex flex-col overflow-hidden"
        style={{ maxHeight: '95vh', maxWidth: '42rem', width: 'calc(100vw - 2rem)' }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pb-3">
            <IconDevices size={24} className="text-chart-2" />
            Устройства
          </DialogTitle>
          <DialogDescription>
            Выберите, какие устройства идут через прокси. <b className="text-foreground font-medium">Напрямую = полная скорость</b>: трафик
            не проходит через Xray и обрабатывается аппаратным ускорением роутера.
          </DialogDescription>
        </DialogHeader>

        {data?.success && data.mode === 'exclude_list' && (
          <Alert className="shrink-0">
            <IconInfoCircle />
            <AlertDescription className="text-[13px]">
              Политика доступа «xkeen» в Keenetic не найдена — XKeen проксирует все устройства. Переключатель добавляет адрес устройства в
              ip_exclude.lst; изменения вступят в силу после перезапуска XKeen. Надёжнее создать в веб-интерфейсе Keenetic политику с
              описанием «xkeen» — тогда устройства переключаются мгновенно.
            </AlertDescription>
          </Alert>
        )}
        {data?.success && data.mode === 'policy' && (
          <p className="text-muted-foreground shrink-0 text-xs">
            Режим: политика Keenetic «xkeen» ({data.policy}). Изменения применяются сразу и сохраняются в конфигурации роутера. Через
            прокси: {inProxy}.
          </p>
        )}

        {restartNeeded && (
          <Alert className="shrink-0">
            <IconInfoCircle />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
              Список исключений изменён. Чтобы применить, перезапустите XKeen.
              <Button size="sm" onClick={restartXkeen}>
                Перезапустить
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex shrink-0 items-center gap-2">
          <Input placeholder="Поиск по имени, IP или MAC" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Button variant="outline" size="icon" onClick={load} disabled={loading} aria-label="Обновить">
            {loading ? <Spinner className="size-4" /> : <IconRefresh className="size-4" />}
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 rounded-lg border">
          {loading && !data ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !data?.success ? (
            <p className="text-muted-foreground p-6 text-center text-sm">{data?.error || 'Нет данных'}</p>
          ) : devices.length === 0 ? (
            <p className="text-muted-foreground p-6 text-center text-sm">Устройства не найдены</p>
          ) : (
            <ul className="divide-border divide-y">
              {devices.map((d) => (
                <li key={d.mac} className="flex items-center gap-3 px-3 py-2.5">
                  <span className={cn('size-2 shrink-0 rounded-full', d.online ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{d.name || 'Без имени'}</span>
                      {d.forced && (
                        <Badge variant="outline" className="h-4.5 text-[10px]">
                          xkeen_full
                        </Badge>
                      )}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-[11px]">
                      {d.ip || '—'} · {d.mac}
                    </div>
                  </div>
                  <span className={cn('w-20 shrink-0 text-right text-xs', d.in_proxy ? 'text-foreground' : 'text-muted-foreground')}>
                    {d.in_proxy ? 'Прокси' : 'Напрямую'}
                  </span>
                  <div className="flex w-8 shrink-0 justify-end">
                    {busyMac === d.mac ? (
                      <Spinner className="size-4" />
                    ) : (
                      <Switch
                        checked={d.in_proxy}
                        disabled={d.forced || busyMac !== null || (data.mode === 'exclude_list' && !d.ip)}
                        onCheckedChange={(checked) => void toggle(d, checked)}
                        aria-label={`Прокси для ${d.name || d.mac}`}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        {hiddenOffline > 0 && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer self-start text-xs underline-offset-4 hover:underline"
            onClick={() => setShowOffline((v) => !v)}
          >
            {showOffline ? 'Скрыть офлайн-устройства' : `Показать офлайн-устройства (${hiddenOffline})`}
          </button>
        )}
      </DialogContent>
    </Dialog>
  )
}
