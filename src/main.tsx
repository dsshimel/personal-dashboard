/**
 * @fileoverview React application entry point.
 *
 * Mounts the App component to the DOM root element with StrictMode enabled
 * for development warnings and checks.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
