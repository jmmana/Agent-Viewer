import React from 'react';
import { createRoot } from 'react-dom/client';
// The library's own stylesheet; a real app installs the published package and imports
// `@warlockcode/agent-viewer/style.css` instead.
import '../../src/lib/agent-viewer.css';
import { HostOffice } from './HostOffice';

const container = document.getElementById('root');
if (container === null) throw new Error('library-host example: missing #root element');

createRoot(container).render(
  <React.StrictMode>
    <HostOffice />
  </React.StrictMode>,
);
