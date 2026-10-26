import { memo, useMemo } from 'react'
import { useUptime } from '../../lib/automation'
import { cn } from '../../lib/utils'

const BUCKETS = 48 // 24 ч по 30 минут

type Bucket = { from: number; ok: number; fail: number; avg: number }

function buildBuckets(points: [number, number][], now: number, windowSecs: number): Bucket[] {
  const size = windowSecs / BUCKETS
  const start = now - windowSecs
  const buckets: Bucket[] = Array.from({ length: BUCKETS }, (_, i) => ({ from: start + i * size, ok: 0, fail: 0, avg: 0 }))
  for (const [ts, delay] of points) {
    const i = Math.floor((ts - start) / size)
    if (i < 0 || i >= BUCKETS) continue
    const b = buckets[i]
    if (delay > 0) {
      b.avg = (b.avg * b.ok + delay) / (b.ok + 1)
      b.ok++
    } else b.fail++
  }
  return buckets
}

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

/** Полоска доступности сервера за 24 ч в стиле status-page. Ничего не рисует, пока нет данных. */
export const UptimeBar = memo(function UptimeBar({ tag, className }: { tag: string; className?: string }) {
  const data = useUptime()
  const points = data?.history?.[tag]
  const buckets = useMemo(() => (data && points?.length ? buildBuckets(points, data.now, data.window_secs) : null), [data, points])
  if (!data || !buckets) return null

  const total = points!.length
  const ok = points!.filter(([, d]) => d > 0).length
  const pct = total ? (ok / total) * 100 : 0
  const size = data.window_secs / BUCKETS

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex h-5 items-stretch gap-[2px]" role="img" aria-label={`Доступность за 24 ч: ${pct.toFixed(1)}%`}>
        {buckets.map((b, i) => {
          const state = b.ok + b.fail === 0 ? 'none' : b.fail === 0 ? 'ok' : b.ok === 0 ? 'down' : 'partial'
          const title =
            `${fmtTime(b.from)}–${fmtTime(b.from + size)}: ` +
            (state === 'none'
              ? 'нет данных'
              : state === 'ok'
                ? `доступен, ~${Math.round(b.avg)} мс`
                : state === 'down'
                  ? 'недоступен'
                  : `сбои ${b.fail} из ${b.ok + b.fail}`)
          return (
            <span
              key={i}
              title={title}
              className={cn(
                'min-w-0 flex-1 rounded-[2px] transition-opacity hover:opacity-70',
                state === 'ok' && 'bg-emerald-500',
                state === 'partial' && 'bg-amber-500',
                state === 'down' && 'bg-red-500',
                state === 'none' && 'bg-muted'
              )}
            />
          )
        })}
      </div>
      <div className="text-muted-foreground flex justify-between text-[11px] tabular-nums">
        <span>24 ч назад</span>
        <span className={cn('font-medium', pct >= 99 ? 'text-emerald-500' : pct >= 90 ? 'text-amber-500' : 'text-red-500')}>
          {pct.toFixed(pct === 100 ? 0 : 1)}% доступности
        </span>
        <span>сейчас</span>
      </div>
    </div>
  )
})
