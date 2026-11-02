import React from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import './styles-v2.css';
import './styles-v3.css';
import './styles-v4.css';
import './styles-v5.css';
import App from './App';
import { applyAppearance } from './theme';

if (window.studyApp?.titlebar) document.documentElement.classList.add('own-titlebar');
applyAppearance();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
