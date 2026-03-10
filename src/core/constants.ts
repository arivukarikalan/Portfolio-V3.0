import type { AppSettings } from './types';

export const APP_NAME = 'Finance Decision System';
export const SESSION_KEY = 'fds_session';
export const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzQrRH_salSv5B1dQExYZbOJfKU9denSIcJ8Edk44UOXRMVHIAkw2E-NKr1vxXbFDdI/exec';
export const SPREADSHEET_ID = '1pbSOF0A-RBkO86RM3sSEWx3rIdnljP1AyjJZ1ImW9Eo';
export const DEFAULT_SETTINGS: AppSettings = {
  currency: 'INR',
  monthlyBudget: 50000,
  googleScriptUrl: APPS_SCRIPT_URL,
  livePriceRefreshSec: 300,
  stockBudget: 6000,
  allocationLimitPct: 12,
  l1DipPct: 13,
  l2DipPct: 18,
  brokerageBuyPct: 0.15,
  brokerageSellPct: 0.15,
  dpCharge: 50,
  portfolioSize: 100000,
  fdRatePct: 6.5,
  inflationRatePct: 6.0,
  sellTargetPct: 15,
  stopLossPct: 8,
  minHoldDaysTrim: 20
};
