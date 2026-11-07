import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import './app/scaffold.css';
import { THEME_VARIABLES } from './styles/tokens';
Object.entries(THEME_VARIABLES).forEach(([key, value]) =>
  document.documentElement.style.setProperty(key, value),
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
