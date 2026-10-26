import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { IconArrowLeft, IconCircleCheck, IconGauge, IconInfoCircle } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'
import {
  analyzeXray,
  buildQuicChanges,
  findQuicState,
  isXrayConfigFile,
  lineDiff,
  mergeChanges,
  type ConfigFile,
  type FileChange,
  type Finding,
} from '../../lib/xrayAdvisor'

type ApiResult = { success: boolean; error?: string }

const SEVERITY_LABEL: Record<Finding['severity'], string> = { high: 'Сильно', medium: 'Заметно', low: 'Слабо' }

function hasComments(content: string) {
  return /(?<!:)\/\//.test(content) || /\/\*[\s\S]*?\*\//.test(content)
}

function DiffView({ change }: { change: FileChange }) {
  const lines = useMemo(() => lineDiff(change.before, change.after), [change])
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="bg-muted/60 border-b px-3 py-1.5 font-mono text-[11px]">{change.file}</div>
      <pre className="overflow-x-auto py-1 font-mono text-[11px] leading-5">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              'px-3 whitespace-pre',
              l.type === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
              l.type === 'del' && 'bg-destructive/10 text-destructive',
              l.type === 'same' && 'text-muted-foreground'
            )}
          >
            {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
            {l.text}
          </div>
        ))}
      </pre>
    </div>
  )
}

