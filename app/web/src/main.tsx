import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

/**
 * Entry point of the page: mounts the application into the one element of `index.html`. A missing element is a defect
 * of the build, so it stops here with a message instead of rendering nothing.
 */
const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html has no #root element');
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
