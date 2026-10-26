import { useCommandProvider, type AppCommand } from '@/lib/commands'
import type { Config } from '@/lib/types'
import {
  IconBoltFilled,
  IconBox,
  IconCode,
  IconDeviceFloppy,
  IconFileText,
  IconFileUpload,
  IconLink,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconFileCode,
} from '@tabler/icons-react'

interface Params {
  configs: Config[]
  activeIndex: number
  isMihomoCore: boolean
  canSave: boolean
  canApply: boolean
  canFormat: boolean
  isRunning: boolean
  isPending: boolean
  save: () => void
  apply: () => void
  format: () => void
  switchToFile: (index: number) => void
  quickBackup: () => void
  onOpenImport: () => void
  onOpenImportAmnezia: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  onOpenRouteTest: () => void
  onOpenBackups: () => void
}

/** Команды палитры для редактора конфигураций. Действия — те же функции, что у кнопок ConfigPanel. */
export function useConfigCommands(p: Params) {
  useCommandProvider('config', () => {
    const active = p.configs[p.activeIndex]
    const dirty = !!active?.isDirty
    const saveReason = !dirty ? 'Нет несохранённых изменений' : 'Файл содержит ошибки'
    const applyReason = !dirty ? 'Нет несохранённых изменений' : !p.isRunning ? 'Сервис не запущен' : p.isPending ? 'Дождитесь завершения операции' : 'Файл содержит ошибки'

    const commands: AppCommand[] = [
      {
        id: 'config.apply',
        title: 'Сохранить и применить',
        group: 'Конфигурация',
        keywords: ['apply', 'применить', 'перезапустить', 'save'],
        shortcut: 'Mod+Enter',
        icon: IconRefresh,
        disabled: !p.canApply,
        disabledReason: applyReason,
        run: p.apply,
      },
      {
        id: 'config.save',
        title: 'Сохранить файл',
        group: 'Конфигурация',
        keywords: ['save', 'сохранить'],
        shortcut: 'Mod+S',
        icon: IconDeviceFloppy,
        disabled: !p.canSave,
        disabledReason: saveReason,
        run: p.save,
      },
      {
        id: 'config.format',
        title: 'Форматировать файл',
        group: 'Конфигурация',
        keywords: ['format', 'prettier', 'форматировать'],
        shortcut: 'Shift+Alt+F',
        icon: IconCode,
        disabled: !p.canFormat,
        run: p.format,
      },
      ...p.configs.map((cfg, index): AppCommand => {
        const name = cfg.file.split('/').pop() || cfg.file
        return {
          id: `config.open:${cfg.file}`,
          title: `${name}${cfg.isDirty ? ' •' : ''}`,
          group: 'Файлы',
          keywords: ['файл', 'открыть', 'вкладка', cfg.file],
          icon: IconFileCode,
          disabled: index === p.activeIndex && !p.isMihomoCore,
          run: () => p.switchToFile(index),
        }
      }),
      {
        id: 'util.import',
        title: 'Добавить подключение',
        group: 'Утилиты',
        keywords: ['import', 'импорт', 'vless', 'ссылка', 'подписка', 'outbound', 'proxy'],
        icon: IconLink,
        run: p.onOpenImport,
      },
    ]
    if (p.isMihomoCore) {
      commands.push({
        id: 'util.amnezia',
        title: 'Импорт AmneziaWG',
        group: 'Утилиты',
        keywords: ['amnezia', 'awg', 'wireguard', 'импорт'],
        icon: IconFileUpload,
        run: p.onOpenImportAmnezia,
      })
    }
    commands.push(
      {
        id: 'util.templates',
        title: 'Шаблоны конфигураций',
        group: 'Утилиты',
        keywords: ['template', 'шаблон'],
        icon: IconFileText,
        run: p.onOpenTemplate,
      },
      {
        id: 'util.backups',
        title: 'Бэкапы конфигураций',
        group: 'Утилиты',
        keywords: ['backup', 'бэкап', 'резервная копия', 'восстановить'],
        icon: IconBox,
        run: p.onOpenBackups,
      },
      {
        id: 'util.quickBackup',
        title: 'Быстрый бэкап',
        group: 'Утилиты',
        keywords: ['backup', 'бэкап', 'быстрый'],
        icon: IconBoltFilled,
        run: p.quickBackup,
      },
      {
        id: 'util.geoscan',
        title: 'Скан геофайлов',
        group: 'Утилиты',
        keywords: ['geo', 'geosite', 'geoip', 'гео', 'скан'],
        icon: IconSearch,
        run: p.onOpenGeoScan,
      },
      {
        id: 'util.routeTest',
        title: 'Проверка маршрута',
        group: 'Утилиты',
        keywords: ['route', 'маршрут', 'тест', 'routing'],
        icon: IconRoute,
        run: p.onOpenRouteTest,
      }
    )
    return commands
  })
}
