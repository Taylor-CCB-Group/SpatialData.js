import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ensureDemoWorkerChunkDecode } from './enableDemoWorkerChunkDecode';
import { ensureDemoPointsWorker } from './enableDemoPointsWorker';
import './index.css';

ensureDemoWorkerChunkDecode();
ensureDemoPointsWorker();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
