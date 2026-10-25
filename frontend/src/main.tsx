import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeLocale } from './i18n/locale'
import { I18nProvider } from './i18n/provider'

const locale = initializeLocale();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider locale={locale}><App /></I18nProvider>
  </StrictMode>,
)
