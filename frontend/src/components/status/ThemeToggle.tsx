import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppActions, useSettings } from '@/lib/store'
import type { ThemeMode } from '@/lib/types'
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react'

export const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof IconSun }[] = [
  { value: 'light', label: 'Светлая', icon: IconSun },
  { value: 'dark', label: 'Тёмная', icon: IconMoon },
  { value: 'auto', label: 'Системная', icon: IconDeviceDesktop },
]

/** Меняет ту же настройку темы, что и модалка «Настройки» (settings.theme → applyTheme + localStorage в App). */
export function useSetTheme() {
  const { dispatch } = useAppActions()
  return (theme: ThemeMode) => dispatch({ type: 'SET_SETTINGS', settings: { theme } })
}

export function ThemeToggle() {
  const theme = useSettings((s) => s.theme)
  const setTheme = useSetTheme()
  const current = THEME_OPTIONS.find((o) => o.value === theme) ?? THEME_OPTIONS[2]
  const Icon = current.icon

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="icon" aria-label="Тема оформления">
                  <Icon className="size-4.5" />
                </Button>
              }
            />
          }
        />
        <TooltipContent>Тема: {current.label.toLowerCase()}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Тема</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeMode)}>
            {THEME_OPTIONS.map(({ value, label, icon: OptionIcon }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                <OptionIcon /> {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
