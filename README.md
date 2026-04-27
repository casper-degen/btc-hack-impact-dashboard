# BTC Collateral Impact — Kelp DAO LayerZero Exploit (Apr 18, 2026)

A static, single-page dashboard tracking how the April 2026 Kelp DAO LayerZero exploit affected BTC-collateral positions across three major DeFi lending protocols: **Aave v3**, **Morpho Blue**, and **Spark Protocol (SparkLend)**.

Data is a static snapshot (Apr 17–27, 2026). No backend, no live API calls from the browser — just HTML + pre-fetched JSON files.

## Live Dashboard

**[https://casper-degen.github.io/btc-hack-impact-dashboard/](https://casper-degen.github.io/btc-hack-impact-dashboard/)**

## What Happened

On April 18–19, 2026, the Kelp DAO LayerZero bridge was exploited, causing an rsETH depeg. This triggered cascading liquidations across protocols where rsETH-backed positions had been used to borrow stablecoins against BTC collateral (especially cbBTC). The result: major BTC TVL outflows from Aave and Morpho within 48–72 hours, while Spark (an Aave v3 fork) absorbed inflows as users migrated.

## Dashboard Tabs

| Tab | Key Finding |
|-----|-------------|
| **Aave v3 — Multichain** | 81,863 → 53,876 BTC (−34.2%) across 8 chains. Ethereum net TVL −43.9%. |
| **Morpho Blue — Multichain** | 43,797 → ~41,000 BTC (−6.3%) total. cbBTC/PYUSD market −97.8% in 48h. |
| **Spark Protocol** | 539 → 8,784 BTC (+1530%). Spark was a **net beneficiary** — users migrated from Aave. |

## Data Sources

| Source | Used For | Notes |
|--------|----------|-------|
| Aave official subgraphs (The Graph Network) | Per-market BTC data, all chains | 8 chains with active BTC reserves |
| DefiLlama (`api.llama.fi/protocol/aave-v3`) | Aave total protocol TVL timeline | Ethereum only, all asset types |
| Morpho Blue GraphQL API (`blue-api.morpho.org/graphql`) | All Morpho BTC markets across chains | No API key required |
| Spark Lend subgraph (The Graph, Messari schema) | Spark BTC per-market data | Ethereum mainnet only |
| DefiLlama (`api.llama.fi/protocol/spark`) | Spark protocol-level TVL | |
| Binance BTCUSDT klines | Daily BTC/USD prices | No API key required |

Snapshot window: **2026-04-17 (pre-hack) → 2026-04-27**.

## How to View Locally

The dashboard uses `fetch()` to load data files, so you need a local HTTP server (not `file://`):

```bash
cd btc-hack-impact-dashboard
python3 -m http.server 8765
```

Then open: [http://localhost:8765](http://localhost:8765)

## How to Refresh Data

Data is static. To re-fetch (e.g. for a new date window), run the scripts below:

```bash
# Morpho — no API key needed
node scripts/fetch-morpho.mjs

# Aave multichain — requires The Graph API key
export GRAPH_API_KEY=your_thegraph_key_here
node scripts/fetch-aave-multichain.mjs

# Aave Ethereum-only (legacy, produces same aave.json)
GRAPH_API_KEY=your_thegraph_key_here node scripts/fetch-aave.mjs

# Spark
GRAPH_API_KEY=your_thegraph_key_here node scripts/fetch-spark.mjs
```

Get a free API key at [https://thegraph.com/studio/](https://thegraph.com/studio/). Copy `scripts/.env.example` to understand required variables.

Scripts write directly to `data/*.json`. No intermediate files or caches.

## Caveats

- **Snapshot, not live**: data was fetched on 2026-04-27. `fetch-*.mjs` can regenerate it.
- **Spark was a beneficiary, not a loser**: Spark BTC TVL grew +1530%. The "Impact" tab shows a gain.
- **Morpho trough**: cbBTC/PYUSD on Ethereum lost 97.8% — this was the exploit's epicenter. Total Morpho drop was a more modest ~6%.
- **Aave BTC subset vs total TVL**: the Aave tab shows both the total protocol TVL (DefiLlama, all assets) and the BTC-specific subset (Aave subgraphs). These are different metrics.
- **LBTC on Spark**: first snapshot appears Apr 19 (likely newly listed), so Apr 17 pre-hack baseline for LBTC is zero.
- **Prices**: BTC/USD from Binance daily close prices. USD figures vary with price.

## Project Structure

```
btc-hack-impact-dashboard/
├── index.html                     # Single-page dashboard (pure HTML+CSS+JS, no build step)
├── data/
│   ├── aave.json                  # Aave v3 multichain BTC snapshot
│   ├── morpho.json                # Morpho Blue BTC snapshot
│   └── spark.json                 # Spark Protocol BTC snapshot
├── scripts/
│   ├── fetch-aave-multichain.mjs  # Aave data refresh (all chains, needs GRAPH_API_KEY)
│   ├── fetch-aave.mjs             # Aave Ethereum-only refresh
│   ├── fetch-morpho.mjs           # Morpho refresh (no key needed)
│   ├── fetch-spark.mjs            # Spark refresh (needs GRAPH_API_KEY)
│   └── .env.example               # Required env variable reference
├── .gitignore
├── LICENSE                        # MIT
└── README.md
```

## Deploy to GitHub Pages

```bash
cd /path/to/btc-hack-impact-dashboard
git init -b main
git add .
git commit -m "Initial commit: BTC hack impact dashboard"
git remote add origin <your-github-repo-url>
git push -u origin main
```

Then enable GitHub Pages in repo Settings → Pages → Source: Deploy from branch `main`, folder `/` (root).

## License

MIT — see [LICENSE](LICENSE).
