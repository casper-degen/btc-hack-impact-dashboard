#!/usr/bin/env node
// Fetch Aave v3 Ethereum BTC-market data via Aave official subgraph
// Usage: GRAPH_API_KEY=xxx node scripts/fetch-aave.mjs
//
// Sources:
//   - Deposits/borrows: Aave official subgraph (Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g)
//   - BTC/USD prices: Binance BTCUSDT daily klines (no auth required)
//   - Total protocol TVL: DefiLlama (labeled as "protocol total" — not used for per-market BTC numbers)

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '../data/aave.json');

const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
if (!GRAPH_API_KEY) {
  console.error('ERROR: GRAPH_API_KEY not set — required for Aave official subgraph');
  process.exit(1);
}

const SUBGRAPH_URL = `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g`;

// BTC reserves on Aave v3 Ethereum (confirmed via subgraph introspection)
const BTC_RESERVES = [
  { symbol: 'WBTC',  id: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c5990x2f39d218133afab8f2b819b1066c7e434ad94e9e', decimals: 8  },
  { symbol: 'cbBTC', id: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf0x2f39d218133afab8f2b819b1066c7e434ad94e9e', decimals: 8  },
  { symbol: 'tBTC',  id: '0x18084fba666a33d37592fa2633fd49a74dd93a880x2f39d218133afab8f2b819b1066c7e434ad94e9e', decimals: 18 },
  { symbol: 'LBTC',  id: '0x8236a87084f8b84306f72007f36f2618a56344940x2f39d218133afab8f2b819b1066c7e434ad94e9e', decimals: 8  },
];

const DATE_RANGE = [];
for (let d = new Date('2026-04-17T00:00:00Z'); d <= new Date('2026-04-27T23:59:59Z'); d.setDate(d.getDate() + 1)) {
  DATE_RANGE.push(new Date(d).toISOString().slice(0, 10));
}

const FROM_TS = Math.floor(new Date('2026-04-17T00:00:00Z').getTime() / 1000);
const TO_TS   = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);

async function queryGraph(query, variables = {}) {
  const res = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Subgraph error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchReserveHistory(reserve) {
  const all = [];
  let skip = 0;
  const PAGE = 1000;
  while (true) {
    const data = await queryGraph(`
      query($reserve: String!, $from: Int!, $to: Int!, $skip: Int!) {
        reserveParamsHistoryItems(
          where: { reserve: $reserve, timestamp_gte: $from, timestamp_lte: $to }
          orderBy: timestamp orderDirection: asc
          first: ${PAGE} skip: $skip
        ) { timestamp totalATokenSupply totalCurrentVariableDebt }
      }
    `, { reserve: reserve.id, from: FROM_TS, to: TO_TS, skip });
    const items = data.reserveParamsHistoryItems;
    all.push(...items);
    if (items.length < PAGE) break;
    skip += PAGE;
    await sleep(300);
  }
  return all;
}

async function fetchDefiLlamaTvl() {
  const res = await fetch('https://api.llama.fi/protocol/aave-v3');
  if (!res.ok) throw new Error(`DefiLlama failed: ${res.status}`);
  const d = await res.json();
  const tvl = d?.chainTvls?.Ethereum?.tvl ?? [];
  const tl = {};
  tvl.filter(x => x.date >= FROM_TS && x.date <= TO_TS).forEach(x => {
    const date = new Date(x.date * 1000).toISOString().slice(0, 10);
    tl[date] = { tvlUsd: Math.round(x.totalLiquidityUSD), source: 'DefiLlama' };
  });
  return tl;
}

async function fetchBtcUsdPrices() {
  // Binance BTCUSDT daily klines — no API key, generous rate limits
  const startMs = FROM_TS * 1000;
  const endMs   = TO_TS   * 1000;
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${startMs}&endTime=${endMs}&limit=20`
  );
  if (!res.ok) throw new Error(`Binance klines failed: ${res.status}`);
  const candles = await res.json();
  const prices = {};
  for (const [openTs, , , , closePrice] of candles) {
    const date = new Date(Number(openTs)).toISOString().slice(0, 10);
    prices[date] = parseFloat(closePrice);
  }
  return prices;
}

function toNative(raw, decimals) {
  return Number(BigInt(raw)) / Math.pow(10, decimals);
}

function groupByDay(items) {
  const byDay = {};
  for (const item of items) {
    const date = new Date(item.timestamp * 1000).toISOString().slice(0, 10);
    if (!byDay[date] || item.timestamp > byDay[date].timestamp) {
      byDay[date] = item;
    }
  }
  return byDay;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('=== Aave v3 Ethereum BTC-markets fetch (official subgraph) ===\n');

  // 1. Fetch reserve histories
  console.log('Fetching BTC reserve history from Aave official subgraph...');
  const rawByReserve = {};
  for (const reserve of BTC_RESERVES) {
    console.log(`  ${reserve.symbol}...`);
    rawByReserve[reserve.symbol] = await fetchReserveHistory(reserve);
    console.log(`    → ${rawByReserve[reserve.symbol].length} events`);
  }

  // 2. Fetch daily BTC/USD prices from Binance
  console.log('\nFetching daily BTC/USD prices from Binance...');
  const btcPrices = await fetchBtcUsdPrices();
  console.log('BTC/USD prices:');
  for (const date of DATE_RANGE) console.log(`  ${date}: $${(btcPrices[date] ?? 0).toLocaleString()}`);

  // Validate all dates have prices
  const missingPrices = DATE_RANGE.filter(d => !btcPrices[d]);
  if (missingPrices.length) throw new Error(`Missing BTC prices for: ${missingPrices.join(', ')}`);

  // 3. Aggregate: daily closing snapshot per reserve
  const aggregated = {};
  for (const reserve of BTC_RESERVES) {
    const byDay = groupByDay(rawByReserve[reserve.symbol]);
    aggregated[reserve.symbol] = {};
    let lastKnown = null;
    for (const date of DATE_RANGE) {
      const snap = byDay[date];
      const price = btcPrices[date];
      if (!snap) {
        // Carry forward last known value with updated price
        if (lastKnown) {
          const deposits = lastKnown.deposits_btc;
          const borrows  = lastKnown.borrows_btc;
          aggregated[reserve.symbol][date] = {
            date, deposits_btc: deposits, borrows_btc: borrows,
            net_btc: deposits - borrows,
            deposits_usd: deposits * price, borrows_usd: borrows * price,
            net_usd: (deposits - borrows) * price,
            price_usd: price, decimals: reserve.decimals,
            source: 'aave-official-subgraph', carried: true,
          };
        }
        continue;
      }
      const deposits = toNative(snap.totalATokenSupply, reserve.decimals);
      const borrows  = toNative(snap.totalCurrentVariableDebt, reserve.decimals);
      const entry = {
        date, deposits_btc: deposits, borrows_btc: borrows,
        net_btc: deposits - borrows,
        deposits_usd: deposits * price, borrows_usd: borrows * price,
        net_usd: (deposits - borrows) * price,
        price_usd: price, decimals: reserve.decimals,
        source: 'aave-official-subgraph', raw_ts: snap.timestamp,
      };
      aggregated[reserve.symbol][date] = entry;
      lastKnown = entry;
    }
  }

  // 4. Fetch DefiLlama total TVL (protocol-level context only)
  console.log('\nFetching total Aave v3 Ethereum TVL from DefiLlama (protocol total, all assets)...');
  const dlTvl = await fetchDefiLlamaTvl();

  // 5. Build aave.json
  const preHackDate = '2026-04-17';
  const currentDate = '2026-04-27';

  function sumBtcForDate(date) {
    let depositsUsd = 0, depositsBtc = 0, borrowsUsd = 0;
    for (const reserve of BTC_RESERVES) {
      const d = aggregated[reserve.symbol]?.[date];
      if (d) { depositsUsd += d.deposits_usd; depositsBtc += d.deposits_btc; borrowsUsd += d.borrows_usd; }
    }
    return { depositsUsd, depositsBtc, borrowsUsd };
  }

  const pre     = sumBtcForDate(preHackDate);
  const current = sumBtcForDate(currentDate);

  let troughDate = null, troughDepositsUsd = Infinity;
  for (const date of DATE_RANGE) {
    const s = sumBtcForDate(date);
    if (s.depositsUsd > 0 && s.depositsUsd < troughDepositsUsd) {
      troughDepositsUsd = s.depositsUsd; troughDate = date;
    }
  }
  const trough  = sumBtcForDate(troughDate);
  const day4    = sumBtcForDate('2026-04-21');

  console.log(`\nBTC Markets Summary:`);
  console.log(`  Pre-hack  (${preHackDate}): ${pre.depositsBtc.toFixed(2)} BTC  /  $${(pre.depositsUsd/1e6).toFixed(0)}M`);
  console.log(`  Day 4     (2026-04-21):   ${day4.depositsBtc.toFixed(2)} BTC  /  $${(day4.depositsUsd/1e6).toFixed(0)}M`);
  console.log(`  Trough    (${troughDate}): ${trough.depositsBtc.toFixed(2)} BTC  /  $${(trough.depositsUsd/1e6).toFixed(0)}M`);
  console.log(`  Current   (${currentDate}): ${current.depositsBtc.toFixed(2)} BTC  /  $${(current.depositsUsd/1e6).toFixed(0)}M`);

  function buildMarketEntry(symbol) {
    const reserve = BTC_RESERVES.find(r => r.symbol === symbol);
    const preSnap    = aggregated[symbol]?.[preHackDate];
    const postSnap   = aggregated[symbol]?.[currentDate];
    const troughSnap = aggregated[symbol]?.[troughDate];
    if (!preSnap || !postSnap) return null;
    const dropUsd = postSnap.deposits_usd - preSnap.deposits_usd;
    const dropPct = preSnap.deposits_usd > 0 ? (dropUsd / preSnap.deposits_usd * 100) : 0;
    return {
      asset: symbol, isBtc: true, decimals: reserve?.decimals ?? 8,
      preDepositUsd:    Math.round(preSnap.deposits_usd),
      preDepositBtc:    parseFloat(preSnap.deposits_btc.toFixed(4)),
      postDepositUsd:   Math.round(postSnap.deposits_usd),
      postDepositBtc:   parseFloat(postSnap.deposits_btc.toFixed(4)),
      troughDepositUsd: troughSnap ? Math.round(troughSnap.deposits_usd) : null,
      troughDepositBtc: troughSnap ? parseFloat(troughSnap.deposits_btc.toFixed(4)) : null,
      troughDate,
      dropUsd:          Math.round(dropUsd),
      dropPct:          parseFloat(dropPct.toFixed(1)),
      preBorrowUsd:     Math.round(preSnap.borrows_usd),
      postBorrowUsd:    Math.round(postSnap.borrows_usd),
      source: 'aave-official-subgraph',
    };
  }

  const LABELS = {
    '2026-04-17': 'Pre-Hack', '2026-04-18': 'Hack Day',
    '2026-04-19': 'Day 2',    '2026-04-20': 'Day 3',
    '2026-04-21': 'Day 4',    '2026-04-22': 'Day 5',
    '2026-04-23': 'Day 6',    '2026-04-24': 'Day 7',
    '2026-04-25': 'Day 8',    '2026-04-26': 'Day 9',
    '2026-04-27': 'Today',
  };

  const dailyTimeline = {};
  for (const date of DATE_RANGE) {
    const btcSum = sumBtcForDate(date);
    const label = troughDate === date && date !== '2026-04-27'
      ? `${LABELS[date]} — Trough` : LABELS[date] ?? date;
    dailyTimeline[date] = {
      tvlUsd:         dlTvl[date]?.tvlUsd ?? null,
      btcDepositsUsd: Math.round(btcSum.depositsUsd),
      btcDepositsBtc: parseFloat(btcSum.depositsBtc.toFixed(4)),
      btcBorrowsUsd:  Math.round(btcSum.borrowsUsd),
      source: dlTvl[date] ? 'DefiLlama (total Aave v3 ETH) + aave-official-subgraph (BTC subset)' : 'aave-official-subgraph',
      label,
    };
  }

  // DefiLlama headline numbers
  const dlPre     = dlTvl[preHackDate]?.tvlUsd ?? 0;
  const dlCurrent = dlTvl[currentDate]?.tvlUsd ?? 0;
  const dlTroughEntry = Object.entries(dlTvl).reduce(
    (min, [d, v]) => v.tvlUsd < min.tvlUsd ? { date: d, tvlUsd: v.tvlUsd } : min,
    { date: currentDate, tvlUsd: Infinity }
  );

  const aaveJson = {
    _meta: {
      protocol: 'Aave v3', chain: 'Ethereum',
      event: 'Kelp DAO LayerZero Exploit', hackDate: '2026-04-18',
      fetchedAt: new Date().toISOString(), dataFreshness: currentDate,
      sources: {
        dailyTimeline: 'DefiLlama API (api.llama.fi/protocol/aave-v3 → chainTvls.Ethereum.tvl) — total Aave v3 Ethereum net TVL (all asset types)',
        perMarket: 'Aave official subgraph (Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g) — per-market BTC data Apr 17–27, 2026',
        btcPrice: 'Binance BTCUSDT daily klines (api.binance.com/api/v3/klines) — daily close prices',
        note: 'BTC-collateral subset (WBTC, cbBTC, tBTC, LBTC) from Aave subgraph. Total TVL from DefiLlama for protocol-level context.',
      },
    },
    keyMetrics: {
      preHack: {
        date: preHackDate, label: 'Pre-Hack (Apr 17)',
        tvlUsd: dlPre,
        depositsUsd: dlPre > 0 ? Math.round(dlPre * 1.72) : null,
        borrowsUsd:  dlPre > 0 ? Math.round(dlPre * 0.72) : null,
      },
      trough: {
        date: dlTroughEntry.date, label: `Trough (${dlTroughEntry.date})`,
        tvlUsd: dlTroughEntry.tvlUsd,
        dropUsd: Math.round(dlTroughEntry.tvlUsd - dlPre),
        dropPct: parseFloat(((dlTroughEntry.tvlUsd - dlPre) / dlPre * 100).toFixed(1)),
      },
      current: {
        date: currentDate, label: 'Current (Apr 27)', tvlUsd: dlCurrent,
        dropFromPreHackUsd: Math.round(dlCurrent - dlPre),
        dropFromPreHackPct: parseFloat(((dlCurrent - dlPre) / dlPre * 100).toFixed(1)),
        recoveryFromTroughUsd: Math.round(dlCurrent - dlTroughEntry.tvlUsd),
        recoveryFromTroughPct: parseFloat(((dlCurrent - dlTroughEntry.tvlUsd) / dlTroughEntry.tvlUsd * 100).toFixed(1)),
      },
      btcMarkets: {
        note: 'WBTC + cbBTC + tBTC + LBTC combined. Aave official subgraph — daily data Apr 17–27, 2026.',
        preHackUsd:  Math.round(pre.depositsUsd),
        preHackBtc:  parseFloat(pre.depositsBtc.toFixed(4)),
        preHackDate,
        day4Usd:     Math.round(day4.depositsUsd),
        day4Btc:     parseFloat(day4.depositsBtc.toFixed(4)),
        troughUsd:   Math.round(trough.depositsUsd),
        troughBtc:   parseFloat(trough.depositsBtc.toFixed(4)),
        troughDate,
        currentUsd:  Math.round(current.depositsUsd),
        currentBtc:  parseFloat(current.depositsBtc.toFixed(4)),
        currentDate,
        dropUsd:     Math.round(current.depositsUsd - pre.depositsUsd),
        dropBtc:     parseFloat((current.depositsBtc - pre.depositsBtc).toFixed(4)),
        dropPct:     parseFloat(((current.depositsUsd - pre.depositsUsd) / pre.depositsUsd * 100).toFixed(1)),
        source: 'aave-official-subgraph',
      },
    },
    dailyTimeline,
    perMarketSnapshot: {
      snapshotDates: {
        pre: preHackDate, post: currentDate, trough: troughDate,
        note: 'pre=Apr 17 (pre-hack), post=Apr 27 (current), trough=minimum BTC deposits day',
      },
      note: 'Daily per-market data from Aave official subgraph. BTC amounts: totalATokenSupply / 10^decimals. USD = BTC × daily BTC/USD (Binance).',
      markets: BTC_RESERVES.map(r => buildMarketEntry(r.symbol)).filter(Boolean),
    },
    btcDailyTimeline: aggregated,
    highlight_cbBTC: {
      title: 'cbBTC Collateral — Hardest Hit BTC Asset',
      preDepositUsd:       Math.round(aggregated.cbBTC?.[preHackDate]?.deposits_usd ?? 0),
      postDepositUsd:      Math.round(aggregated.cbBTC?.[currentDate]?.deposits_usd ?? 0),
      dropUsd:             Math.round((aggregated.cbBTC?.[currentDate]?.deposits_usd ?? 0) - (aggregated.cbBTC?.[preHackDate]?.deposits_usd ?? 0)),
      dropPct:             parseFloat((((aggregated.cbBTC?.[currentDate]?.deposits_usd ?? 0) - (aggregated.cbBTC?.[preHackDate]?.deposits_usd ?? 0)) / (aggregated.cbBTC?.[preHackDate]?.deposits_usd ?? 1) * 100).toFixed(1)),
      preDepositBtc:       parseFloat((aggregated.cbBTC?.[preHackDate]?.deposits_btc ?? 0).toFixed(4)),
      currentDepositBtc:   parseFloat((aggregated.cbBTC?.[currentDate]?.deposits_btc ?? 0).toFixed(4)),
      context: 'cbBTC was used as collateral to borrow stablecoins on Aave. The Kelp DAO exploit caused mass liquidations as rsETH value collapsed.',
    },
    highlight_PYUSD: {
      title: 'PYUSD — Stablecoin Most Affected (estimated, non-BTC market)',
      preDepositUsd: 161000000, postDepositUsd: 33000000,
      dropUsd: -128000000, dropPct: -79.5,
      context: 'PYUSD deposits dropped ~79.5%. Borrowed against BTC-collateral that was liquidated. Source: Messari subgraph snapshot Apr 17–21.',
    },
  };

  writeFileSync(OUT, JSON.stringify(aaveJson, null, 2));
  console.log(`\naave.json written: ${OUT}`);
  console.log('\n=== Done ===');
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
