import React from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
// One cascade, in this order (later files may restyle earlier ones): see the header of each file.
import './styles/1-base.css';
import './styles/2-components.css';
import './styles/3-layout.css';
import './styles/4-themes.css';
import './styles/5-features.css';
import App from './App';
import { applyAppearance } from './theme';
import { installGlobalErrorLogging } from './log';

if (window.studyApp?.titlebar) document.documentElement.classList.add('own-titlebar');
installGlobalErrorLogging();
applyAppearance();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
