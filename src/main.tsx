import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './desktop.css';

// The desktop app has its own look: neutral editor greys with the logo's cyan and pink.
if ((globalThis as { rfDesktop?: unknown }).rfDesktop) document.documentElement.classList.add('desktop');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
