// Launch sniper for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Why this shape: on pump.fun a new coin's fate is mostly decided in its first
// seconds. Most launches are either bundled (many wallets piling in on the
// create slot, waiting to dump) or abandoned by their creator. The few that run
// do so immediately, so this bot only ever buys in a coin's first three slots,
// only when the opening tape looks organic, and it never lingers: every position
// is out at +15%, at -12%, after ten slots, or the moment the creator sells,
// whichever comes first. Small size, fast rotation, no second chances on the
// same coin.
//
// What the tape must show before a buy:
//   - age: decided within 3 slots of the CreateEvent;
//   - real SOL reserve between 0.3 and 30 (big enough to buy, small enough
//     that the curve is still young);
//   - the creator has not sold anything, and has bought at most 2.5 SOL
//     (a creator with a huge early stack is a dump in waiting);
//   - at most 3 distinct non-creator buyers so far (a launch bundled by many
//     wallets in its first slots is usually the creator's cluster);
//   - sellers have not yet out-sold buyers on the tape.
// A buy is min(0.10 SOL, the 1%-of-real-reserve cap) and never under 0.005 SOL,
// because the per-order tx fee would eat anything smaller.
//
// The harness speaks hello / batch / done on stdin; the vendored shim in
// vendor/makefun-bot.ts owns that wire and keeps `state` current. This file only
// decides orders. Prices are virtual-quote over virtual-token reserves (SOL per
// token). Every decision comes from slot numbers and the event tape, never the
// clock and never randomness, so the two grading runs agree byte for byte.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ---- tunables ---------------------------------------------------------------
const MAX_AGE_SLOTS = 3; // only a coin's first three slots
const STAKE_SOL = 0.1; // target buy size per coin
const MIN_BUY_SOL = 0.005; // never buy less: the tx fee would eat it
const MIN_REAL_SOL = 0.3; // real SOL reserve, lower bound at entry
const MAX_REAL_SOL = 30; // real SOL reserve, upper bound at entry
const MAX_DEV_BUY_SOL = 2.5; // creator's own buys, at most
const MAX_BUYERS = 3; // distinct non-creator buyers, at most
const TAKE_PROFIT = 1.15; // sell all once value hits 115% of cost
const STOP_LOSS = 0.88; // sell all once value falls to 88% of cost
const MAX_HOLD_SLOTS = 10; // never hold past ten slots
const MAX_SLIPPAGE_BPS = 10_000; // fills must land; price moves fast

const SOL = 1_000_000_000; // lamports per SOL, as a plain number for tape math

/** What this bot remembers about one curve, from the events it has seen. */
interface Tape {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  trades: number;
  buySol: number; // SOL spent by buyers on the tape
  sellSol: number; // SOL taken out by sellers on the tape
  buyers: Set<string>; // distinct wallets that bought (creator included)
  devBuySol: number; // SOL the creator themself bought
  devSold: boolean; // the creator sold at least once
}

/** What this bot remembers about one open position. */
interface Open {
  mint: Pubkey;
  entrySlot: number; // slot of the batch where the position first showed up
}

const tapes = new Map<Pubkey, Tape>();
const entered = new Set<Pubkey>(); // mints bought once already: one shot each
const open = new Map<Pubkey, Open>();

function priceOf(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vt = Number(curve.virtual_token_reserves);
  const vq = Number(curve.virtual_quote_reserves);
  if (vt <= 0 || vq <= 0) return 0;
  return vq / vt;
}

/** Fold this batch's events into the tapes. */
function observe(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      tapes.set(e.mint, {
        mint: e.mint,
        createdSlot: e.slot,
        creator: e.creator,
        trades: 0,
        buySol: 0,
        sellSol: 0,
        buyers: new Set<string>(),
        devBuySol: 0,
        devSold: false,
      });
    } else if (e.event === 'TradeEvent') {
      const tape = tapes.get(e.mint);
      if (tape === undefined) continue;
      tape.trades += 1;
      const sol = Number(e.sol_amount) / SOL;
      if (e.is_buy) {
        tape.buySol += sol;
        tape.buyers.add(e.user);
        if (e.user === tape.creator) tape.devBuySol += sol;
      } else {
        tape.sellSol += sol;
        if (e.user === tape.creator) tape.devSold = true;
      }
    } else if (e.event === 'CompleteEvent') {
      tapes.delete(e.mint);
      open.delete(e.mint);
    }
  }
}

/** Mints with an order of the given side still in flight. */
function pendingMints(state: BotState, side: 'buy' | 'sell'): Set<Pubkey> {
  const out = new Set<Pubkey>();
  for (const p of state.pending.values()) {
    if (p.order.side === side) out.add(p.order.mint);
  }
  return out;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    observe(batch);
    const orders: OrderInput[] = [];
    const { caps } = state.hello;
    const txFee = Number(state.txFeeLamports());
    let free = Number(state.freeCashLamports());
    let slots = caps.max_open_positions - state.committedPositionCount();
    const selling = pendingMints(state, 'sell');
    const buying = pendingMints(state, 'buy');

    // ---- exits first: free the position slots for fresh launches ------------
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(state, mint);
      if (price <= 0) continue;
      const tokens = Number(holding.token_amount);
      const valueSol = (tokens * price) / SOL;
      const costSol = Number(holding.cost_lamports) / SOL;
      if (costSol <= 0) continue;

      let rec = open.get(mint);
      if (rec === undefined) {
        // A position first seen on this batch: the hold clock starts now.
        rec = { mint, entrySlot: batch.slot };
        open.set(mint, rec);
      }
      const ratio = valueSol / costSol;
      const heldSlots = batch.slot - rec.entrySlot;
      const tape = tapes.get(mint);
      const devSoldNow = tape !== undefined && tape.devSold;
      if (
        ratio >= TAKE_PROFIT ||
        ratio <= STOP_LOSS ||
        heldSlots >= MAX_HOLD_SLOTS ||
        devSoldNow
      ) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        selling.add(mint);
        open.delete(mint);
      }
    }

    // ---- entries: launches whose opening tape looks organic -----------------
    for (const tape of tapes.values()) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const mint = tape.mint;
      if (entered.has(mint) || buying.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (batch.slot - tape.createdSlot > MAX_AGE_SLOTS) continue;
      const realSol = Number(curve.real_quote_reserves) / SOL;
      if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
      if (tape.devSold) continue;
      if (tape.devBuySol > MAX_DEV_BUY_SOL) continue;
      let nonCreatorBuyers = 0;
      for (const buyer of tape.buyers) {
        if (buyer !== tape.creator) nonCreatorBuyers += 1;
      }
      if (nonCreatorBuyers > MAX_BUYERS) continue;
      if (tape.sellSol > tape.buySol) continue;

      const cap = state.maxBuyLamports(mint);
      const capSol = Number(cap) / SOL;
      const stake = Math.min(STAKE_SOL, capSol);
      if (stake < MIN_BUY_SOL) continue;
      const stakeLamports = BigInt(Math.floor(stake * SOL));
      if (free < Number(stakeLamports) + txFee) continue;

      orders.push({
        side: 'buy',
        mint,
        quote_lamports: stakeLamports,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      entered.add(mint);
      buying.add(mint);
      free -= Number(stakeLamports) + txFee;
      slots -= 1;
    }

    return orders;
  },
});
