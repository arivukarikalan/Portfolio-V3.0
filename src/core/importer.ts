import * as XLSX from 'xlsx';
import { parseCsvText } from './csv';
import type { CsvImportResult, TradeSide, Transaction } from './types';

type ParsedTable = { headers: string[]; body: string[][] };

function normalizeHeader(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function indexOf(headers: string[], options: string[]): number {
  const normalized = headers.map(normalizeHeader);
  const wanted = options.map(normalizeHeader);
  return normalized.findIndex((header) => wanted.includes(header));
}

function parseSide(value: string): TradeSide | null {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BUY' || normalized === 'B') return 'BUY';
  if (normalized === 'SELL' || normalized === 'S') return 'SELL';
  return null;
}

function toNumber(value: string): number {
  const clean = String(value || '')
    .trim()
    .replace(/,/g, '')
    .replace(/\s+/g, '');
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toDate(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';

  if (/^\d+(\.\d+)?$/.test(text)) {
    const excelSerial = Number(text);
    if (Number.isFinite(excelSerial) && excelSerial > 20000 && excelSerial < 90000) {
      const ms = Math.round((excelSerial - 25569) * 86400 * 1000);
      const dt = new Date(ms);
      if (!Number.isNaN(dt.getTime())) {
        const y = dt.getFullYear();
        const m = dt.getMonth() + 1;
        const d = dt.getDate();
        return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
  }

  const ymd = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3]);
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const dt = new Date(text);
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toDateTime(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toISOString();
}

function normalizeSymbol(value: string): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function detectFlatTrade(headers: string[]): boolean {
  const has = (options: string[]) => indexOf(headers, options) >= 0;
  return has(['scrip', 'stock', 'security']) && has(['date', 'trade_date']) && has(['bqty', 'buy_qty']) && has(['sqty', 'sell_qty']);
}

function parseFlatTradeStock(value: string): string {
  const base = String(value || '').trim().replace(/^\d+\s+/, '');
  if (!base) return '';
  return normalizeSymbol(base);
}

function parseFlatTradeRows(parsed: ParsedTable, broker: string): CsvImportResult {
  const accepted: Transaction[] = [];
  const rejected: { row: number; reason: string }[] = [];

  const dateIdx = indexOf(parsed.headers, ['date', 'trade_date']);
  const stockIdx = indexOf(parsed.headers, ['scrip', 'stock', 'security', 'company']);
  const bQtyIdx = indexOf(parsed.headers, ['bqty', 'b_qty', 'buy_qty']);
  const bRateIdx = indexOf(parsed.headers, ['bnrate', 'b_n_rate', 'buy_rate', 'buy_price']);
  const sQtyIdx = indexOf(parsed.headers, ['sqty', 's_qty', 'sell_qty']);
  const sRateIdx = indexOf(parsed.headers, ['snrate', 's_n_rate', 'sell_rate', 'sell_price']);

  parsed.body.forEach((row, index) => {
    const line = index + 2;
    const tradeDate = toDate(row[dateIdx]);
    const symbol = parseFlatTradeStock(row[stockIdx]);

    if (!tradeDate || !symbol) {
      rejected.push({ row: line, reason: 'Invalid date or symbol' });
      return;
    }

    const bQty = toNumber(row[bQtyIdx]);
    const bRate = toNumber(row[bRateIdx]);
    const sQty = toNumber(row[sQtyIdx]);
    const sRate = toNumber(row[sRateIdx]);

    if (Number.isFinite(bQty) && bQty > 0 && Number.isFinite(bRate) && bRate > 0) {
      accepted.push({
        id: crypto.randomUUID(),
        importedAt: new Date().toISOString(),
        tradeDate,
        broker,
        symbol,
        side: 'BUY',
        quantity: bQty,
        price: bRate,
        fees: 0,
        reason: 'Broker Import'
      });
    }

    if (Number.isFinite(sQty) && sQty > 0 && Number.isFinite(sRate) && sRate > 0) {
      accepted.push({
        id: crypto.randomUUID(),
        importedAt: new Date().toISOString(),
        tradeDate,
        broker,
        symbol,
        side: 'SELL',
        quantity: sQty,
        price: sRate,
        fees: 0,
        reason: 'Broker Import'
      });
    }

    if (!(Number.isFinite(bQty) && bQty > 0) && !(Number.isFinite(sQty) && sQty > 0)) {
      rejected.push({ row: line, reason: 'No valid buy/sell quantity found' });
    }
  });

  return { accepted, rejected };
}

function parseGenericRows(parsed: ParsedTable, broker: string): CsvImportResult {
  const accepted: Transaction[] = [];
  const rejected: { row: number; reason: string }[] = [];

  const dateIndex = indexOf(parsed.headers, ['date', 'trade_date', 'trade_date_time', 'timestamp', 'order_execution_time']);
  const dateTimeIndex = indexOf(parsed.headers, ['trade_date_time', 'timestamp', 'order_execution_time', 'time']);
  const symbolIndex = indexOf(parsed.headers, ['symbol', 'ticker', 'security', 'stock', 'scrip', 'company']);
  const sideIndex = indexOf(parsed.headers, ['side', 'type', 'action', 'trade_type']);
  const quantityIndex = indexOf(parsed.headers, ['quantity', 'qty', 'units', 'filled_quantity']);
  const priceIndex = indexOf(parsed.headers, ['price', 'avg_price', 'trade_price', 'execution_price', 'average_price']);
  const feeIndex = indexOf(parsed.headers, ['fees', 'fee', 'charges', 'brokerage', 'total_charges']);
  const orderIdIndex = indexOf(parsed.headers, ['order_id', 'orderid', 'exchange_order_id', 'order_number', 'order_no']);
  const tradeIdIndex = indexOf(parsed.headers, ['trade_id', 'tradeid', 'fill_id', 'execution_id']);

  if ([dateIndex, symbolIndex, sideIndex, quantityIndex, priceIndex].some((v) => v < 0)) {
    return {
      accepted,
      rejected: [
        {
          row: 1,
          reason: 'Unsupported header format. Needed: date, symbol, side, quantity, price'
        }
      ]
    };
  }

  type FillRow = {
    tradeDate: string;
    tradeDateTime?: string;
    symbol: string;
    side: TradeSide;
    quantity: number;
    price: number;
    fees: number;
    orderId: string;
    tradeId: string;
  };

  const fills: FillRow[] = [];

  parsed.body.forEach((row, index) => {
    const line = index + 2;
    const side = parseSide(row[sideIndex] ?? '');
    const quantity = toNumber(row[quantityIndex]);
    const price = toNumber(row[priceIndex]);
    const fees = feeIndex >= 0 ? toNumber(row[feeIndex] || '0') : 0;
    const tradeDate = toDate(row[dateIndex]);
    const tradeDateTime = dateTimeIndex >= 0 ? toDateTime(row[dateTimeIndex]) : toDateTime(row[dateIndex]);
    const symbol = normalizeSymbol(row[symbolIndex]);
    const orderId = orderIdIndex >= 0 ? String(row[orderIdIndex] || '').trim() : '';
    const tradeId = tradeIdIndex >= 0 ? String(row[tradeIdIndex] || '').trim() : '';

    if (!side) {
      rejected.push({ row: line, reason: 'Invalid side value' });
      return;
    }
    if (!tradeDate) {
      rejected.push({ row: line, reason: 'Invalid trade date' });
      return;
    }
    if (!symbol) {
      rejected.push({ row: line, reason: 'Invalid symbol' });
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      rejected.push({ row: line, reason: 'Invalid quantity' });
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      rejected.push({ row: line, reason: 'Invalid price' });
      return;
    }

    fills.push({
      tradeDate,
      tradeDateTime: tradeDateTime || undefined,
      symbol,
      side,
      quantity,
      price,
      fees: Number.isFinite(fees) && fees >= 0 ? fees : 0,
      orderId,
      tradeId
    });
  });

  type Group = {
    tradeDate: string;
    tradeDateTime?: string;
    symbol: string;
    side: TradeSide;
    qty: number;
    value: number;
    fees: number;
    orderId: string;
  };

  const groups = new Map<string, Group>();
  for (const fill of fills) {
    const minuteBucket = fill.tradeDateTime ? fill.tradeDateTime.slice(0, 16) : '';
    const key = fill.orderId
      ? `o|${fill.tradeDate}|${fill.symbol}|${fill.side}|${fill.orderId}`
      : fill.tradeId
        ? `t|${fill.tradeDate}|${fill.symbol}|${fill.side}|${fill.tradeId}`
        : minuteBucket
          ? `d|${fill.tradeDate}|${fill.symbol}|${fill.side}|${minuteBucket}`
          : `r|${fill.tradeDate}|${fill.symbol}|${fill.side}|${fill.price.toFixed(6)}`;

    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        tradeDate: fill.tradeDate,
        tradeDateTime: fill.tradeDateTime,
        symbol: fill.symbol,
        side: fill.side,
        qty: fill.quantity,
        value: fill.price * fill.quantity,
        fees: fill.fees,
        orderId: fill.orderId
      });
      continue;
    }

    current.qty += fill.quantity;
    current.value += fill.price * fill.quantity;
    current.fees += fill.fees;
    if (!current.tradeDateTime && fill.tradeDateTime) current.tradeDateTime = fill.tradeDateTime;
  }

  groups.forEach((group) => {
    if (!Number.isFinite(group.qty) || group.qty <= 0) return;
    accepted.push({
      id: crypto.randomUUID(),
      importedAt: new Date().toISOString(),
      tradeDate: group.tradeDate,
      tradeDateTime: group.tradeDateTime || undefined,
      broker,
      symbol: group.symbol,
      side: group.side,
      quantity: group.qty,
      price: group.value / group.qty,
      fees: Number.isFinite(group.fees) && group.fees >= 0 ? group.fees : 0,
      reason: 'Broker Import',
      note: group.orderId ? `Order ${group.orderId}` : undefined
    });
  });

  return { accepted, rejected };
}

