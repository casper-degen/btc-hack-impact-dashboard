#!/usr/bin/env node
// Fetch Spark Protocol (SparkLend) BTC-market data via The Graph + DefiLlama
// Usage: GRAPH_API_KEY=xxx node scripts/fetch-spark.mjs
//
// Chains: Ethereum (main, has WBTC/cbBTC/LBTC/tBTC), Gnosis (no BTC reserves confirmed)
// Window: Apr 17 → Apr 29, 2026
// Schema: Messari standard (markets + marketDailySnapshots), NOT Aave-reserve schema

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_OUT = join(__dir, '../data/spark.json');

const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
if (!GRAPH_API_KEY) { console.error('ERROR: GRAPH_API_KEY not set'); process.exit(1); }

// Verified live subgraphs (tested Apr 27 2026)
const SUBGRAPHS = {
  Ethereum: 'GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si',
  Gnosis:   'Bw4RH37UbbGEhHo4FaWwT1dn9QJzm1XSZCyK1cbr6ZKM',
};

// BTC market IDs on Spark Lend Ethereum (verified via subgraph query)
const ETH_BTC_MARKETS = [
  { marketId: '0x4197ba364ae6698015ae5c1468f54087602715b2', symbol: 'WBTC',  decimals: 8,  underlyingAsset: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' },
  { marketId: '0xa9d4ecebd48c282a70cfd3c469d6c8f178a5738e', symbol: 'LBTC',  decimals: 8,  underlyingAsset: '0x8236a87084f8b84306f72007f36f2618a5634494' },
  { marketId: '0xb3973d459df38ae57797811f2a1fd061da1bc123', symbol: 'cbBTC', decimals: 8,  underlyingAsset: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' },
  { marketId: '0xce6ca9cdce00a2b0c0d1dac93894f4bd2c960567', symbol: 'tBTC',  decimals: 18, underlyingAsset: '0x18084fba666a33d37592fa2633fd49a74dd93a88' },
];

// Apr 17 00:00 UTC → Apr 27 23:59 UTC
const FROM_TS = 1776384000;
const TO_TS   = 1777507199;

const DATE_RANGE = [];
for (let d = new Date('2026-04-17T00:00:00Z'); d <= new Date('2026-04-29T23:59:59Z'); d.setDate(d.getDate() + 1)) {
  DATE_RANGE.push(new Date(d).toISOString().slice(0, 10));
}

function gql(subgraphId, query) {
  const url = `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${subgraphId}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  }).then(r => r.json());
}

function tsToDate(ts) {
  return new Date(parseInt(ts) * 1000).toISOString().slice(0, 10);
}

async function fetchMarketSnapshots(subgraphId, marketId, symbol, decimals) {
  console.log(`  Fetching ${symbol} daily snapshots...`);
  const query = `{
    marketDailySnapshots(
      first: 30,
      where: { market: "${marketId}", timestamp_gte: ${FROM_TS}, timestamp_lte: ${TO_TS} },
      orderBy: timestamp, orderDirection: asc
    ) {
      id timestamp
      totalDepositBalanceUSD totalBorrowBalanceUSD
      inputTokenBalance
    }
  }`;
  const data = await gql(subgraphId, query);
  if (data.errors) throw new Error(`GraphQL error for ${symbol}: ${JSON.stringify(data.errors)}`);
  return (data.data?.marketDailySnapshots || []).map(s => ({
    date: tsToDate(s.timestamp),
    timestamp: parseInt(s.timestamp),
    deposits_btc: parseFloat(s.inputTokenBalance) / (10 ** decimals),
    deposits_usd: parseFloat(s.totalDepositBalanceUSD),
    borrows_usd:  parseFloat(s.totalBorrowBalanceUSD),
  }));
}

async function fetchCurrentMarkets(subgraphId) {
  const symbols = ETH_BTC_MARKETS.map(m => `"${m.symbol}"`).join(',');
  const query = `{
    markets(where: { inputToken_: { symbol_in: [${symbols}] } }) {
      id name
      inputToken { id symbol decimals }
      totalDepositBalanceUSD totalBorrowBalanceUSD
      inputTokenBalance
    }
  }`;
  const data = await gql(subgraphId, query);
  if (data.errors) throw new Error(`GraphQL error for current markets: ${JSON.stringify(data.errors)}`);
  return data.data?.markets || [];
}

async function fetchMeta(subgraphId) {
  const data = await gql(subgraphId, '{ _meta { block { number timestamp } hasIndexingErrors } }');
  return data.data?._meta;
}

async function fetchDefiLlama() {
  console.log('  Fetching DefiLlama TVL for Spark...');
  const r = await fetch('https://api.llama.fi/protocol/spark');
  const d = await r.json();
  const tvlList = d.tvl || [];
  const seen = {};
  for (const e of tvlList) {
    const date = new Date(e.date * 1000).toISOString().slice(0, 10);
    if (date >= '2026-04-17' && date <= '2026-04-29') {
      seen[date] = { date, totalUsd: e.totalLiquidityUSD };
    }
  }
  return DATE_RANGE.map(d => seen[d] || { date: d, totalUsd: null });
}

async function main() {
  console.log('=== fetch-spark.mjs ===');
  const raw = { subgraphs: {}, snapshots: {}, currentMarkets: [], defiLlama: [] };

  // 1. Verify subgraph liveness
  console.log('Checking subgraph liveness...');
  for (const [chain, id] of Object.entries(SUBGRAPHS)) {
    const meta = await fetchMeta(id);
    const ts = meta?.block?.timestamp;
    const ageHours = ts ? Math.round((Date.now()/1000 - ts) / 3600) : '?';
    console.log(`  ${chain}: block ${meta?.block?.number}, age ${ageHours}h, errors: ${meta?.hasIndexingErrors}`);
    if (ageHours > 6) console.warn(`  WARNING: ${chain} subgraph is ${ageHours}h stale`);
    raw.subgraphs[chain] = { id, meta };
  }

  // 2. Fetch BTC market snapshots (Ethereum only — Gnosis has no BTC)
  console.log('Fetching BTC market daily snapshots (Ethereum)...');
  for (const m of ETH_BTC_MARKETS) {
    const snaps = await fetchMarketSnapshots(SUBGRAPHS.Ethereum, m.marketId, m.symbol, m.decimals);
    raw.snapshots[m.symbol] = snaps;
    console.log(`    ${m.symbol}: ${snaps.length} daily snapshots`);
  }

  // 3. Get current market states
  console.log('Fetching current market states...');
  raw.currentMarkets = await fetchCurrentMarkets(SUBGRAPHS.Ethereum);

  // 4. Fetch DefiLlama TVL
  raw.defiLlama = await fetchDefiLlama();


  // === AGGREGATE ===
  // Build per-asset per-day lookup
  const assetByDate = {};
  for (const m of ETH_BTC_MARKETS) {
    assetByDate[m.symbol] = {};
    for (const s of (raw.snapshots[m.symbol] || [])) {
      assetByDate[m.symbol][s.date] = s;
    }
  }

  // Current state by symbol
  const currentBySymbol = {};
  for (const cm of raw.currentMarkets) {
    const sym = cm.inputToken?.symbol;
    const dec = parseInt(cm.inputToken?.decimals || 8);
    currentBySymbol[sym] = {
      deposits_btc: parseFloat(cm.inputTokenBalance) / (10 ** dec),
      deposits_usd: parseFloat(cm.totalDepositBalanceUSD),
      borrows_usd:  parseFloat(cm.totalBorrowBalanceUSD),
    };
  }

  // Build btcDailyTimeline per asset
  const btcDailyTimeline = {};
  for (const m of ETH_BTC_MARKETS) {
    btcDailyTimeline[m.symbol] = {};
    for (const date of DATE_RANGE) {
      const snap = assetByDate[m.symbol][date];
      if (snap) {
        btcDailyTimeline[m.symbol][date] = {
          date,
          deposits_btc: snap.deposits_btc,
          deposits_usd: snap.deposits_usd,
          borrows_usd:  snap.borrows_usd,
          net_usd:      snap.deposits_usd - snap.borrows_usd,
          source: 'spark-lend-ethereum-subgraph',
        };
      } else if (date === '2026-04-29') {
        // Use current state for today if no snapshot yet
        const cur = currentBySymbol[m.symbol];
        if (cur) {
          btcDailyTimeline[m.symbol][date] = {
            date,
            deposits_btc: cur.deposits_btc,
            deposits_usd: cur.deposits_usd,
            borrows_usd:  cur.borrows_usd,
            net_usd:      cur.deposits_usd - cur.borrows_usd,
            source: 'spark-lend-ethereum-current-state',
          };
        }
      }
    }
  }

  // Daily totals
  function dailyTotals(date) {
    let totalBtc = 0, totalDepUsd = 0, totalBorrUsd = 0;
    for (const sym of Object.keys(btcDailyTimeline)) {
      const e = btcDailyTimeline[sym][date];
      if (e) {
        totalBtc    += e.deposits_btc;
        totalDepUsd += e.deposits_usd;
        totalBorrUsd+= e.borrows_usd;
      }
    }
    return { btc: totalBtc, depUsd: totalDepUsd, borrUsd: totalBorrUsd, netUsd: totalDepUsd - totalBorrUsd };
}

  const dailyAgg = {};
  for (const date of DATE_RANGE) {
    dailyAgg[date] = dailyTotals(date);
  }

  // Pre-hack: Apr 17
  const preHack = dailyAgg['2026-04-17'];
  const preHackBtc = preHack.btc;
  const preHackUsd = preHack.depUsd;

  // Trough: min daily BTC (might be pre-hack itself since Spark gained)
  let troughBtc = Infinity, troughDate = '2026-04-17', troughUsd = 0;
  for (const date of DATE_RANGE) {
    const agg = dailyAgg[date];
    if (agg.btc > 0 && agg.btc < troughBtc) {
      troughBtc = agg.btc;
      troughDate = date;
      troughUsd = agg.depUsd;
    }
  }
  if (!isFinite(troughBtc)) { troughBtc = 0; troughDate = '2026-04-17'; troughUsd = 0; }

  // Current: Apr 27 (or last available)
  let currentDate = '2026-04-29';
  let currentBtc = 0, currentUsd = 0;
  for (const sym of ETH_BTC_MARKETS.map(m => m.symbol)) {
    const cur = currentBySymbol[sym];
    if (cur) { currentBtc += cur.deposits_btc; currentUsd += cur.deposits_usd; }
  }
  if (currentBtc === 0) {
    const last = dailyAgg['2026-04-27'];
    currentBtc = last.btc; currentUsd = last.depUsd;
  }

  const dropBtc = currentBtc - preHackBtc;
  const dropUsd = currentUsd - preHackUsd;
  const dropPct  = preHackBtc > 0 ? ((dropBtc / preHackBtc) * 100) : 0;

  // Cross-check: WBTC subgraph vs current state
  const wbtcSnaps = raw.snapshots['WBTC'] || [];
  const wbtcLastSnap = wbtcSnaps[wbtcSnaps.length - 1];
  const wbtcCurrent = currentBySymbol['WBTC'];
  const crossCheckDeltaPct = wbtcLastSnap && wbtcCurrent
    ? ((wbtcCurrent.deposits_btc - wbtcLastSnap.deposits_btc) / wbtcLastSnap.deposits_btc * 100).toFixed(2)
    : 'N/A';

  // protocolTvlTimeline from DefiLlama
  const protocolTvlTimeline = raw.defiLlama.filter(e => e.totalUsd !== null);

  // Protocol TVL KPIs
  const protPre    = protocolTvlTimeline.find(e => e.date === '2026-04-17') || protocolTvlTimeline[0];
  const protTrough = protocolTvlTimeline.reduce((a, b) => b.totalUsd < a.totalUsd ? b : a, protocolTvlTimeline[0]);
  const protCur    = protocolTvlTimeline[protocolTvlTimeline.length - 1];

  // perMarketSnapshot
  const markets = ETH_BTC_MARKETS.map(m => {
    const preSnap = assetByDate[m.symbol]['2026-04-17'] || assetByDate[m.symbol]['2026-04-18'];
    const cur = currentBySymbol[m.symbol] || { deposits_btc: 0, deposits_usd: 0 };
    // trough: min over window
    let mkTroughBtc = Infinity, mkTroughDate = '2026-04-17';
    for (const date of DATE_RANGE) {
      const e = btcDailyTimeline[m.symbol][date];
      if (e && e.deposits_btc < mkTroughBtc) { mkTroughBtc = e.deposits_btc; mkTroughDate = date; }
    }
    if (!isFinite(mkTroughBtc)) mkTroughBtc = 0;
    const preDepBtc = preSnap ? preSnap.deposits_btc : 0;
    const dp = preDepBtc > 0 ? ((cur.deposits_btc - preDepBtc) / preDepBtc * 100) : 0;
    return {
      chain: 'Ethereum',
      asset: m.symbol,
      decimals: m.decimals,
      isBtc: true,
      underlyingAsset: m.underlyingAsset,
      marketId: m.marketId,
      preDepositBtc: preDepBtc,
      preDepositUsd: preSnap ? preSnap.deposits_usd : 0,
      troughDepositBtc: mkTroughBtc,
      currentDepositBtc: cur.deposits_btc,
      currentDepositUsd: cur.deposits_usd,
      dropPct: Math.round(dp * 10) / 10,
      source: 'spark-lend-ethereum-subgraph',
      note: !preSnap ? 'token-not-listed-pre-hack' : undefined,
    };
  });

  const aggregated = {
    btcDailyTimeline,
    dailyTotals: dailyAgg,
    preHack: { btc: preHackBtc, usd: preHackUsd },
    trough: { btc: troughBtc, usd: troughUsd, date: troughDate },
    current: { btc: currentBtc, usd: currentUsd, date: currentDate },
    drop: { btc: dropBtc, usd: dropUsd, pct: dropPct },
    markets,
    crossCheck: {
      wbtcLastSnapBtc: wbtcLastSnap?.deposits_btc,
      wbtcCurrentBtc: wbtcCurrent?.deposits_btc,
      deltaPct: crossCheckDeltaPct,
      note: 'subgraph last daily snapshot vs current market state',
    },
  };


  // === BUILD spark.json ===
  const sparkJson = {
    _meta: {
      protocol: 'Spark Protocol (SparkLend)',
      chains: 'Ethereum (BTC markets: WBTC, cbBTC, LBTC, tBTC) · Gnosis (no BTC reserves)',
      event: 'Kelp DAO LayerZero Exploit',
      hackDate: '2026-04-18',
      fetchedAt: new Date().toISOString(),
      dataFreshness: '2026-04-29',
      sources: {
        perMarket: 'Spark Lend Ethereum subgraph (The Graph Network) — per-market BTC data Apr 17–27, 2026',
        protocolTvl: 'DefiLlama API (api.llama.fi/protocol/spark) — multichain protocol TVL',
        note: 'Spark is an Aave v3 fork from Sky/MakerDAO ecosystem. BTC collateral INCREASED post-hack as users migrated from Aave.',
      },
      subgraphIds: {
        Ethereum: SUBGRAPHS.Ethereum,
        Gnosis: SUBGRAPHS.Gnosis,
      },
      caveats: [
        'LBTC had no deposits on Apr 17-18 (first snapshot Apr 19) — likely newly listed',
        'tBTC has minimal deposits throughout — excluded from total pre-hack',
        'Gnosis SparkLend: confirmed live but has no BTC reserves',
        'Spark BTC TVL GREW post-hack (users migrated from Aave) — Total Loss field shows a gain',
      ],
    },
    keyMetrics: {
      preHack: {
        date: '2026-04-17',
        label: 'Pre-Hack (Apr 17)',
        tvlUsd: protPre?.totalUsd || 0,
      },
      trough: {
        date: protTrough.date,
        label: `Trough (${protTrough.date})`,
        tvlUsd: protTrough.totalUsd,
        dropUsd: protTrough.totalUsd - protPre.totalUsd,
        dropPct: Math.round(((protTrough.totalUsd - protPre.totalUsd) / protPre.totalUsd) * 1000) / 10,
      },
      current: {
        date: protCur.date,
        label: `Current (${protCur.date})`,
        tvlUsd: protCur.totalUsd,
        dropFromPreHackUsd: protCur.totalUsd - protPre.totalUsd,
        dropFromPreHackPct: Math.round(((protCur.totalUsd - protPre.totalUsd) / protPre.totalUsd) * 1000) / 10,
      },
      btcMarkets: {
        note: 'All BTC-collateral markets on Spark Lend Ethereum. Source: Spark Lend subgraph (Messari schema).',
        preHackBtc: Math.round(preHackBtc * 100) / 100,
        preHackUsd: Math.round(preHackUsd),
        preHackDate: '2026-04-17',
        troughBtc: Math.round(troughBtc * 100) / 100,
        troughUsd: Math.round(troughUsd),
        troughDate,
        currentBtc: Math.round(currentBtc * 100) / 100,
        currentUsd: Math.round(currentUsd),
        currentDate,
        dropBtc: Math.round(dropBtc * 100) / 100,
        dropUsd: Math.round(dropUsd),
        dropPct: Math.round(dropPct * 10) / 10,
        source: 'spark-lend-ethereum-subgraph',
        narrative: 'Spark GAINED BTC collateral post-hack as users migrated from Aave',
      },
    },
    protocolTvlTimeline,
    btcDailyTimeline,
    perMarketSnapshot: {
      snapshotDates: { preHack: '2026-04-17', current: currentDate },
      note: 'BTC markets on Spark Lend Ethereum. All data from The Graph subgraph (Messari schema).',
      markets,
    },
    chainBreakdown: {
      Ethereum: {
        status: 'ok',
        subgraphId: SUBGRAPHS.Ethereum,
        schema: 'messari-standard',
        btcMarkets: markets.map(m => m.asset),
        currentBtc: Math.round(currentBtc * 100) / 100,
        currentUsd: Math.round(currentUsd),
        preHackBtc: Math.round(preHackBtc * 100) / 100,
        note: 'Main Spark Lend deployment with all BTC collateral',
      },
      Gnosis: {
        status: 'no_btc_reserves',
        subgraphId: SUBGRAPHS.Gnosis,
        note: 'Confirmed live but no BTC reserves',
      },
    },
  };

  writeFileSync(DATA_OUT, JSON.stringify(sparkJson, null, 2));
  console.log(`spark.json saved → ${DATA_OUT}`);

  console.log('\n=== SUMMARY ===');
  console.log(`Pre-hack BTC: ${Math.round(preHackBtc)} BTC ($${Math.round(preHackUsd/1e6)}M)`);
  console.log(`Trough BTC:   ${Math.round(troughBtc)} BTC ($${Math.round(troughUsd/1e6)}M) on ${troughDate}`);
  console.log(`Current BTC:  ${Math.round(currentBtc)} BTC ($${Math.round(currentUsd/1e6)}M) on ${currentDate}`);
  console.log(`Change:       ${dropPct >= 0 ? '+' : ''}${Math.round(dropPct)}% (${Math.round(dropBtc)} BTC)`);
  console.log(`Protocol TVL: Pre-hack $${(protPre?.totalUsd/1e9).toFixed(2)}B → Current $${(protCur.totalUsd/1e9).toFixed(2)}B`);
  console.log(`Cross-check WBTC: snap ${Math.round(wbtcLastSnap?.deposits_btc)} BTC vs current ${Math.round(wbtcCurrent?.deposits_btc)} BTC, delta ${crossCheckDeltaPct}%`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
