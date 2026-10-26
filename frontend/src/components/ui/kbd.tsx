import * as React from 'react'

import { shortcutKeys, type Shortcut } from '@/lib/commands'
import { cn } from '@/lib/utils'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'border-border bg-muted text-muted-foreground pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border px-1 font-sans text-[11px] leading-none font-medium select-none',
        'in-data-[slot=tooltip-content]:border-background/20 in-data-[slot=tooltip-content]:bg-background/10 in-data-[slot=tooltip-content]:text-background/80',
        className
      )}
      {...props}
    />
  )
}

/** Сочетание клавиш в виде набора <Kbd>: `Mod+Enter` → [Ctrl] [Enter] / [⌘] [↵]. */
function KbdShortcut({ shortcut, className }: { shortcut: Shortcut; className?: string }) {
  return (
    <span data-slot="kbd-group" className={cn('inline-flex items-center gap-0.5', className)}>
      {shortcutKeys(shortcut).map((key, i) => (
        <Kbd key={i}>{key}</Kbd>
      ))}
    </span>
  )
}

export { Kbd, KbdShortcut }
