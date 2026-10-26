import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { IconAlertCircle, IconPlayerPlay, IconSend } from '@tabler/icons-react'
import { memo, useCallback, useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import {
  DEFAULT_GEO_COMMAND,
  DEFAULT_TG_API,
  patchAutomation,
  useAutomation,
  type AutomationSettings as Automation,
  type NotifyEvents,
} from '../../lib/automation'
import { useAppActions } from '../../lib/store'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground pt-3 pb-1 text-xs font-medium tracking-wider uppercase">{children}</p>
}

/** Текстовое поле, сохраняющее значение по blur/Enter. */
function DraftInput({
  id,
  value,
  onCommit,
  className,
  type = 'text',
  placeholder,
  ...rest
}: {
  id?: string
  value: string
  onCommit: (v: string) => void
  className?: string
  type?: string
  placeholder?: string
  min?: number
  max?: number
  autoComplete?: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => draft !== value && onCommit(draft)
  return (
    <Input
      id={id}
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      className={className}
      {...rest}
    />
  )
}

type SchedKey = keyof Automation['scheduler']

const TASKS: { key: SchedKey; title: string; description: string }[] = [
  {
    key: 'backup',
    title: 'Автобэкап конфигураций',
    description: 'Бэкап в /opt/backups с меткой _auto_; старые автобэкапы удаляются, ручные не трогаются',
  },
  { key: 'geo_update', title: 'Обновление geo-файлов', description: 'Запуск команды обновления GeoSite/GeoIP XKeen' },
  {
    key: 'restart_core',
    title: 'Перезапуск ядра',
    description: 'Полный перезапуск XKeen через init-скрипт — кратковременный обрыв соединений',
  },
]

const EVENTS: { key: keyof NotifyEvents; label: string }[] = [
  { key: 'service_down', label: 'Ядро упало' },
  { key: 'service_up', label: 'Ядро восстановилось' },
  { key: 'server_down', label: 'Сервер недоступен (нужен мониторинг аптайма)' },
  { key: 'update_available', label: 'Доступно обновление' },
]

type TaskStatus = { next_run: string | null; last_run: string | null; ok: boolean | null; message: string | null }

export const AutomationSettingsTab = memo(function AutomationSettingsTab() {
  const { showToast } = useAppActions()
  const { automation, loaded } = useAutomation()
  const [testing, setTesting] = useState(false)
  const [running, setRunning] = useState<SchedKey | null>(null)
  const [status, setStatus] = useState<Record<string, TaskStatus>>({})

  const tg = automation.notify.telegram
  const sched = automation.scheduler
  const uptime = automation.uptime

  const loadStatus = useCallback(() => {
    apiCall<any>('GET', 'scheduler')
      .then((res) => res?.success && setStatus(res.tasks ?? {}))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (loaded) loadStatus()
  }, [loaded, loadStatus, sched])

  const save = useCallback(
    async (patch: Parameters<typeof patchAutomation>[0]) => {
      const err = await patchAutomation(patch)
      if (err) showToast('Ошибка: ' + err, 'error')
      return !err
    },
    [showToast]
  )

  const sendTest = async () => {
    setTesting(true)
    try {
      const res = await apiCall<any>('POST', 'notify/test', {})
      res?.success ? showToast('Тестовое уведомление отправлено') : showToast(res?.error || 'Не удалось отправить', 'error')
    } catch (e: any) {
      showToast(e.message, 'error')
    }
    setTesting(false)
  }

  const runNow = async (task: SchedKey) => {
    setRunning(task)
    try {
      const res = await apiCall<any>('POST', 'scheduler/run', { task })
      res?.success ? showToast(res.message || 'Готово') : showToast(res?.error || 'Ошибка выполнения', 'error')
    } catch (e: any) {
      showToast(e.message, 'error')
    }
    setRunning(null)
    loadStatus()
  }

  if (!loaded)
    return (
      <div className="flex justify-center py-10">
        <Spinner className="text-muted-foreground size-5" />
      </div>
    )

  return (
    <FieldGroup className="gap-0!">
      {/* ── Telegram ── */}
      <SectionTitle>Уведомления в Telegram</SectionTitle>
      <Field orientation="horizontal" className="px-0 py-3">
        <FieldContent>
          <FieldLabel htmlFor="tg-enabled">Включить уведомления</FieldLabel>
          <FieldDescription className="text-[13px]">
            Проверка раз в минуту, одно и то же событие — не чаще указанного интервала
          </FieldDescription>
        </FieldContent>
        <Switch id="tg-enabled" checked={tg.enabled} onCheckedChange={(v) => save({ notify: { telegram: { enabled: v } } })} />
      </Field>
      <div className="grid grid-cols-1 gap-3 pb-3 sm:grid-cols-2">
        <Field className="gap-1.5">
          <FieldLabel htmlFor="tg-token">Токен бота</FieldLabel>
          <DraftInput
            id="tg-token"
            type="password"
            autoComplete="off"
            value={tg.bot_token}
            placeholder="123456:ABC-DEF…"
            onCommit={(v) => save({ notify: { telegram: { bot_token: v.trim() } } })}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="tg-chat">Chat ID</FieldLabel>
          <DraftInput
            id="tg-chat"
            value={tg.chat_id}
            placeholder="123456789"
            onCommit={(v) => save({ notify: { telegram: { chat_id: v.trim() } } })}
          />
        </Field>
        <Field className="gap-1.5 sm:col-span-2">
          <FieldLabel htmlFor="tg-api">Адрес Bot API</FieldLabel>
          <DraftInput
            id="tg-api"
            value={tg.api_base}
            placeholder={DEFAULT_TG_API}
            onCommit={(v) => save({ notify: { telegram: { api_base: v.trim() || DEFAULT_TG_API } } })}
          />
          <FieldDescription className="text-[12px]">
            Если api.telegram.org недоступен — укажите своё зеркало или реверс-прокси (путь /bot&lt;токен&gt;/… сохраняется)
          </FieldDescription>
        </Field>
      </div>
      <div className="flex flex-col gap-2 pb-3">
        {EVENTS.map((ev) => (
          <label key={ev.key} className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
            <span>{ev.label}</span>
            <Switch
              size="sm"
              checked={tg.events[ev.key]}
              onCheckedChange={(v) => save({ notify: { telegram: { events: { [ev.key]: v } } } })}
            />
          </label>
        ))}
      </div>
      <div className="flex items-end gap-2 pb-3">
        <Field className="w-44 gap-1.5">
          <FieldLabel htmlFor="tg-cooldown">Повтор не чаще, мин</FieldLabel>
          <DraftInput
            id="tg-cooldown"
            type="number"
            min={1}
            max={1440}
            value={String(tg.cooldown_minutes)}
            onCommit={(v) => save({ notify: { telegram: { cooldown_minutes: Math.max(1, Number(v) || 30) } } })}
          />
        </Field>
        <Button variant="outline" onClick={sendTest} disabled={testing || !tg.bot_token || !tg.chat_id} className="ml-auto">
          {testing ? <Spinner className="size-4" /> : <IconSend data-icon="inline-start" />}
          Тест
        </Button>
      </div>

      <Separator className="my-2" />

      {/* ── Расписание ── */}
      <SectionTitle>Расписание</SectionTitle>
      {TASKS.map((task, i) => {
        const t = sched[task.key]
        const st = status[task.key]
        return (
          <div key={task.key}>
            <Field orientation="horizontal" className="px-0 py-3">
              <FieldContent>
                <FieldLabel htmlFor={`sched-${task.key}`}>{task.title}</FieldLabel>
                <FieldDescription className="text-[13px]">{task.description}</FieldDescription>
                {(st?.next_run || st?.last_run) && (
                  <span className="text-muted-foreground text-[12px] tabular-nums">
                    {st.next_run && <>Следующий запуск: {st.next_run}</>}
                    {st.next_run && st.last_run && ' · '}
                    {st.last_run && (
                      <span className={st.ok === false ? 'text-destructive' : undefined} title={st.message ?? undefined}>
                        последний: {st.last_run} {st.ok === false ? '— ошибка' : '— ок'}
                      </span>
                    )}
                  </span>
                )}
              </FieldContent>
              <div className="flex shrink-0 items-center gap-2">
                <DraftInput
                  type="time"
                  value={t.time}
                  className="w-24 tabular-nums"
                  onCommit={(v) => save({ scheduler: { [task.key]: { time: v } } })}
                />
                <Button
                  variant="outline"
                  size="icon"
                  title="Запустить сейчас"
                  aria-label="Запустить сейчас"
                  disabled={running !== null}
                  onClick={() => runNow(task.key)}
                >
                  {running === task.key ? <Spinner className="size-4" /> : <IconPlayerPlay />}
                </Button>
                <Switch
                  id={`sched-${task.key}`}
                  checked={t.enabled}
                  onCheckedChange={(v) => save({ scheduler: { [task.key]: { enabled: v } } })}
                />
              </div>
            </Field>
            {task.key === 'backup' && (
              <div className="flex items-center gap-2 pb-3 text-[13px]">
                <span className="text-muted-foreground">Хранить автобэкапов:</span>
                <DraftInput
                  type="number"
                  min={1}
                  max={100}
                  className="w-20"
                  value={String(sched.backup.keep)}
                  onCommit={(v) => save({ scheduler: { backup: { keep: Math.max(1, Number(v) || 7) } } })}
                />
              </div>
            )}
            {task.key === 'geo_update' && (
              <Field className="gap-1.5 pb-3">
                <FieldLabel htmlFor="geo-cmd" className="text-[13px]">
                  Команда
                </FieldLabel>
                <DraftInput
                  id="geo-cmd"
                  className="font-mono text-[12px]!"
                  value={sched.geo_update.command}
                  placeholder={DEFAULT_GEO_COMMAND}
                  onCommit={(v) => save({ scheduler: { geo_update: { command: v.trim() || DEFAULT_GEO_COMMAND } } })}
                />
              </Field>
            )}
            {i < TASKS.length - 1 && <Separator className="my-0" />}
          </div>
        )
      })}
      <FieldDescription className="pb-2 text-[12px]">Время — в часовом поясе журнала (вкладка «Общие»).</FieldDescription>

      <Separator className="my-2" />

      {/* ── Аптайм ── */}
      <SectionTitle>Мониторинг доступности серверов (Xray)</SectionTitle>
      <Alert className="my-2 border-amber-500/20 bg-amber-100 p-2.75 text-yellow-600 dark:bg-[#2a1f0d] dark:text-amber-400">
        <IconAlertCircle className="size-4.5" />
        <AlertDescription className="text-xs leading-4.25 tracking-wide text-yellow-600 dark:text-amber-400">
          Каждая проверка запускает временный процесс Xray и пингует все серверы — на слабых роутерах это заметная нагрузка. Не ставьте
          интервал меньше 10–15 минут без необходимости.
        </AlertDescription>
      </Alert>
      <Field orientation="horizontal" className="px-0 py-3">
        <FieldContent>
          <FieldLabel htmlFor="uptime-enabled">Фоновый мониторинг</FieldLabel>
          <FieldDescription className="text-[13px]">
            История за 24 часа отображается полоской в карточках подключений (GUI Outbounds)
          </FieldDescription>
        </FieldContent>
        <div className="flex shrink-0 items-center gap-2">
          <DraftInput
            type="number"
            min={5}
            max={1440}
            className="w-20"
            value={String(uptime.interval_minutes)}
            onCommit={(v) => save({ uptime: { interval_minutes: Math.max(5, Number(v) || 10) } })}
          />
          <span className="text-muted-foreground text-[13px]">мин</span>
          <Switch id="uptime-enabled" checked={uptime.enabled} onCheckedChange={(v) => save({ uptime: { enabled: v } })} />
        </div>
      </Field>
    </FieldGroup>
  )
})