export function ConfigAdvisorModal() {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const { modals } = useModalContext()
  const open = modals.showAdvisorModal
  const [preview, setPreview] = useState<{ title: string; changes: FileChange[] } | null>(null)
  const [applying, setApplying] = useState(false)

  const close = () => {
    if (applying) return
    setPreview(null)
    dispatch({ type: 'SHOW_MODAL', modal: 'showAdvisorModal', show: false })
  }

  const isXray = state.currentCore === 'xray'
  const files: ConfigFile[] = useMemo(
    () => state.configs.filter((c) => isXrayConfigFile(c.file)).map((c) => ({ file: c.file, content: c.savedContent })),
    [state.configs]
  )
  const findings = useMemo(() => (isXray ? analyzeXray(files) : []), [files, isXray])
  const quic = useMemo(() => (isXray ? findQuicState(files) : null), [files, isXray])
  const dirtyFiles = new Set(state.configs.filter((c) => c.isDirty).map((c) => c.file))

  function showPreview(title: string, build: () => FileChange[]) {
    try {
      const changes = build()
      if (!changes.length) {
        showToast('Изменений нет — конфиг уже в нужном состоянии', 'warning')
        return
      }
      const dirty = changes.filter((c) => dirtyFiles.has(c.file))
      if (dirty.length) {
        showToast(
          `Есть несохранённые правки в ${dirty.map((c) => c.file.split('/').pop()).join(', ')} — сохраните или отмените их`,
          'error'
        )
        return
      }
      setPreview({ title, changes })
    } catch (e: any) {
      showToast(e?.message ?? String(e), 'error')
    }
  }

  async function apply(changes: FileChange[]) {
    setApplying(true)
    const written: FileChange[] = []
    const rollback = async () => {
      for (const c of written.reverse()) await apiCall<ApiResult>('PUT', 'configs', { file: c.file, content: c.before }).catch(() => null)
    }
    try {
      // Все файлы, кроме последнего, пишем без проверки; последний — с ?validate=xray: бэкенд
      // проверяет весь каталог конфигов уже с новыми версиями. Ошибка — откат всех файлов.
      // Строгий remote-парсер Xray не принимает комментарии — для JSONC проверку пропускаем.
      const skipValidation = changes.some((c) => hasComments(c.after)) || files.some((f) => hasComments(f.content))
      for (let i = 0; i < changes.length; i++) {
        const c = changes[i]
        const last = i === changes.length - 1
        const endpoint = last && !skipValidation ? 'configs?validate=xray' : 'configs'
        const res = await apiCall<ApiResult>('PUT', endpoint, { file: c.file, content: c.after })
        if (!res.success) {
          if (res.error !== 'Validation failed') written.push(c)
          await rollback()
          throw new Error(
            res.error === 'Validation failed'
              ? 'Xray отклонил конфиг (подробности в журнале) — изменения отменены'
              : res.error || 'Ошибка сохранения'
          )
        }
        written.push(c)
      }
      const configs = state.configs
      for (const c of changes) {
        const index = configs.findIndex((cfg) => cfg.file === c.file)
        if (index >= 0) dispatch({ type: 'SAVE_CONFIG', index, content: c.after })
      }
      if (state.serviceStatus === 'running') {
        dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Перезапуск...' })
        const r = await apiCall<ApiResult>('POST', 'control', { action: 'softRestart', core: 'xray' })
        dispatch({ type: 'SET_SERVICE_STATUS', status: r?.success ? 'running' : 'stopped' })
        showToast(r?.success ? 'Изменения применены' : `Сохранено, но перезапуск не удался: ${r?.error}`, r?.success ? 'success' : 'error')
      } else {
        showToast('Изменения сохранены. Xray не запущен — они вступят в силу при запуске')
      }
      setPreview(null)
    } catch (e: any) {
      showToast(e?.message ?? String(e), 'error')
    }
    setApplying(false)
  }

  // «Исправить всё» — только пункты, не меняющие логику маршрутизации и протокол (логи, mux, routeOnly).
  const fixable = findings.filter((f) => f.fixable && f.fix && f.bulk)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="flex flex-col overflow-hidden"
        style={{ maxHeight: '95vh', maxWidth: '46rem', width: 'calc(100vw - 2rem)' }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pb-3">
            <IconGauge size={24} className="text-chart-2" />
            {preview ? preview.title : 'Анализ конфига'}
          </DialogTitle>
          <DialogDescription>
            {preview
              ? 'Проверьте изменения. Будут сохранены только эти строки, комментарии и остальное содержимое файлов не меняются.'
              : 'Настройки Xray, которые лишний раз нагружают процессор слабого роутера. Ничего не меняется без вашего подтверждения.'}
          </DialogDescription>
        </DialogHeader>

        {!isXray ? (
          <p className="text-muted-foreground text-sm">Анализ доступен только для ядра Xray.</p>
        ) : preview ? (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-3 pr-2">
                {preview.changes.map((c) => (
                  <DiffView key={c.file} change={c} />
                ))}
              </div>
            </ScrollArea>
            <div className="flex shrink-0 justify-between gap-2">
              <Button variant="outline" onClick={() => setPreview(null)} disabled={applying}>
                <IconArrowLeft data-icon="inline-start" /> Назад
              </Button>
              <Button onClick={() => apply(preview.changes)} disabled={applying}>
                {applying && <Spinner className="size-4" />}
                {state.serviceStatus === 'running' ? 'Сохранить и применить' : 'Сохранить'}
              </Button>
            </div>
          </>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 pr-2">
              {quic && (
                <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Блокировать QUIC (UDP 443)</div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Браузеры и приложения перейдут с QUIC на обычный TCP/TLS. Для Xray на роутере TCP заметно дешевле: работает XTLS
                      Vision, нет потерь UDP. Правило ставится первым в routing.rules
                      {quic.blackholeTag ? ` → «${quic.blackholeTag}»` : ', при необходимости добавится outbound «block»'}.
                    </p>
                    {quic.error && <p className="text-destructive mt-1 text-xs">{quic.error}</p>}
                  </div>
                  <Switch
                    checked={quic.enabled}
                    disabled={!!quic.error && !quic.enabled}
                    onCheckedChange={(checked) =>
                      showPreview(checked ? 'Блокировка QUIC' : 'Снятие блокировки QUIC', () => buildQuicChanges(files, checked))
                    }
                  />
                </div>
              )}

              {findings.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <IconCircleCheck className="text-emerald-500" size={32} />
                  <p className="text-sm">Тяжёлых настроек не найдено</p>
                  <p className="text-muted-foreground text-xs">Проверены сохранённые версии файлов в /opt/etc/xray/configs</p>
                </div>
              ) : (
                <>
                  {fixable.length > 1 && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground text-xs">Найдено: {findings.length}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          showPreview('Безопасные исправления', () =>
                            mergeChanges(
                              files,
                              fixable.map((f) => f.fix!)
                            )
                          )
                        }
                      >
                        Исправить безопасное ({fixable.length})
                      </Button>
                    </div>
                  )}
                  {findings.map((f) => (
                    <div key={f.id} className="flex flex-col gap-2 rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{f.title}</span>
                            <Badge
                              variant={f.severity === 'high' ? 'rose' : f.severity === 'medium' ? 'amber' : 'secondary'}
                              className="text-[10px]"
                            >
                              {SEVERITY_LABEL[f.severity]}
                            </Badge>
                          </div>
                          <div className="text-muted-foreground mt-0.5 font-mono text-[11px]">{f.location}</div>
                        </div>
                        {f.fixable && f.fix && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => showPreview(f.title, () => f.fix!(files))}
                          >
                            Исправить
                          </Button>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs leading-relaxed">{f.description}</p>
                    </div>
                  ))}
                </>
              )}

              {dirtyFiles.size > 0 && (
                <Alert>
                  <IconInfoCircle />
                  <AlertDescription className="text-xs">
                    Анализ идёт по сохранённым версиям файлов. Несохранённые правки в редакторе не учитываются.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