function parseTable(parsed: ParsedTable, broker: string): CsvImportResult {
  if (parsed.headers.length === 0) {
    return { accepted: [], rejected: [{ row: 1, reason: 'File has no headers' }] };
  }
  if (detectFlatTrade(parsed.headers)) return parseFlatTradeRows(parsed, broker);
  return parseGenericRows(parsed, broker);
}

function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const normalized = rows[i].map(normalizeHeader).filter(Boolean);
    if (!normalized.length) continue;

    const looksLikeFlatTrade =
      normalized.includes('scrip') && normalized.includes('date') && (normalized.includes('b_qty') || normalized.includes('bqty'));

    const looksLikeGeneric =
      normalized.includes('symbol') && normalized.includes('trade_type') && normalized.includes('quantity') && normalized.includes('price');

    if (looksLikeFlatTrade || looksLikeGeneric) return i;
  }
  return -1;
}

function parseExcelRows(rows: string[][]): ParsedTable {
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) return { headers: [], body: [] };
  const headers = rows[headerIndex].map((v) => String(v || '').trim());
  const body = rows
    .slice(headerIndex + 1)
    .filter((row) => row.some((cell) => String(cell || '').trim() !== ''))
    .map((row) => row.map((cell) => String(cell ?? '').trim()));
  return { headers, body };
}

export function importBrokerageCsv(content: string, broker: string): CsvImportResult {
  return parseTable(parseCsvText(content), broker);
}

export async function importBrokerageFile(file: File, broker: string): Promise<CsvImportResult> {
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    return importBrokerageCsv(await file.text(), broker);
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, { type: 'array' });

    let best: CsvImportResult | null = null;
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
      const parsed = parseExcelRows(rows.map((r) => r.map((c) => String(c ?? ''))));
      const result = parseTable(parsed, broker);
      if (!best || result.accepted.length > best.accepted.length) {
        best = result;
      }
    }

    if (!best) return { accepted: [], rejected: [{ row: 1, reason: 'No readable data in workbook' }] };
    return best;
  }

  return { accepted: [], rejected: [{ row: 1, reason: 'Unsupported file type. Use CSV, TXT, XLSX, or XLS.' }] };
}
