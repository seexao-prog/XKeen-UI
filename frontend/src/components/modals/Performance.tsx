import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { IconActivity, IconInfoCircle } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'

interface PerfResponse {
  success: boolean
  error?: string
  cpu: { total: number; cores: number[] }
  process: { name: string; running: boolean; cpu_total: number | null; cpu_core: number | null; rss: number | null }
  net: { name: string; rx_bps: number; tx_bps: number }[]
  interval_ms: number
}

const POLL_MS = 1500
const HISTORY = 60

function formatBps(bps: number) {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Гбит/с`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Мбит/с`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} Кбит/с`
  return `${bps} бит/с`
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return '—'
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

/** Мини-график без библиотек: SVG polyline по последним значениям. */
function Sparkline({ values, max, className }: { values: number[]; max?: number; className?: string }) {
  const w = 120
  const h = 32
  const top = Math.max(max ?? 0, ...values, 1)
  const step = w / (HISTORY - 1)
  const offset = HISTORY - values.length
  const points = values.map((v, i) => `${((offset + i) * step).toFixed(1)},${(h - (v / top) * (h - 2) - 1).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn('h-8 w-full', className)} aria-hidden>
      {values.length > 1 && (
        <>
          <polyline points={`${(offset * step).toFixed(1)},${h} ${points} ${w},${h}`} className="fill-foreground/5 stroke-none" />
          <polyline points={points} className="stroke-foreground fill-none" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  )
}

function Bar({ value }: { value: number }) {
  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-500',
          value >= 90 ? 'bg-destructive' : value >= 70 ? 'bg-amber-500' : 'bg-foreground'
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

function Stat({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {sub && <span className="text-muted-foreground -mt-1 text-[11px]">{sub}</span>}
      {children}
    </div>
  )
}

export function PerformanceModal() {
  const { modals, dispatch } = useModalContext()
  const open = modals.showPerfModal
  const [data, setData] = useState<PerfResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [procHistory, setProcHistory] = useState<number[]>([])
  const [netHistory, setNetHistory] = useState<Record<string, number[]>>({})
  const [showIdle, setShowIdle] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showPerfModal', show: false })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setCpuHistory([])
    setProcHistory([])
    setNetHistory({})
    const push = (arr: number[], v: number) => [...arr, v].slice(-HISTORY)

    const tick = async () => {
      // Опрос только пока панель открыта и вкладка видима — роутер не нагружается в фоне.
      if (document.visibilityState === 'visible') {
        try {
          const res = await apiCall<PerfResponse>('GET', 'perf', undefined, { timeoutMs: 5000 })
          if (cancelled) return
          if (res.success) {
            setData(res)
            setError(null)
            setCpuHistory((h) => push(h, res.cpu.total))
            setProcHistory((h) => push(h, res.process.cpu_core ?? 0))
            setNetHistory((prev) => {
              const next: Record<string, number[]> = {}
              for (const n of res.net) next[n.name] = push(prev[n.name] ?? [], n.rx_bps + n.tx_bps)
              return next
            })
          } else setError(res.error || 'Нет данных')
        } catch (e: any) {
          if (!cancelled) setError(e?.message ?? String(e))
        }
      }
      if (!cancelled) timer.current = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [open])

  const coresCount = data?.cpu.cores.length ?? 1
  const procCore = data?.process.cpu_core ?? null
  const saturated = procCore != null && (procCore >= 90 || (data?.cpu.total ?? 0) >= 90)
  const interfaces = (data?.net ?? []).filter((n) => n.name !== 'lo' && (showIdle || n.rx_bps + n.tx_bps > 8000))
  const hiddenCount = (data?.net ?? []).filter((n) => n.name !== 'lo').length - interfaces.length

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="flex flex-col overflow-hidden"
        style={{ maxHeight: '95vh', maxWidth: '44rem', width: 'calc(100vw - 2rem)' }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pb-3">
            <IconActivity size={24} className="text-chart-2" />
            Нагрузка
          </DialogTitle>
          <DialogDescription>Обновляется каждые 1,5 с, пока окно открыто.</DialogDescription>
        </DialogHeader>

        {error && !data ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : !data ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Stat
                label="Процессор роутера"
                value={`${data.cpu.total.toFixed(0)}%`}
                sub={`${coresCount} ядр${coresCount === 1 ? 'о' : 'а'}`}
              >
                <Sparkline values={cpuHistory} max={100} />
                <div className="flex flex-col gap-1">
                  {data.cpu.cores.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px]">
                      <span className="text-muted-foreground w-10 shrink-0">CPU{i}</span>
                      <Bar value={c} />
                      <span className="w-9 shrink-0 text-right tabular-nums">{c.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </Stat>
              <Stat
                label={`Процесс ${data.process.name}`}
                value={data.process.running ? (procCore != null ? `${procCore.toFixed(0)}%` : '…') : 'не запущен'}
                sub={data.process.running ? `от одного ядра · память ${formatBytes(data.process.rss)}` : undefined}
              >
                <Sparkline values={procHistory} max={100} />
                {data.process.running && procCore != null && <Bar value={procCore} />}
              </Stat>
            </div>

            {saturated && (
              <Alert>
                <IconInfoCircle />
                <AlertDescription className="text-[13px]">
                  Процессор загружен почти полностью. Если во время спидтеста {data.process.name} держится около 100% — скорость упирается в
                  процессор роутера, а не в сервер или провайдера.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-xs">Интерфейсы (приём + передача)</span>
              {interfaces.length === 0 && <p className="text-muted-foreground text-xs">Нет заметного трафика</p>}
              {interfaces.map((n) => (
                <div key={n.name} className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 rounded-lg border px-3 py-2">
                  <span className="truncate font-mono text-xs">{n.name}</span>
                  <Sparkline values={netHistory[n.name] ?? []} className="h-6" />
                  <span className="text-right text-[11px] leading-tight tabular-nums">
                    ↓ {formatBps(n.rx_bps)}
                    <br />↑ {formatBps(n.tx_bps)}
                  </span>
                </div>
              ))}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground cursor-pointer self-start text-xs underline-offset-4 hover:underline"
                  onClick={() => setShowIdle((v) => !v)}
                >
                  {showIdle ? 'Скрыть неактивные' : `Показать неактивные (${hiddenCount})`}
                </button>
              )}
            </div>

            <p className="text-muted-foreground text-[11px]">
              Подсказка: запустите спидтест и посмотрите сюда. Если {data.process.name} ≈100% одного ядра — упор в процессор роутера.
              Устройства, которым прокси не нужен, лучше пустить напрямую (раздел «Устройства»).
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
