import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './lib/agent-viewer.css';

const root = createRoot(document.getElementById('root')!);
if (new URLSearchParams(window.location.search).get('visualStudio') === '1') {
  import('./visual-studio/VisualStudio.tsx').then(({ default: VisualStudio }) => root.render(<VisualStudio />));
} else {
  root.render(<App />);
}
