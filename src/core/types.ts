export type TradeSide = 'BUY' | 'SELL';
export type UserRole = 'ADMIN' | 'USER';

export type UserSession = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  adminSessionToken?: string;
  createdAt: string;
};

export type AppSettings = {
  currency: string;
  monthlyBudget: number;
  googleScriptUrl: string;
  livePriceRefreshSec: number;
  stockBudget: number;
  allocationLimitPct: number;
  l1DipPct: number;
  l2DipPct: number;
  brokerageBuyPct: number;
  brokerageSellPct: number;
  dpCharge: number;
  portfolioSize: number;
  fdRatePct: number;
  inflationRatePct: number;
  sellTargetPct: number;
  stopLossPct: number;
  minHoldDaysTrim: number;
};

export type Transaction = {
  id: string;
  importedAt: string;
  tradeDate: string;
  tradeDateTime?: string;
  broker: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  fees: number;
  reason?: string;
  note?: string;
};

export type AppState = {
  transactions: Transaction[];
  stockMappings: StockMapping[];
  livePrices: Record<string, LivePrice>;
  expenses: ExpenseRow[];
  debtItems: DebtRow[];
  creditItems: CreditRow[];
  lastLiveSyncAt?: string;
  settings: AppSettings;
  lastSyncedAt?: string;
};

export type StockMapping = {
  stock: string;
  ticker: string;
  enabled: boolean;
  updatedAt: string;
};

export type LivePrice = {
  ticker: string;
  price: number;
  previousClose?: number;
  changePct?: number;
  fetchedAt: string;
};

export type CsvImportResult = {
  accepted: Transaction[];
  rejected: { row: number; reason: string }[];
};

export type DashboardSnapshot = {
  invested: number;
  realized: number;
  fees: number;
  tradeCount: number;
  winRate: number;
};

export type HoldingRow = {
  stock: string;
  ticker: string;
  quantity: number;
  invested: number;
  avgCost: number;
  ltp?: number;
  marketValue?: number;
  unrealized?: number;
  unrealizedPct?: number;
};

export type ExpenseRow = {
  id: string;
  date: string;
  category: string;
  amount: number;
  paymentMode: string;
  note?: string;
};

export type DebtType = 'BORROW' | 'REPAY';

export type DebtRow = {
  id: string;
  date: string;
  person: string;
  type: DebtType;
  amount: number;
  note?: string;
  category?: string;
};

export type CreditRow = {
  id: string;
  date: string;
  category: string;
  amount: number;
  note?: string;
};
