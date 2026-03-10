import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        transactions: resolve(__dirname, 'transactions.html'),
        holdings: resolve(__dirname, 'holdings.html'),
        pnl: resolve(__dirname, 'pnl.html'),
        expenses: resolve(__dirname, 'expenses.html'),
        debt: resolve(__dirname, 'debt.html'),
        insights: resolve(__dirname, 'insights.html'),
        cloud: resolve(__dirname, 'cloud.html'),
        settings: resolve(__dirname, 'settings.html'),
        admin: resolve(__dirname, 'admin.html'),
        target: resolve(__dirname, 'target.html')
      }
    }
  }
});
