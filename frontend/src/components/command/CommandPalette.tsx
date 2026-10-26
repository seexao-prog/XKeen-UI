import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdShortcut } from '@/components/ui/kbd'
import {
  executeCommand,
  findCommand,
  getCommands,
  getCommandsVersion,
  matchesShortcut,
  OPEN_PALETTE_EVENT,
  subscribeCommands,
  useCommandProvider,
  type AppCommand,
} from '@/lib/commands'
import { showToast, useAppActions, useAppContext, useCurrentCore, useSettings } from '@/lib/store'
import { useUiPrefs } from '@/lib/uiPrefs'
import { cn } from '@/lib/utils'
import { openQuickRules } from '@/lib/quickRules'
import {
  IconActivity,
  IconArrowsExchange,
  IconArrowsSplit2,
  IconBolt,
  IconBooks,
  IconCheck,
  IconCloudDownload,
  IconCpu,
  IconDevices,
  IconFileDiff,
  IconGauge,
  IconSearch,
  IconSettings,
  IconStack2,
} from '@tabler/icons-react'
import { Command } from 'cmdk'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { THEME_OPTIONS, useSetTheme } from '../status/ThemeToggle'

/** Глобальные сочетания клавиш → id команды. Mod = Cmd (macOS) / Ctrl. */
const GLOBAL_HOTKEYS: { shortcut: string; command: string; allowInEditor: boolean }[] = [
  { shortcut: 'Mod+Enter', command: 'config.apply', allowInEditor: true },
  // В редакторе Mod+S обрабатывает сам CodeMirror (onSave) — здесь только вне его
  { shortcut: 'Mod+S', command: 'config.save', allowInEditor: false },
]

function isInsideOpenDialog(target: EventTarget | null) {
  if (target instanceof Element && target.closest('[role="dialog"],[role="alertdialog"]')) return true
  return !!document.querySelector('[role="dialog"][data-open],[role="alertdialog"][data-open]')
}

interface Props {
  openModal: (modal: string) => void
}

/**
 * Командная палитра (Ctrl/Cmd+K) + глобальные горячие клавиши.
 * Здесь же регистрируются «общие» команды приложения (модалки, тема); команды сервиса и
 * конфигураций регистрируют StatusBar и ConfigPanel через useCommandProvider.
 */
