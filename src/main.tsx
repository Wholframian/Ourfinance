import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { clearChunkReloadFlag } from './components/ErrorBoundary'

registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Si la app lleva un rato funcionando bien, se permite otra recarga automática en la próxima versión
setTimeout(clearChunkReloadFlag, 10_000)
