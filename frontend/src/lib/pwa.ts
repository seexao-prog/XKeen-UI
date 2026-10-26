/**
 * PWA: синхронизирует <meta name="theme-color"> с выбранной в панели темой
 * (строка состояния / заголовок окна установленного приложения).
 * Service worker намеренно не используется: панель работает только в локальной сети,
 * а SW усложнил бы кэширование и обновления встроенного в бинарник фронтенда.
 */

const THEME_COLORS = { dark: '#000000', light: '#fafafa' } as const

function syncThemeColor() {
  const color = document.documentElement.classList.contains('dark') ? THEME_COLORS.dark : THEME_COLORS.light
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    // Ручной выбор темы в панели важнее системной: снимаем media, чтобы браузер взял именно этот цвет
    meta.removeAttribute('media')
    meta.content = color
  })
}

export function initPwaThemeColor() {
  syncThemeColor()
  new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
}
