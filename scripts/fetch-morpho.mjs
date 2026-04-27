#!/usr/bin/env node
// Fetch Morpho Blue multichain BTC-collateral data
// Usage: node scripts/fetch-morpho.mjs
// Output: data/morpho.json (updates in place)
// No API key required — uses Morpho public GraphQL API.

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '../data/morpho.json');

const MORPHO_API = 'https://blue-api.morpho.org/graphql';

const CHAIN_IDS = [1, 8453, 42161, 137, 10, 534352, 252]; // ETH, Base, Arb, Polygon, OP, Scroll, Fraxtal
const CHAIN_NAMES = { 1:'Ethereum', 8453:'Base', 42161:'Arbitrum One', 137:'Polygon', 10:'OP Mainnet', 534352:'Scroll', 252:'Fraxtal' };

const FROM_DATE = '2026-04-17';
const TO_DATE   = new Date().toISOString().slice(0, 10);

const BTC_TOKENS = ['WBTC','cbBTC','LBTC','tBTC','BTC','sBTC'];

async function gql(query, variables = {}) {
  const res = await fetch(MORPHO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchMarketsForChain(chainId) {
  const data = await gql(`
    query($chainId: Int!, $skip: Int) {
      markets(where: { chainId_in: [$chainId] }, first: 100, skip: $skip) {
        items {
          uniqueKey
          collateralAsset { symbol decimals }
          loanAsset { symbol }
          dailySnapshots(orderBy: { date: ASC }, first: 30, where: { date_gte: "${FROM_DATE}", date_lte: "${TO_DATE}" }) {
            date
            collateral { usd }
            state { collateral }
          }
        }
      }
    }`, { chainId, skip: 0 });
  return (data?.markets?.items ?? []).filter(m =>
    BTC_TOKENS.some(t => m?.collateralAsset?.symbol?.includes(t))
  );
}

async function run() {
  console.log(`Fetching Morpho Blue BTC markets for ${FROM_DATE} → ${TO_DATE}...`);
  const allMarkets = {};
  const totals = {};
  const perChain = {};

  for (const chainId of CHAIN_IDS) {
    const chainName = CHAIN_NAMES[chainId];
    console.log(`  Chain: ${chainName} (${chainId})`);
    let markets;
    try { markets = await fetchMarketsForChain(chainId); }
    catch (e) { console.warn(`    Error: ${e.message}`); continue; }

    for (const m of markets) {
      const decimals = m.collateralAsset?.decimals ?? 8;
      const collateral = m.collateralAsset?.symbol ?? '?';
      const loan = m.loanAsset?.symbol ?? '?';
      const key = m.uniqueKey;
      allMarkets[key] = { chainId, chainName, collateral, loan, daily: {} };

      for (const snap of (m.dailySnapshots ?? [])) {
        const rawAmount = parseFloat(snap.state?.collateral ?? 0) / Math.pow(10, decimals);
        const usd = parseFloat(snap.collateral?.usd ?? 0);
        const btcPrice = rawAmount > 0 ? usd / rawAmount : 0;
        allMarkets[key].daily[snap.date] = { btc: rawAmount, usd, btcPrice };

        if (!totals[snap.date]) totals[snap.date] = { btc: 0, usd: 0 };
        totals[snap.date].btc += rawAmount;
        totals[snap.date].usd += usd;

        if (!perChain[chainName]) perChain[chainName] = { chainId, daily: {} };
        if (!perChain[chainName].daily[snap.date]) perChain[chainName].daily[snap.date] = { btc: 0, usd: 0 };
        perChain[chainName].daily[snap.date].btc += rawAmount;
        perChain[chainName].daily[snap.date].usd += usd;
      }
    }
  }

  // Sort dates
  const dates = Object.keys(totals).sort();
  const preHack = totals['2026-04-18'] ?? totals[dates[0]];
  const trough  = dates.reduce((a, b) => (totals[a]?.btc ?? Infinity) < (totals[b]?.btc ?? Infinity) ? a : b);
  const current = dates[dates.length - 1];

  const out = {
    _meta: {
      protocol: 'Morpho Blue',
      event: 'Kelp DAO LayerZero Exploit',
      hackDate: '2026-04-18',
      fetchedAt: new Date().toISOString(),
      dataFreshness: current,
      marketsAnalyzed: Object.keys(allMarkets).length,
      source: 'Morpho Blue official GraphQL API (blue-api.morpho.org/graphql)',
    },
    keyMetrics: {
      preHack: { date: '2026-04-18', btc: preHack?.btc ?? 0, usd: preHack?.usd ?? 0 },
      trough:  { date: trough, btc: totals[trough]?.btc ?? 0, dropBtc: (totals[trough]?.btc ?? 0) - (preHack?.btc ?? 0) },
      current: { date: current, btc: totals[current]?.btc ?? 0 },
    },
    dailyTimeline: Object.fromEntries(dates.map(d => [d, { btc: Math.round(totals[d].btc * 100) / 100, usd: Math.round(totals[d].usd) }])),
    perChain: Object.fromEntries(Object.entries(perChain).map(([name, c]) => [
      name, { chainId: c.chainId, daily: Object.fromEntries(Object.entries(c.daily).sort(([a],[b]) => a.localeCompare(b)).map(([d,v]) => [d, { btc: Math.round(v.btc*100)/100, usd: Math.round(v.usd) }])) }
    ])),
    topMarkets: Object.entries(allMarkets)
      .map(([key, m]) => ({
        key, chainName: m.chainName, collateral: m.collateral, loan: m.loan,
        preHackBtc: Math.round((m.daily['2026-04-18']?.btc ?? 0) * 100) / 100,
        currentBtc: Math.round((m.daily[current]?.btc ?? 0) * 100) / 100,
      }))
      .sort((a, b) => b.preHackBtc - a.preHackBtc)
      .slice(0, 15),
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Written to ${OUT} (${Object.keys(allMarkets).length} markets, ${dates.length} dates)`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
