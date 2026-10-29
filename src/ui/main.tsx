import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './onboarding/styles.css';
import './onboarding/ai/ai-generator.css';
import './onboarding/template-editor.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
