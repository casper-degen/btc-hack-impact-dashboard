#!/usr/bin/env node
// Fetch Aave v3 BTC-market data across all chains via official subgraphs
// Usage: GRAPH_API_KEY=xxx node scripts/fetch-aave-multichain.mjs
//
// Chains: Ethereum, Polygon, Arbitrum, Optimism, Avalanche, BNB, Base, Scroll, Gnosis, Linea, Metis
// Sources: Aave official subgraphs (The Graph Network + Metis custom endpoint)
// Window: Apr 17 → Apr 29, 2026

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_OUT = join(__dir, '../data/aave.json');

const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
if (!GRAPH_API_KEY) {
  console.error('ERROR: GRAPH_API_KEY not set');
  process.exit(1);
}

const FROM_TS = Math.floor(new Date('2026-04-17T00:00:00Z').getTime() / 1000);
const TO_TS   = Math.floor(new Date('2026-04-30T00:00:00Z').getTime() / 1000);

const DATE_RANGE = [];
for (let d = new Date('2026-04-17T00:00:00Z'); d <= new Date('2026-04-29T23:59:59Z'); d.setDate(d.getDate() + 1)) {
  DATE_RANGE.push(new Date(d).toISOString().slice(0, 10));
}

// All confirmed-live Aave v3 subgraphs + BTC token addresses per chain
// Reserve IDs = underlyingAsset.toLowerCase() + poolAddressesProvider.toLowerCase()
// For chains where pool address provider is unknown, use address-only filter via reserves query
const CHAINS = [
  {
    name: 'Ethereum',
    subgraphId: 'Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g',
    btcReserves: [
      { symbol: 'WBTC',  id: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c5990x2f39d218133afab8f2b819b1066c7e434ad94e9e', decimals: 8  },
      { symbol: 'cbBTC', id: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf0x2f39d218133afab8f2b819b1066c7e434ad94e9e', decimals: 8  },
      { symbol: 'tBTC',  id: '0x18084fba666a33d37592fa2633fd49a74dd93a880x2f39d218133afab8f2b819b1066c7e434ad94e9e', decimals: 18 },
      { symbol: 'LBTC',  id: '0x8236a87084f8b84306f72007f36f2618a56344940x2f39d218133afab8f2b819b1066c7e434ad94e9e', decimals: 8  },
    ],
  },
  {
    name: 'Polygon',
    subgraphId: 'Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211',
    btcTokens: ['0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6'], // WBTC on Polygon
  },
  {
    name: 'Arbitrum',
    subgraphId: 'DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',
    btcTokens: ['0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f'], // WBTC on Arbitrum
  },
  {
    name: 'Optimism',
    subgraphId: 'DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb',
    btcTokens: [
      '0x68f180fcce6836688e9084f035309e29bf0a2095', // WBTC on Optimism
      '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40', // tBTC on Optimism
    ],
  },
  {
    name: 'Base',
    subgraphId: 'GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF',
    btcTokens: [
      '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // cbBTC on Base
      '0x236aa50979d5f3de3bd1eeb40e81137f22ab794b', // tBTC on Base
      '0xecac9c5f704e954931349da37f60e39f515c11c1', // LBTC on Base
    ],
  },
  {
    name: 'Avalanche',
    subgraphId: '2h9woxy8RTjHu1HJsCEnmzpPHFArU33avmUh4f71JpVn',
    btcTokens: ['0x152b9d0fdc40c096757f570a51e494bd4b943e50'], // BTC.b on Avalanche
  },
  {
    name: 'BNB',
    subgraphId: '7Jk85XgkV1MQ7u56hD8rr65rfASbayJXopugWkUoBMnZ',
    btcTokens: ['0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c'], // BTCB on BNB
  },
  {
    name: 'Scroll',
    subgraphId: '74JwenoHZb2aAYVGCCSdPWzi9mm745dyHyQQVoZ7Sbub',
    btcTokens: null, // discover via reserves query
  },
  {
    name: 'Gnosis',
    subgraphId: 'HtcDaL8L8iZ2KQNNS44EBVmLruzxuNAz1RkBYdui1QUT',
    btcTokens: null, // discover via reserves query
  },
  {
    name: 'Linea',
    subgraphId: 'Gz2kjnmRV1fQj3R8cssoZa5y9VTanhrDo4Mh7nWW1wHa',
    btcTokens: null, // discover via reserves query
  },
  {
    name: 'Metis',
    customUrl: 'https://metisapi.0xgraph.xyz/subgraphs/name/aave/protocol-v3-metis',
    btcTokens: null, // discover via reserves query
  },
];

function subgraphUrl(chain) {
  if (chain.customUrl) return chain.customUrl;
  return `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${chain.subgraphId}`;
}

async function queryGraph(url, query, variables = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Subgraph error: ${JSON.stringify(json.errors[0]?.message || json.errors)}`);
  return json.data;
}

async function discoverBtcReserves(chain) {
  const url = subgraphUrl(chain);
  const data = await queryGraph(url, `{
    reserves(first: 200) {
      id
      underlyingAsset
      symbol
      decimals
    }
  }`);
  const btcPattern = /wbtc|cbbtc|tbtc|lbtc|btc\.b|btcb|sbtc|renbtc|hbtc/i;
  const btcReserves = data.reserves.filter(r => btcPattern.test(r.symbol));
  return btcReserves.map(r => ({
    symbol: r.symbol,
    id: r.id,
    decimals: parseInt(r.decimals),
    underlyingAsset: r.underlyingAsset,
  }));
}

async function resolveReserves(chain) {
  if (chain.btcReserves) return chain.btcReserves;
  if (chain.btcTokens) {
    // Fetch reserves and match by underlyingAsset address
    const url = subgraphUrl(chain);
    const data = await queryGraph(url, `{
      reserves(first: 200) { id underlyingAsset symbol decimals }
    }`);
    const matched = data.reserves.filter(r =>
      chain.btcTokens.includes(r.underlyingAsset.toLowerCase())
    );
    return matched.map(r => ({
      symbol: r.symbol,
      id: r.id,
      decimals: parseInt(r.decimals),
      underlyingAsset: r.underlyingAsset,
    }));
  }
  // Full discovery
  return discoverBtcReserves(chain);
}

async function fetchReserveHistory(url, reserveId) {
  const all = [];
  let skip = 0;
  const PAGE = 1000;
  while (true) {
    const data = await queryGraph(url, `
      query($reserve: String!, $from: Int!, $to: Int!, $skip: Int!) {
        reserveParamsHistoryItems(
          where: { reserve: $reserve, timestamp_gte: $from, timestamp_lte: $to }
          orderBy: timestamp orderDirection: asc
          first: ${PAGE} skip: $skip
        ) { timestamp totalATokenSupply totalCurrentVariableDebt }
      }
    `, { reserve: reserveId, from: FROM_TS, to: TO_TS, skip });
    const items = data.reserveParamsHistoryItems;
    all.push(...items);
    if (items.length < PAGE) break;
    skip += PAGE;
    await sleep(300);
  }
  return all;
}

async function fetchBtcUsdPrices() {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${FROM_TS*1000}&endTime=${TO_TS*1000}&limit=20`
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

function aggregateReserve(rawItems, reserve, btcPrices) {
  const byDay = groupByDay(rawItems);
  const daily = {};
  let lastKnown = null;
  for (const date of DATE_RANGE) {
    const snap = byDay[date];
    const price = btcPrices[date];
    if (!price) continue;
    if (!snap) {
      if (lastKnown) {
        daily[date] = { ...lastKnown, date, deposits_usd: lastKnown.deposits_btc * price, borrows_usd: lastKnown.borrows_btc * price, net_usd: (lastKnown.deposits_btc - lastKnown.borrows_btc) * price, price_usd: price, carried: true };
      }
      continue;
    }
    const deposits_btc = toNative(snap.totalATokenSupply, reserve.decimals);
    const borrows_btc  = toNative(snap.totalCurrentVariableDebt, reserve.decimals);
    const entry = {
      date, deposits_btc, borrows_btc,
      net_btc: deposits_btc - borrows_btc,
      deposits_usd: deposits_btc * price, borrows_usd: borrows_btc * price,
      net_usd: (deposits_btc - borrows_btc) * price,
      price_usd: price, decimals: reserve.decimals,
      source: 'aave-official-subgraph', raw_ts: snap.timestamp,
    };
    daily[date] = entry;
    lastKnown = entry;
  }
  return daily;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('=== Aave v3 Multichain BTC-markets fetch ===\n');
  console.log(`Chains: ${CHAINS.map(c => c.name).join(', ')}\n`);

  // Fetch BTC/USD prices
  console.log('Fetching BTC/USD prices from Binance...');
  const btcPrices = await fetchBtcUsdPrices();
  for (const date of DATE_RANGE) {
    if (!btcPrices[date]) throw new Error(`Missing BTC price for ${date}`);
  }
  console.log('  Prices OK\n');

  const rawByChain = {};

  const chainResults = {};

  for (const chain of CHAINS) {
    console.log(`\n--- ${chain.name} ---`);
    const cacheKey = chain.name;
    const url = subgraphUrl(chain);

    // Resolve BTC reserves for this chain
    let reserves;
    try {
      reserves = await resolveReserves(chain);
    } catch(e) {
      console.log(`  ERROR resolving reserves: ${e.message}`);
      chainResults[chain.name] = { status: 'error', error: e.message, subgraphId: chain.subgraphId || chain.customUrl };
      continue;
    }

    if (reserves.length === 0) {
      console.log(`  No BTC reserves found — skipping`);
      chainResults[chain.name] = {
        status: 'no_btc_reserves',
        subgraphId: chain.subgraphId || chain.customUrl,
        reserves: [],
      };
      continue;
    }

    console.log(`  BTC reserves: ${reserves.map(r => r.symbol).join(', ')}`);

    // Fetch history
    const chainRaw = {};

    for (const reserve of reserves) {
      try {
        console.log(`  ${reserve.symbol}: fetching...`);
        const items = await fetchReserveHistory(url, reserve.id);
        console.log(`    → ${items.length} events`);
        chainRaw[reserve.symbol] = items;
        await sleep(400);
      } catch(e) {
        console.log(`  ${reserve.symbol}: ERROR ${e.message}`);
        chainRaw[reserve.symbol] = [];
      }
    }

    // Aggregate daily data
    const aggregated = {};
    for (const reserve of reserves) {
      const raw = chainRaw[reserve.symbol] || [];
      if (raw.length === 0) {
        console.log(`  ${reserve.symbol}: no data for aggregation`);
        continue;
      }
      aggregated[reserve.symbol] = aggregateReserve(raw, reserve, btcPrices);
    }

    chainResults[chain.name] = {
      status: 'ok',
      subgraphId: chain.subgraphId || chain.customUrl,
      reserves: reserves.map(r => ({ symbol: r.symbol, id: r.id, decimals: r.decimals, underlyingAsset: r.underlyingAsset })),
      aggregated,
    };
  }


  // Summary
  console.log('\n=== Chain Summary ===');
  for (const [chain, result] of Object.entries(chainResults)) {
    if (result.status !== 'ok') { console.log(`  ${chain}: ${result.status}`); continue; }
    let preHackBtc = 0, currentBtc = 0;
    for (const daily of Object.values(result.aggregated)) {
      preHackBtc  += daily['2026-04-17']?.deposits_btc || 0;
      currentBtc  += daily['2026-04-27']?.deposits_btc || 0;
    }
    console.log(`  ${chain}: pre=${preHackBtc.toFixed(0)} BTC  current=${currentBtc.toFixed(0)} BTC`);
  }

  // Build updated aave.json
  await buildAaveJson(chainResults, btcPrices);
}

function sumChainForDate(chainAggregated, date) {
  let btc = 0, usd = 0, borrowsUsd = 0;
  for (const daily of Object.values(chainAggregated)) {
    const d = daily[date];
    if (d) { btc += d.deposits_btc; usd += d.deposits_usd; borrowsUsd += d.borrows_usd; }
  }
  return { btc, usd, borrowsUsd };
}

function sumAllChainsForDate(chainResults, date) {
  let btc = 0, usd = 0, borrowsUsd = 0;
  for (const result of Object.values(chainResults)) {
    if (result.status !== 'ok') continue;
    const s = sumChainForDate(result.aggregated, date);
    btc += s.btc; usd += s.usd; borrowsUsd += s.borrowsUsd;
  }
  return { btc, usd, borrowsUsd };
}

async function buildAaveJson(chainResults, btcPrices) {
  console.log('\nBuilding updated aave.json...');

  const preHackDate  = '2026-04-17';
  const currentDate  = '2026-04-29';
  const pre          = sumAllChainsForDate(chainResults, preHackDate);
  const current      = sumAllChainsForDate(chainResults, currentDate);

  let troughDate = null, troughUsd = Infinity;
  for (const date of DATE_RANGE) {
    const s = sumAllChainsForDate(chainResults, date);
    if (s.usd > 0 && s.usd < troughUsd) { troughUsd = s.usd; troughDate = date; }
  }
  const trough = sumAllChainsForDate(chainResults, troughDate);
  const day4   = sumAllChainsForDate(chainResults, '2026-04-21');

  console.log(`  Pre-hack (${preHackDate}): ${pre.btc.toFixed(0)} BTC  $${(pre.usd/1e6).toFixed(0)}M`);
  console.log(`  Day4     (2026-04-21):   ${day4.btc.toFixed(0)} BTC  $${(day4.usd/1e6).toFixed(0)}M`);
  console.log(`  Trough   (${troughDate}): ${trough.btc.toFixed(0)} BTC  $${(trough.usd/1e6).toFixed(0)}M`);
  console.log(`  Current  (${currentDate}): ${current.btc.toFixed(0)} BTC  $${(current.usd/1e6).toFixed(0)}M`);

  // Per-chain breakdown for chainBreakdown section
  const chainBreakdown = {};
  for (const [chainName, result] of Object.entries(chainResults)) {
    if (result.status !== 'ok') {
      chainBreakdown[chainName] = { status: result.status, error: result.error, subgraphId: result.subgraphId };
      continue;
    }
    const preCh   = sumChainForDate(result.aggregated, preHackDate);
    const curCh   = sumChainForDate(result.aggregated, currentDate);
    let troughChDate = null, troughChUsd = Infinity;
    for (const date of DATE_RANGE) {
      const s = sumChainForDate(result.aggregated, date);
      if (s.usd > 0 && s.usd < troughChUsd) { troughChUsd = s.usd; troughChDate = date; }
    }
    const troughCh = troughChDate ? sumChainForDate(result.aggregated, troughChDate) : { btc: 0, usd: 0 };
    const dropPct = preCh.usd > 0 ? ((curCh.usd - preCh.usd) / preCh.usd * 100) : 0;

    chainBreakdown[chainName] = {
      status: 'ok',
      subgraphId: result.subgraphId,
      reserves: result.reserves,
      preHackBtc:   parseFloat(preCh.btc.toFixed(4)),
      preHackUsd:   Math.round(preCh.usd),
      troughBtc:    troughChDate ? parseFloat(troughCh.btc.toFixed(4)) : null,
      troughUsd:    troughChDate ? Math.round(troughCh.usd) : null,
      troughDate:   troughChDate,
      currentBtc:   parseFloat(curCh.btc.toFixed(4)),
      currentUsd:   Math.round(curCh.usd),
      dropUsd:      Math.round(curCh.usd - preCh.usd),
      dropBtc:      parseFloat((curCh.btc - preCh.btc).toFixed(4)),
      dropPct:      parseFloat(dropPct.toFixed(1)),
      sharePctOfPre: pre.btc > 0 ? parseFloat((preCh.btc / pre.btc * 100).toFixed(1)) : 0,
    };
  }

  // Build per-chain markets for perMarketSnapshot
  const allMarkets = [];
  for (const [chainName, result] of Object.entries(chainResults)) {
    if (result.status !== 'ok') continue;
    for (const reserve of result.reserves) {
      const daily = result.aggregated[reserve.symbol];
      if (!daily) continue;
      const preSnap    = daily[preHackDate];
      const curSnap    = daily[currentDate];
      if (!preSnap) continue;
      let troughResDate = null, troughResUsd = Infinity;
      for (const date of DATE_RANGE) {
        const d = daily[date];
        if (d && d.deposits_usd > 0 && d.deposits_usd < troughResUsd) { troughResUsd = d.deposits_usd; troughResDate = date; }
      }
      const troughSnap = troughResDate ? daily[troughResDate] : null;
      const dropUsd = (curSnap?.deposits_usd ?? 0) - preSnap.deposits_usd;
      const dropPct = preSnap.deposits_usd > 0 ? (dropUsd / preSnap.deposits_usd * 100) : 0;
      allMarkets.push({
        chain: chainName,
        asset: reserve.symbol,
        underlyingAsset: reserve.underlyingAsset,
        decimals: reserve.decimals,
        isBtc: true,
        preDepositBtc:    parseFloat(preSnap.deposits_btc.toFixed(4)),
        preDepositUsd:    Math.round(preSnap.deposits_usd),
        currentDepositBtc: curSnap ? parseFloat(curSnap.deposits_btc.toFixed(4)) : null,
        currentDepositUsd: curSnap ? Math.round(curSnap.deposits_usd) : null,
        troughDepositBtc:  troughSnap ? parseFloat(troughSnap.deposits_btc.toFixed(4)) : null,
        troughDepositUsd:  troughSnap ? Math.round(troughSnap.deposits_usd) : null,
        troughDate:        troughResDate,
        dropUsd:           curSnap ? Math.round(dropUsd) : null,
        dropPct:           curSnap ? parseFloat(dropPct.toFixed(1)) : null,
        source: 'aave-official-subgraph',
      });
    }
  }
  allMarkets.sort((a, b) => (b.preDepositUsd || 0) - (a.preDepositUsd || 0));

  // Read existing aave.json to preserve Ethereum DefiLlama total TVL data
  let existingData = {};
  const existingPath = join(__dir, '../data/aave.json');
  if (existsSync(existingPath)) {
    existingData = JSON.parse(readFileSync(existingPath, 'utf8'));
  }

  const aaveJson = {
    _meta: {
      protocol: 'Aave v3',
      chains: 'Multichain: Ethereum, Polygon, Arbitrum, Optimism, Avalanche, BNB, Base, Scroll, Gnosis, Linea, Metis',
      event: 'Kelp DAO LayerZero Exploit',
      hackDate: '2026-04-18',
      fetchedAt: new Date().toISOString(),
      dataFreshness: currentDate,
      sources: {
        dailyTimeline: 'DefiLlama API (api.llama.fi/protocol/aave-v3 → chainTvls.Ethereum.tvl) — total Aave v3 Ethereum net TVL',
        perMarket: 'Aave official subgraphs — per-market BTC data Apr 17–27, 2026 (all chains)',
        btcPrice: 'Binance BTCUSDT daily klines (api.binance.com/api/v3/klines)',
        note: 'Multichain BTC-collateral: WBTC, cbBTC, tBTC, LBTC, BTC.b, BTCB, and chain-specific tokens. All from Aave official subgraphs.',
      },
      subgraphIds: Object.fromEntries(CHAINS.map(c => [c.name, c.subgraphId || c.customUrl])),
    },
    keyMetrics: {
      // Keep existing Ethereum DefiLlama total TVL numbers
      preHack:  existingData.keyMetrics?.preHack  || null,
      trough:   existingData.keyMetrics?.trough   || null,
      current:  existingData.keyMetrics?.current  || null,
      btcMarkets: {
        note: 'All BTC-collateral markets across all Aave v3 chains. Source: Aave official subgraphs.',
        preHackBtc:   parseFloat(pre.btc.toFixed(4)),
        preHackUsd:   Math.round(pre.usd),
        preHackDate,
        day4Btc:      parseFloat(day4.btc.toFixed(4)),
        day4Usd:      Math.round(day4.usd),
        troughBtc:    parseFloat(trough.btc.toFixed(4)),
        troughUsd:    Math.round(trough.usd),
        troughDate,
        currentBtc:   parseFloat(current.btc.toFixed(4)),
        currentUsd:   Math.round(current.usd),
        currentDate,
        dropBtc:      parseFloat((current.btc - pre.btc).toFixed(4)),
        dropUsd:      Math.round(current.usd - pre.usd),
        dropPct:      parseFloat(((current.usd - pre.usd) / pre.usd * 100).toFixed(1)),
        source: 'aave-official-subgraph-multichain',
      },
    },
    // Preserve Ethereum-specific daily timeline (DefiLlama + BTC subgraph)
    dailyTimeline: existingData.dailyTimeline || {},
    // New: multichain per-chain breakdown
    chainBreakdown,
    // New: all-chain per-market snapshot
    perMarketSnapshot: {
      snapshotDates: {
        pre: preHackDate, post: currentDate, trough: troughDate,
        note: 'pre=Apr 17 (pre-hack), post=Apr 27 (current), trough=minimum BTC deposits USD day across all chains',
      },
      note: 'All-chain per-market BTC data from Aave official subgraphs. USD = BTC × daily BTC/USD (Binance).',
      markets: allMarkets,
    },
    // Preserved Ethereum per-market (for backwards compat with existing renderAave)
    perMarketSnapshot_ethereum: existingData.perMarketSnapshot || {},
    btcDailyTimeline: existingData.btcDailyTimeline || {},
    highlight_cbBTC: existingData.highlight_cbBTC || null,
    highlight_PYUSD: existingData.highlight_PYUSD || null,
    protocolTvlTimeline: existingData.protocolTvlTimeline || [],
  };

  writeFileSync(DATA_OUT, JSON.stringify(aaveJson, null, 2));
  console.log(`\naave.json written: ${DATA_OUT}`);
  console.log('\n=== Done ===');
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
