import './style.css';
import { bootstrapApp, type AppView } from './app/App';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('#app root node not found');
}

const page = String(document.body.dataset.page || '').trim().toLowerCase();
const allowed: AppView[] = [
  'dashboard',
  'transactions',
  'holdings',
  'pnl',
  'expenses',
  'debt',
  'insights',
  'target',
  'cloud',
  'settings',
  'admin'
];
const forcedView = (allowed.includes(page as AppView) ? (page as AppView) : 'dashboard');

bootstrapApp(root, forcedView);
