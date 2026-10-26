import { createRoot } from 'react-dom/client'

import App from './App.tsx'
import './globals.css'
import './lib/outboundParser.js'
import { initVisibilityReload } from './lib/visibilityReload'
import { initPwaThemeColor } from './lib/pwa'

initVisibilityReload()
initPwaThemeColor()

createRoot(document.getElementById('root')!).render(<App />)
