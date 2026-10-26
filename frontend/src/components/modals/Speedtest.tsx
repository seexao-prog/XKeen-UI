import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { IconBolt, IconPlayerPlayFilled } from '@tabler/icons-react'
import { parse as parseJsonc } from 'jsonc-parser'
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'

const DEFAULT_URL = 'https://speed.cloudflare.com/__down?bytes=25000000'
const URL_KEY = 'speedtest-url'
const SECONDS = 10
const SKIP_PROTOCOLS = new Set(['freedom', 'blackhole', 'dns', 'loopback'])

type Mode = 'direct' | 'proxy'

interface Result {
  success: boolean
  error?: string
  mbps?: number
  bytes?: number
  seconds?: number
  ttfb_ms?: number
}

function ResultCard({
  title,
  hint,
  result,
  running,
  progress,
}: {
  title: string
  hint: string
  result?: Result
  running: boolean
  progress: number
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-4">
      <span className="text-muted-foreground text-xs">{title}</span>
      {running ? (
        <div className="flex flex-col gap-2 py-1">
          <span className="flex items-center gap-2 text-sm">
            <Spinner className="size-4" /> Измерение…
          </span>
          <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
            <div
              className="bg-foreground h-full rounded-full transition-[width] duration-1000 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : result?.success ? (
        <>
          <span className="text-3xl font-semibold tracking-tight tabular-nums">
            {result.mbps?.toFixed(1)} <span className="text-muted-foreground text-base font-normal">Мбит/с</span>
          </span>
          <span className="text-muted-foreground text-[11px]">
            {((result.bytes ?? 0) / 1e6).toFixed(1)} МБ за {result.seconds} с · ответ {result.ttfb_ms} мс
          </span>
        </>
      ) : result ? (
        <span className="text-destructive text-sm break-words">{result.error || 'Ошибка'}</span>
      ) : (
        <span className="text-muted-foreground text-2xl">—</span>
      )}
      <span className="text-muted-foreground mt-auto pt-2 text-[11px]">{hint}</span>
    </div>
  )
}

export function SpeedtestModal() {
  const { state } = useAppContext({ includeConfigs: true })
  const { modals, dispatch } = useModalContext()
  const open = modals.showSpeedtestModal
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) || DEFAULT_URL)
  const [running, setRunning] = useState<Mode | null>(null)
  const [progress, setProgress] = useState(0)
  const [results, setResults] = useState<Partial<Record<Mode, Result>>>({})
  const [outboundTag, setOutboundTag] = useState('')
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showSpeedtestModal', show: false })
  const isXray = state.currentCore === 'xray'

  const outbounds = useMemo(() => {
    if (!isXray) return []
    const list: any[] = []
    for (const cfg of state.configs) {
      if (!cfg.file.endsWith('.json') || cfg.file.startsWith('/opt/etc/xkeen')) continue
      try {
        const json = parseJsonc(cfg.savedContent)
        if (Array.isArray(json?.outbounds)) list.push(...json.outbounds.filter((o: any) => o?.tag && !SKIP_PROTOCOLS.has(o?.protocol)))
      } catch {
        /* пропускаем битые файлы */
      }
    }
    return list
  }, [state.configs, isXray])

  useEffect(() => {
    if (outbounds.length && !outbounds.some((o) => o.tag === outboundTag)) setOutboundTag(outbounds[0].tag)
  }, [outbounds, outboundTag])

  useEffect(
    () => () => {
      if (progressTimer.current) clearInterval(progressTimer.current)
    },
    []
  )

  async function run(mode: Mode) {
    const outbound = outbounds.find((o) => o.tag === outboundTag)
    if (mode === 'proxy' && !outbound) return
    localStorage.setItem(URL_KEY, url.trim() || DEFAULT_URL)
    setRunning(mode)
    setProgress(0)
    const started = Date.now()
    progressTimer.current = setInterval(() => setProgress(Math.min(100, ((Date.now() - started) / ((SECONDS + 2) * 1000)) * 100)), 500)
    try {
      const res = await apiCall<Result>(
        'POST',
        'speedtest',
        { mode, url: url.trim() || DEFAULT_URL, seconds: SECONDS, outbound: mode === 'proxy' ? outbound : undefined },
        { timeoutMs: (SECONDS + 35) * 1000 }
      )
      setResults((r) => ({ ...r, [mode]: res }))
    } catch (e: any) {
      setResults((r) => ({
        ...r,
        [mode]: { success: false, error: e?.name === 'AbortError' ? 'Превышено время ожидания' : String(e?.message ?? e) },
      }))
    }
    if (progressTimer.current) clearInterval(progressTimer.current)
    setRunning(null)
  }

  async function runBoth() {
    await run('direct')
    if (isXray && outbounds.length) await run('proxy')
  }

  const direct = results.direct?.success ? results.direct.mbps : undefined
  const proxy = results.proxy?.success ? results.proxy.mbps : undefined
  const ratio = direct && proxy ? Math.round((proxy / direct) * 100) : null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !running && close()}>
      <DialogContent
        className="flex flex-col overflow-hidden"
        style={{ maxHeight: '95vh', maxWidth: '40rem', width: 'calc(100vw - 2rem)' }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pb-3">
            <IconBolt size={24} className="text-chart-2" />
            Спидтест роутера
          </DialogTitle>
          <DialogDescription>
            Роутер сам скачивает тестовый файл ~{SECONDS} с: напрямую и через выбранный сервер. Так видно, сколько вытягивает процессор
            роутера при шифровании.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">URL тестового файла</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!running} className="font-mono text-xs" />
          </div>
          {isXray && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Сервер (outbound) для теста через прокси</Label>
              {outbounds.length ? (
                <Select value={outboundTag} onValueChange={(v) => setOutboundTag(String(v))} disabled={!!running}>
                  <SelectTrigger className="w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {outbounds.map((o) => (
                        <SelectItem key={o.tag} value={o.tag}>
                          {o.tag} <span className="text-muted-foreground text-xs">{o.protocol}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-xs">В сохранённых конфигах нет подходящих outbound</p>
              )}
            </div>
          )}
        </div>

        <div className={cn('grid gap-3', isXray ? 'sm:grid-cols-2' : 'grid-cols-1')}>
          <ResultCard
            title="Напрямую"
            hint="Скорость канала роутера без прокси"
            result={results.direct}
            running={running === 'direct'}
            progress={progress}
          />
          {isXray && (
            <ResultCard
              title="Через прокси"
              hint="Через одноразовый Xray с выбранным outbound — с шифрованием на CPU роутера"
              result={results.proxy}
              running={running === 'proxy'}
              progress={progress}
            />
          )}
        </div>

        {ratio != null && (
          <p className="text-muted-foreground text-xs">
            Через прокси — {ratio}% от прямой скорости.
            {ratio < 50 &&
              ' Большая разница обычно означает упор в процессор роутера: проверьте «Нагрузку» во время теста и «Анализ конфига».'}
          </p>
        )}
        {!isXray && <p className="text-muted-foreground text-xs">Тест через прокси доступен для ядра Xray.</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => run('direct')} disabled={!!running}>
            Напрямую
          </Button>
          {isXray && (
            <Button variant="outline" onClick={() => run('proxy')} disabled={!!running || !outbounds.length}>
              Через прокси
            </Button>
          )}
          <Button onClick={runBoth} disabled={!!running}>
            {running ? <Spinner className="size-4" /> : <IconPlayerPlayFilled data-icon="inline-start" />}
            {isXray ? 'Оба теста' : 'Запустить'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
