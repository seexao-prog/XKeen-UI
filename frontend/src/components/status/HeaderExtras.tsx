import { Button } from '@/components/ui/button'
import { KbdShortcut } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openCommandPalette, useCommandProvider } from '@/lib/commands'
import { IconCommand, IconPlayerPlayFilled, IconPlayerStopFilled, IconRefresh } from '@tabler/icons-react'
import { ThemeToggle } from './ThemeToggle'

/** Кнопки шапки, добавленные форком: командная палитра и переключатель темы. */
export function HeaderExtras({ loading }: { loading: boolean }) {
  if (loading) {
    return (
      <>
        <Skeleton className="size-9" />
        <Skeleton className="size-9" />
      </>
    )
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="outline" size="icon" onClick={openCommandPalette} aria-label="Командная палитра">
              <IconCommand className="size-4.5" />
            </Button>
          }
        />
        <TooltipContent className="flex items-center gap-2">
          Командная палитра <KbdShortcut shortcut="Mod+K" />
        </TooltipContent>
      </Tooltip>
      <ThemeToggle />
    </>
  )
}

/** Команды палитры для управления сервисом. Переиспользуют обработчики StatusBar (тосты, DNS-предупреждение, autoDns). */
export function useServiceCommands({
  isRunning,
  isPending,
  startService,
  stopService,
  restartService,
}: {
  isRunning: boolean
  isPending: boolean
  startService: () => Promise<void>
  stopService: () => Promise<void>
  restartService: () => Promise<void>
}) {
  useCommandProvider('service', () => [
    {
      id: 'service.restart',
      title: 'Перезапустить XKeen',
      group: 'Сервис',
      keywords: ['restart', 'перезапуск', 'рестарт', 'xkeen'],
      icon: IconRefresh,
      disabled: !isRunning || isPending,
      run: restartService,
    },
    {
      id: 'service.start',
      title: 'Запустить XKeen',
      group: 'Сервис',
      keywords: ['start', 'запуск', 'старт', 'xkeen'],
      icon: IconPlayerPlayFilled,
      disabled: isRunning || isPending,
      run: startService,
    },
    {
      id: 'service.stop',
      title: 'Остановить XKeen',
      group: 'Сервис',
      keywords: ['stop', 'остановка', 'стоп', 'xkeen'],
      icon: IconPlayerStopFilled,
      disabled: !isRunning || isPending,
      run: stopService,
    },
  ])
}
