import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useUiPrefs } from '@/lib/uiPrefs'

/** Локальная (в браузере) настройка: показывать diff перед сохранением/применением конфига. */
export function DiffPreviewField() {
  const checked = useUiPrefs((s) => s.showDiffBeforeApply)
  const setChecked = useUiPrefs((s) => s.setShowDiffBeforeApply)
  return (
    <Field orientation="horizontal" className="px-0 py-3">
      <FieldContent>
        <FieldLabel htmlFor="show-diff-before-apply">Показывать изменения перед применением</FieldLabel>
        <FieldDescription className="text-[13px]">Построчное сравнение с сохранённой версией перед «Сохранить» и «Применить»</FieldDescription>
      </FieldContent>
      <Switch id="show-diff-before-apply" checked={checked} onCheckedChange={(v) => setChecked(!!v)} />
    </Field>
  )
}
