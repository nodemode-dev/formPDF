import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/scrollbars.css';
import '../../frontend/src/styles/shell.css';
import '../../frontend/src/styles/dialogs.css';
import '../../frontend/src/styles/pdf.css';
import './fonts.css';
import './demo.css';
import { start } from './app';

start(document.getElementById('app') as HTMLElement);
document.body.classList.add('app-ready');
