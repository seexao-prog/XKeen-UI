import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { KbdShortcut } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { matchesShortcut } from '@/lib/commands'
import { diffLines, foldUnchanged, type DiffLine } from '@/lib/lineDiff'
import { useUiPrefs } from '@/lib/uiPrefs'
import { cn } from '@/lib/utils'
import { IconDeviceFloppy, IconFoldDown, IconRefresh } from '@tabler/icons-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

export interface DiffRequest {
  file: string
  before: string
  after: string
  mode: 'save' | 'apply'
  onConfirm: () => void
}

/**
 * Показ diff перед сохранением/применением конфига.
 * `request()` возвращает `true`, если диалог открыт (вызывающий код должен прерваться и дождаться
 * подтверждения), и `false`, если показывать нечего или показ отключён — тогда можно продолжать сразу.
 */
export function useDiffConfirm(): { request: (req: DiffRequest) => boolean; dialog: ReactNode } {
  const [req, setReq] = useState<DiffRequest | null>(null)
  const [open, setOpen] = useState(false)

  const request = useCallback((r: DiffRequest) => {
    if (!useUiPrefs.getState().showDiffBeforeApply) return false
    if (r.before === r.after) return false
    setReq(r)
    setOpen(true)
    return true
  }, [])

  const dialog = req ? (
    <ConfigDiffDialog
      key={`${req.file}:${req.mode}`}
      open={open}
      request={req}
      onOpenChange={setOpen}
      onConfirm={() => {
        setOpen(false)
        req.onConfirm()
      }}
    />
  ) : null

  return { request, dialog }
}

function ConfigDiffDialog({
  open,
  request,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  request: DiffRequest
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const showDiff = useUiPrefs((s) => s.showDiffBeforeApply)
  const setShowDiff = useUiPrefs((s) => s.setShowDiffBeforeApply)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  const diff = useMemo(() => diffLines(request.before, request.after), [request.before, request.after])
  const rows = useMemo(() => foldUnchanged(diff.lines), [diff.lines])
  const fileName = request.file.split('/').pop() || request.file
  const isApply = request.mode === 'apply'

  return (
    <Dialog open={open} onOpenChange={(o) => onOpenChange(o)}>
      <DialogContent
        className="flex max-h-[min(88dvh,900px)] flex-col gap-4 p-0 sm:max-w-5xl"
        onKeyDown={(e) => {
          if (matchesShortcut(e.nativeEvent, 'Mod+Enter')) {
            e.preventDefault()
            onConfirm()
          }
        }}
      >
        <DialogHeader className="border-border gap-1.5 border-b px-5 pt-5 pb-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-10 text-lg">
            Изменения в <span className="font-mono text-base font-medium">{fileName}</span>
            <span className="flex items-center gap-1.5 font-mono text-xs font-medium">
              <span className="text-green-600 dark:text-green-400">+{diff.added}</span>
              <span className="text-red-600 dark:text-red-400">−{diff.removed}</span>
            </span>
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            {isApply
              ? 'Проверьте изменения: файл будет сохранён, а конфигурация применена.'
              : 'Проверьте изменения перед сохранением файла на роутере.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto px-5">
          <div className="border-border bg-background overflow-hidden rounded-lg border font-mono text-[12.5px] leading-5">
            {rows.length === 0 ? (
              <div className="text-muted-foreground p-4 text-center font-sans text-sm">Файл пустой</div>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {rows.map((row, idx) =>
                    row.type === 'fold' ? (
                      expanded.has(row.id) ? (
                        row.lines.map((line, j) => <DiffRowView key={`${idx}-${j}`} line={line} />)
                      ) : (
                        <tr key={`fold-${row.id}`}>
                          <td colSpan={4} className="border-border bg-muted/50 border-y p-0">
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground hover:bg-muted flex w-full cursor-pointer items-center gap-2 px-3 py-1 font-sans text-xs transition-colors"
                              onClick={() => setExpanded((prev) => new Set(prev).add(row.id))}
                            >
                              <IconFoldDown className="size-3.5" />
                              {row.lines.length} {pluralLines(row.lines.length)} без изменений
                            </button>
                          </td>
                        </tr>
                      )
                    ) : (
                      <DiffRowView key={idx} line={row} />
                    )
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="border-border flex flex-col-reverse gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-[13px] select-none">
            <Switch size="sm" checked={showDiff} onCheckedChange={(v) => setShowDiff(!!v)} />
            Показывать изменения перед применением
          </label>
          <div className="flex gap-2 sm:justify-end">
            <Button variant="outline" className="flex-1 sm:flex-none" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button className="flex-1 sm:flex-none" onClick={onConfirm} autoFocus>
              {isApply ? <IconRefresh data-icon="inline-start" /> : <IconDeviceFloppy data-icon="inline-start" />}
              {isApply ? 'Применить' : 'Сохранить'}
              <KbdShortcut
                shortcut="Mod+Enter"
                className="ml-1 hidden sm:inline-flex [&_kbd]:border-primary-foreground/20 [&_kbd]:bg-primary-foreground/10 [&_kbd]:text-primary-foreground/80"
              />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DiffRowView({ line }: { line: DiffLine }) {
  const oldNo = line.type === 'add' ? '' : line.oldNo
  const newNo = line.type === 'del' ? '' : line.newNo
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''
  return (
    <tr
      className={cn(
        line.type === 'add' && 'bg-green-500/10 dark:bg-green-500/12',
        line.type === 'del' && 'bg-red-500/10 dark:bg-red-500/12'
      )}
    >
      <td className="text-muted-foreground/60 w-px border-r border-transparent px-2 text-right align-top whitespace-nowrap select-none">
        {oldNo}
      </td>
      <td className="text-muted-foreground/60 border-border w-px border-r px-2 text-right align-top whitespace-nowrap select-none">
        {newNo}
      </td>
      <td
        className={cn(
          'w-px pl-2 align-top select-none',
          line.type === 'add' && 'text-green-600 dark:text-green-400',
          line.type === 'del' && 'text-red-600 dark:text-red-400'
        )}
      >
        {sign}
      </td>
      <td
        className={cn(
          'pr-3 pl-1 break-all whitespace-pre-wrap',
          line.type === 'add' && 'text-green-800 dark:text-green-300',
          line.type === 'del' && 'text-red-800 dark:text-red-300'
        )}
      >
        {line.text || '\u00a0'}
      </td>
    </tr>
  )
}

function pluralLines(n: number) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'строка'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'строки'
  return 'строк'
}