export function CommandPalette({ openModal }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const openRef = useRef(open)
  openRef.current = open

  useAppCommandProvider(openModal)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat && matchesShortcut(e, 'Mod+K')) return e.preventDefault()
      if (matchesShortcut(e, 'Mod+K')) {
        e.preventDefault()
        e.stopPropagation()
        setOpen((o) => !o)
        return
      }
      if (openRef.current || isInsideOpenDialog(e.target)) return
      for (const hk of GLOBAL_HOTKEYS) {
        if (!matchesShortcut(e, hk.shortcut)) continue
        const inEditor = e.target instanceof Element && !!e.target.closest('.cm-editor')
        if (inEditor && !hk.allowInEditor) return
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        const cmd = findCommand(hk.command)
        if (!cmd) return
        if (cmd.disabled) {
          if (cmd.disabledReason) showToast(cmd.disabledReason, 'error')
          return
        }
        executeCommand(hk.command)
        return
      }
    }
    const onOpenEvent = () => setOpen(true)
    // capture: перехватываем раньше CodeMirror (у него Mod+Enter = «вставить пустую строку»)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvent)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvent)
    }
  }, [])

  const run = (cmd: AppCommand) => {
    if (cmd.disabled) return
    setOpen(false)
    // Даём палитре закрыться, чтобы фокус и модалки открывались корректно
    setTimeout(() => void cmd.run(), 0)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setSearch('')
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="data-closed:zoom-out-[0.98] data-open:zoom-in-[0.98] top-[12dvh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[640px]"
      >
        <DialogTitle className="sr-only">Командная палитра</DialogTitle>
        <DialogDescription className="sr-only">Поиск команд и действий</DialogDescription>
        <Command
          loop
          className={cn(
            'flex flex-col',
            '[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
            '[&_[cmdk-group]+[cmdk-group]]:border-border [&_[cmdk-group]+[cmdk-group]]:mt-1 [&_[cmdk-group]+[cmdk-group]]:border-t [&_[cmdk-group]+[cmdk-group]]:pt-1'
          )}
        >
          <div className="border-border flex items-center gap-2.5 border-b px-4">
            <IconSearch className="text-muted-foreground size-4.5 shrink-0" />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              autoFocus
              placeholder="Введите команду или поиск..."
              className="placeholder:text-muted-foreground h-13 w-full bg-transparent text-[15px] outline-none"
            />
            <Kbd className="hidden sm:inline-flex">Esc</Kbd>
          </div>
          <Command.List className="max-h-[min(60dvh,440px)] scroll-py-2 [scrollbar-width:thin] overflow-y-auto overscroll-contain p-2">
            <Command.Empty className="text-muted-foreground py-10 text-center text-sm">Ничего не найдено</Command.Empty>
            <PaletteItems onRun={run} />
          </Command.List>
          <div className="border-border text-muted-foreground bg-muted/40 hidden items-center gap-4 border-t px-4 py-2 text-xs sm:flex">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> навигация
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd> выполнить
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <KbdShortcut shortcut="Mod+K" /> открыть / закрыть
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Список команд. Монтируется только пока палитра открыта и только тогда подписывается на состояние
 * приложения (статус сервиса, dirty-флаги конфигов), чтобы disabled/заголовки команд были актуальны.
 */
function PaletteItems({ onRun }: { onRun: (cmd: AppCommand) => void }) {
  useSyncExternalStore(subscribeCommands, getCommandsVersion)
  useAppContext({ includeConfigs: true })
  const groups = new Map<string, AppCommand[]>()
  for (const c of getCommands()) {
    if (!groups.has(c.group)) groups.set(c.group, [])
    groups.get(c.group)!.push(c)
  }

  return [...groups.entries()].map(([group, items]) => (
    <Command.Group key={group} heading={group}>
      {items.map((cmd) => {
        const Icon = cmd.icon
        return (
          <Command.Item
            key={cmd.id}
            value={cmd.id}
            keywords={[cmd.title, group, ...(cmd.keywords ?? [])]}
            disabled={cmd.disabled}
            onSelect={() => onRun(cmd)}
            className={cn(
              'text-foreground/90 flex h-10 cursor-pointer items-center gap-3 rounded-md px-2 text-sm select-none',
              'data-[selected=true]:text-foreground data-[selected=true]:bg-(--menu-active-bg)',
              'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40',
              '[&_svg]:shrink-0'
            )}
          >
            {Icon ? <Icon className="text-muted-foreground size-4" /> : <span className="size-4" />}
            <span className="min-w-0 flex-1 truncate">{cmd.title}</span>
            {cmd.shortcut && <KbdShortcut shortcut={cmd.shortcut} className="ml-auto" />}
          </Command.Item>
        )
      })}
    </Command.Group>
  ))
}

function useAppCommandProvider(openModal: (modal: string) => void) {
  const { dispatch } = useAppActions()
  const currentCore = useCurrentCore()
  const theme = useSettings((s) => s.theme)
  const setTheme = useSetTheme()
  const showDiff = useUiPrefs((s) => s.showDiffBeforeApply)
  const setShowDiff = useUiPrefs((s) => s.setShowDiffBeforeApply)

  useCommandProvider('app', () => [
    {
      id: 'app.core',
      title: 'Управление ядром / переключить ядро',
      group: 'Сервис',
      keywords: ['xray', 'mihomo', 'core', 'ядро', 'переключить'],
      icon: IconArrowsExchange,
      run: () => openModal('showCoreManageModal'),
    },
    {
      id: 'app.settings',
      title: 'Открыть настройки',
      group: 'Навигация',
      keywords: ['settings', 'настройки', 'параметры'],
      icon: IconSettings,
      run: () => openModal('showSettingsModal'),
    },
    {
      id: 'app.update',
      title: 'Обновить XKeen UI',
      group: 'Навигация',
      keywords: ['update', 'обновление', 'версия', 'релиз'],
      icon: IconCloudDownload,
      run: () => {
        dispatch({ type: 'SET_UPDATE_MODAL_CORE', core: 'self' })
        openModal('showUpdateModal')
      },
    },
    {
      id: 'app.updateCore',
      title: `Обновить ядро ${currentCore === 'mihomo' ? 'Mihomo' : 'Xray'}`,
      group: 'Навигация',
      keywords: ['update', 'обновление', 'xray', 'mihomo', 'ядро'],
      icon: IconCpu,
      run: () => {
        dispatch({ type: 'SET_UPDATE_MODAL_CORE', core: currentCore || 'xray' })
        openModal('showUpdateModal')
      },
    },
    {
      id: 'tools.quickRules',
      title: 'Маршрутизация доменов',
      group: 'Утилиты',
      keywords: ['domain', 'routing', 'rules', 'домен', 'правила', 'напрямую', 'исключение', 'direct'],
      icon: IconArrowsSplit2,
      run: () => openQuickRules(),
    },
    {
      id: 'tools.ruleCatalog',
      title: 'Каталог правил (подключить список доменов)',
      group: 'Утилиты',
      keywords: ['catalog', 'rules', 'geosite', 'geoip', 'каталог', 'рулсет', 'список', 'gemini', 'chatgpt', 'claude'],
      icon: IconBooks,
      disabled: currentCore !== 'mihomo',
      disabledReason: 'Каталог доступен только для Mihomo (в Xray списки берутся из geosite.dat)',
      run: () => openModal('showRuleCatalogModal'),
    },
    {
      id: 'tools.proxyGroups',
      title: 'Группы прокси',
      group: 'Утилиты',
      keywords: ['groups', 'balancer', 'балансировщик', 'группа', 'серверы'],
      icon: IconStack2,
      run: () => openModal('showProxyGroupsModal'),
    },
    {
      id: 'tools.devices',
      title: 'Устройства и прокси',
      group: 'Утилиты',
      keywords: ['devices', 'policy', 'устройства', 'политика', 'напрямую', 'исключить'],
      icon: IconDevices,
      run: () => openModal('showDevicesModal'),
    },
    {
      id: 'tools.perf',
      title: 'Нагрузка роутера',
      group: 'Утилиты',
      keywords: ['cpu', 'ram', 'load', 'нагрузка', 'процессор', 'монитор'],
      icon: IconActivity,
      run: () => openModal('showPerfModal'),
    },
    {
      id: 'tools.speedtest',
      title: 'Спидтест',
      group: 'Утилиты',
      keywords: ['speedtest', 'speed', 'скорость', 'тест'],
      icon: IconBolt,
      run: () => openModal('showSpeedtestModal'),
    },
    {
      id: 'tools.advisor',
      title: 'Анализ конфига xray',
      group: 'Утилиты',
      keywords: ['advisor', 'quic', 'vision', 'mux', 'анализ', 'оптимизация', 'скорость'],
      icon: IconGauge,
      disabled: currentCore === 'mihomo',
      disabledReason: 'Анализ доступен только для Xray',
      run: () => openModal('showAdvisorModal'),
    },
    ...THEME_OPTIONS.map(({ value, label, icon }) => ({
      id: `theme.${value}`,
      title: `Тема: ${label.toLowerCase()}`,
      group: 'Внешний вид',
      keywords: ['theme', 'тема', 'dark', 'light', 'тёмная', 'темная', 'светлая', 'amoled', 'auto', 'системная'],
      icon: theme === value ? IconCheck : icon,
      run: () => setTheme(value),
    })),
    {
      id: 'prefs.diff',
      title: showDiff ? 'Не показывать изменения перед применением' : 'Показывать изменения перед применением',
      group: 'Внешний вид',
      keywords: ['diff', 'дифф', 'изменения', 'сравнение'],
      icon: IconFileDiff,
      run: () => {
        setShowDiff(!showDiff)
        showToast(!showDiff ? 'Изменения будут показываться перед применением' : 'Показ изменений отключён')
      },
    },
  ])
}
