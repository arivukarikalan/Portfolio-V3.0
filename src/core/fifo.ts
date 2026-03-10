export type DatedLot = {
  qty: number;
  date: string;
};

export type ConsumedChunk<TLot extends DatedLot> = {
  lot: TLot;
  qty: number;
};

export function consumeSellWithSameDayPriority<TLot extends DatedLot>(
  lots: TLot[],
  sellQtyInput: number,
  sellDate: string
): { consumed: ConsumedChunk<TLot>[]; remainingSellQty: number } {
  let sellQty = Math.max(0, Number(sellQtyInput || 0));
  const consumed: ConsumedChunk<TLot>[] = [];
  const dateKey = String(sellDate || '').slice(0, 10);

  for (let i = lots.length - 1; i >= 0 && sellQty > 0; i -= 1) {
    const lot = lots[i];
    if (String(lot.date || '').slice(0, 10) !== dateKey) continue;
    const used = Math.min(Number(lot.qty || 0), sellQty);
    if (used <= 0) continue;
    lot.qty -= used;
    sellQty -= used;
    consumed.push({ lot, qty: used });
    if (lot.qty <= 0) lots.splice(i, 1);
  }

  while (sellQty > 0 && lots.length > 0) {
    const lot = lots[0];
    const used = Math.min(Number(lot.qty || 0), sellQty);
    if (used <= 0) {
      lots.shift();
      continue;
    }
    lot.qty -= used;
    sellQty -= used;
    consumed.push({ lot, qty: used });
    if (lot.qty <= 0) lots.shift();
  }

  return { consumed, remainingSellQty: sellQty };
}

