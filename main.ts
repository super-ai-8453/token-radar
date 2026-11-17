/**
 * token-radar — fetch fresh Solana pairs from DexScreener, score them, and
 * publish the results as JSON plus a static HTML dashboard.
 *
 * make.fun program/v1 harness protocol:
 *   - HTTP server on an OS-assigned ephemeral port (listen(0), never hardcoded)
 *   - on listen: POST {"port": N} to MAKEFUN_ENV_URL + "/register"
 *   - GET /healthz      -> 200 {"ok":true}
 *   - GET /             -> dashboard HTML
 *   - GET /signals.json -> the radar report JSON
 *   - background refresh every 60s; last good data kept on fetch failure
 *   - long-poll MAKEFUN_ENV_URL + "/done"; process.exit(0) when it returns
 *   - MAKEFUN_ENV_URL unset: still listen, log "registration skipped"
 *
 * Node 22, TypeScript (type stripping), Node builtins only.
 * Run with: npm start
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = join(ROOT, "out");
const STATIC_DIR = join(ROOT, "static");

const PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
const BOOSTS_URL = "https://api.dexscreener.com/token-boosts/latest/v1";
const TOKEN_PAIRS_URL = "https://api.dexscreener.com/latest/dex/tokens";
const TARGET_CHAIN = "solana";
const MAX_TOKENS_PER_REQUEST = 30;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_LIQUIDITY_USD = 20_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TOP_N = 20;
const REFRESH_INTERVAL_MS = 60_000;
const REGISTER_ATTEMPTS = 5;
const REGISTER_RETRY_DELAY_MS = 2_000;
const DONE_POLL_TIMEOUT_MS = 5 * 60_000;
const DONE_RETRY_DELAY_MS = 5_000;

/** Score weights; each component is log-normalised to 0-100 first. */
const WEIGHTS = { liquidity: 0.3, volume: 0.4, txns: 0.3 } as const;

/** Reference ranges for the log scales: values outside clamp to 0 or 100. */
const RANGE = {
  liquidity: { min: 20_000, max: 5_000_000 },
  volume: { min: 50_000, max: 50_000_000 },
  txns: { min: 20, max: 5_000 },
} as const;

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  url?: string;
  priceUsd?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  liquidity?: { usd?: number };
  fdv?: number;
  pairCreatedAt?: number;
  baseToken?: { name?: string; symbol?: string; address?: string };
  quoteToken?: { symbol?: string };
}

interface ScoreBreakdown {
  liquidity: number;
  volume: number;
  txns: number;
}

interface Signal {
  rank: number;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  baseToken: { symbol: string; name: string; address: string | null };
  quoteToken: string;
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  priceUsd: number | null;
  priceChange24h: number | null;
  liquidityUsd: number;
  volume24h: number;
  txns24h: { buys: number; sells: number; total: number };
  fdv: number | null;
  pairCreatedAt: number;
  ageMinutes: number;
}

interface RadarReport {
  generatedAt: string;
  chain: string;
  sources: string[];
  filters: { minLiquidityUsd: number; maxAgeHours: number };
  tokensDiscovered: number;
  count: number;
  signals: Signal[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Coerce API numbers (occasionally strings) to a finite number, else 0. */
function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Like num(), but preserves "missing" as null instead of 0. */
function optionalNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Log-scale a value between min and max into 0..1, clamped. */
function logScale(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const span = Math.log10(max) - Math.log10(min);
  if (span <= 0) return 0;
  const clamped = Math.min(Math.max(value, min), max);
  return (Math.log10(clamped) - Math.log10(min)) / span;
}

function scorePair(
  liquidity: number,
  volume: number,
  txns: number,
): { score: number; breakdown: ScoreBreakdown } {
  const liquidityScore = logScale(liquidity, RANGE.liquidity.min, RANGE.liquidity.max) * 100;
  const volumeScore = logScale(volume, RANGE.volume.min, RANGE.volume.max) * 100;
  const txnsScore = logScale(txns, RANGE.txns.min, RANGE.txns.max) * 100;

  const raw =
    WEIGHTS.liquidity * liquidityScore +
    WEIGHTS.volume * volumeScore +
    WEIGHTS.txns * txnsScore;

  return {
    score: Math.min(100, Math.max(0, round1(raw))),
    breakdown: {
      liquidity: round1(liquidityScore),
      volume: round1(volumeScore),
      txns: round1(txnsScore),
    },
  };
}

function trimZeros(value: number): string {
  const decimals = Math.abs(value) >= 100 ? 0 : 1;
  return value.toFixed(decimals).replace(/\.0$/, "");
}

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [threshold, suffix] of units) {
    if (abs >= threshold) return `${trimZeros(value / threshold)}${suffix}`;
  }
  return trimZeros(value);
}

function formatUsd(value: number): string {
  return `$${compactNumber(value)}`;
}

function formatPrice(price: number | null): string {
  if (price === null || !Number.isFinite(price) || price <= 0) return "—";
  if (price >= 1) {
    return `$${price.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  }
  const exponent = Math.floor(Math.log10(price));
  const decimals = Math.min(Math.abs(exponent) + 4, 12);
  const fixed = price.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  if (fixed === "0") {
    return `$${price.toExponential(2)}`;
  }
  return `$${fixed}`;
}

function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m old` : `${hours}h old`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h old`;
}

function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function scoreTone(score: number): "high" | "mid" | "low" {
  if (score >= 75) return "high";
  if (score >= 50) return "mid";
  return "low";
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }

  return await response.json();
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Pull the most recently profiled / boosted Solana token addresses from the
 * DexScreener discovery endpoints. Either endpoint may fail independently;
 * failures are collected as warnings and simply contribute no tokens.
 */
async function fetchDiscoveredTokens(): Promise<{ tokens: string[]; warnings: string[] }> {
  const results = await Promise.allSettled([
    fetchJson(PROFILES_URL),
    fetchJson(BOOSTS_URL),
  ]);

  const warnings: string[] = [];
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const url = i === 0 ? PROFILES_URL : BOOSTS_URL;

    if (result.status === "rejected") {
      warnings.push(`${url}: ${errorMessage(result.reason)}`);
      continue;
    }

    if (!Array.isArray(result.value)) continue;

    for (const entry of result.value) {
      if (!isRecord(entry)) continue;
      if (cleanText(entry.chainId).toLowerCase() !== TARGET_CHAIN) continue;
      const address = cleanText(entry.tokenAddress);
      if (address === "" || seen.has(address)) continue;
      seen.add(address);
      tokens.push(address);
    }
  }

  return { tokens, warnings };
}

function toPairs(payload: unknown): DexPair[] {
  const rawPairs = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.pairs)
      ? payload.pairs
      : [];

  const pairs: DexPair[] = [];
  for (const raw of rawPairs) {
    if (!isRecord(raw)) continue;
    if (typeof raw.pairAddress !== "string" || raw.pairAddress === "") continue;
    if (cleanText(raw.chainId).toLowerCase() !== TARGET_CHAIN) continue;
    pairs.push(raw as unknown as DexPair);
  }
  return pairs;
}

/** Resolve up to 30 token addresses per request into their trading pairs. */
async function fetchPairs(tokens: readonly string[]): Promise<DexPair[]> {
  if (tokens.length === 0) return [];

  const batches = chunk(tokens, MAX_TOKENS_PER_REQUEST);
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const url = `${TOKEN_PAIRS_URL}/${batch.join(",")}`;
      return toPairs(await fetchJson(url));
    }),
  );

  const pairs: DexPair[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === "rejected") {
      const url = `${TOKEN_PAIRS_URL}/${batches[i].slice(0, 3).join(",")}…`;
      console.error(`warning: could not fetch ${url}: ${errorMessage(result.reason)}`);
      continue;
    }
    pairs.push(...result.value);
  }
  return pairs;
}

function dexUrl(pair: DexPair, symbol: string): string {
  const raw = pair.url;
  if (typeof raw === "string" && raw.startsWith("https://dexscreener.com/")) {
    return raw;
  }
  if (pair.pairAddress && pair.chainId) {
    return `https://dexscreener.com/${encodeURIComponent(pair.chainId)}/${encodeURIComponent(pair.pairAddress)}`;
  }
  return `https://dexscreener.com/search?q=${encodeURIComponent(symbol)}`;
}

function compareSignals(a: Signal, b: Signal): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
  if (a.ageMinutes !== b.ageMinutes) return a.ageMinutes - b.ageMinutes;
  return a.baseToken.symbol.localeCompare(b.baseToken.symbol);
}

function buildSignals(pairs: readonly DexPair[], now: number): Signal[] {
  const seen = new Set<string>();
  const signals: Signal[] = [];

  for (const pair of pairs) {
    if (!isRecord(pair)) continue;

    const liquidity = num(pair.liquidity?.usd);
    if (liquidity < MIN_LIQUIDITY_USD) continue;

    const createdAt = num(pair.pairCreatedAt);
    const ageMs = createdAt > 0 ? now - createdAt : Number.POSITIVE_INFINITY;
    if (ageMs < 0 || ageMs > MAX_AGE_MS) continue;

    const pairAddress = pair.pairAddress ?? "";
    const chainId = cleanText(pair.chainId) || "unknown";
    const key = `${chainId}:${pairAddress}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const baseSymbol = cleanText(pair.baseToken?.symbol);
    const baseName = cleanText(pair.baseToken?.name);
    const symbol = baseSymbol || baseName || "UNKNOWN";
    const name = baseName || symbol;
    const baseAddress = cleanText(pair.baseToken?.address);
    const dexId = cleanText(pair.dexId) || "unknown";
    const volume24h = num(pair.volume?.h24);
    const buys = num(pair.txns?.h24?.buys);
    const sells = num(pair.txns?.h24?.sells);
    const { score, breakdown } = scorePair(liquidity, volume24h, buys + sells);

    signals.push({
      rank: 0,
      score,
      scoreBreakdown: breakdown,
      baseToken: {
        symbol,
        name,
        address: baseAddress || null,
      },
      quoteToken: cleanText(pair.quoteToken?.symbol) || "—",
      chainId,
      dexId,
      pairAddress,
      url: dexUrl(pair, symbol),
      priceUsd: optionalNum(pair.priceUsd),
      priceChange24h: optionalNum(pair.priceChange?.h24),
      liquidityUsd: liquidity,
      volume24h,
      txns24h: { buys, sells, total: buys + sells },
      fdv: optionalNum(pair.fdv),
      pairCreatedAt: createdAt,
      ageMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
    });
  }

  signals.sort(compareSignals);
  return signals.map((signal, index) => ({ ...signal, rank: index + 1 }));
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderCard(signal: Signal): string {
  const tone = scoreTone(signal.score);
  const change =
    signal.priceChange24h === null
      ? "—"
      : `${signal.priceChange24h >= 0 ? "+" : ""}${signal.priceChange24h.toFixed(1)}%`;
  const changeClass =
    signal.priceChange24h === null ? "" : signal.priceChange24h >= 0 ? "up" : "down";

  return `<article class="card">
  <div class="card-top">
    <div class="identity">
      <span class="rank">#${signal.rank}</span>
      <div class="identity-text">
        <h2 class="symbol">${esc(signal.baseToken.symbol)}</h2>
        <p class="name">${esc(signal.baseToken.name)}</p>
      </div>
    </div>
    <div class="score-wrap">
      <span class="score score-${tone}">${signal.score.toFixed(1)}</span>
      <span class="score-label">score / 100</span>
    </div>
  </div>

  <div class="score-bar" role="img" aria-label="Score ${signal.score.toFixed(1)} out of 100">
    <span class="fill-${tone}" style="width:${signal.score}%"></span>
  </div>

  <div class="chips">
    <span class="chip">${esc(signal.chainId)}</span>
    <span class="chip">${esc(signal.dexId)}</span>
    <span class="chip">${esc(formatAge(signal.ageMinutes))}</span>
  </div>

  <dl class="stats">
    <div><dt>Price</dt><dd>${formatPrice(signal.priceUsd)}</dd></div>
    <div><dt>24h</dt><dd class="${changeClass}">${change}</dd></div>
    <div><dt>Liquidity</dt><dd>${formatUsd(signal.liquidityUsd)}</dd></div>
    <div><dt>Volume 24h</dt><dd>${formatUsd(signal.volume24h)}</dd></div>
    <div><dt>Trades 24h</dt><dd>${compactNumber(signal.txns24h.total)}</dd></div>
    <div><dt>FDV</dt><dd>${signal.fdv === null ? "—" : formatUsd(signal.fdv)}</dd></div>
  </dl>

  <p class="txns"><span class="buy">${compactNumber(signal.txns24h.buys)} buys</span><span class="sell">${compactNumber(signal.txns24h.sells)} sells</span></p>

  <a class="link" href="${esc(signal.url)}" target="_blank" rel="noopener noreferrer">View on DEX Screener ↗</a>
</article>`;
}

function renderPage(report: RadarReport, top: Signal[]): string {
  const generatedLabel = formatTimestamp(report.generatedAt);
  const shown = top.length;
  const summary =
    shown > 0
      ? `Generated ${generatedLabel} · ${report.count} ${report.count === 1 ? "signal" : "signals"} · showing top ${shown}`
      : `Generated ${generatedLabel} · no signals matched`;
  const cards = top.length > 0 ? top.map(renderCard).join("\n") : "";

  const body =
    shown > 0
      ? `<section class="grid" aria-label="Top signals">${cards}</section>`
      : `<section class="empty" role="status">
  <h2>No signals this run</h2>
  <p>No pairs matched the filters — either the API returned nothing fresh enough, or the request failed. Check the console for a warning and try again shortly.</p>
</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Radar — fresh SOL launches</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0e13;
    --panel: #121a24;
    --panel-deep: #0e141c;
    --border: #223042;
    --text: #e7eef7;
    --muted: #8fa1b7;
    --accent: #38bdf8;
    --high: #4ade80;
    --mid: #fbbf24;
    --low: #64748b;
    --up: #4ade80;
    --down: #f87171;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(1100px 520px at 15% -10%, #12263a 0%, transparent 65%),
      var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    line-height: 1.5;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 40px 20px 64px; }
  .eyebrow {
    margin: 0 0 8px;
    color: var(--accent);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  h1 { margin: 0; font-size: clamp(1.9rem, 4vw, 2.8rem); letter-spacing: -0.02em; line-height: 1.1; }
  .lede { max-width: 66ch; margin: 12px 0 0; color: var(--muted); }
  .meta { margin: 16px 0 0; color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
    gap: 18px;
    margin-top: 32px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: linear-gradient(180deg, var(--panel) 0%, var(--panel-deep) 100%);
    transition: border-color 0.2s ease, transform 0.2s ease;
  }
  .card:hover { border-color: #35506e; transform: translateY(-2px); }
  .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .identity { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
  .rank { color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; padding-top: 2px; }
  .identity-text { min-width: 0; }
  .symbol { margin: 0; font-size: 1.15rem; line-height: 1.2; overflow-wrap: anywhere; }
  .name { margin: 2px 0 0; color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
  .score-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: none; }
  .score {
    display: inline-flex;
    align-items: baseline;
    justify-content: center;
    min-width: 58px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 1.05rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .score-label { color: var(--muted); font-size: 0.65rem; letter-spacing: 0.04em; text-transform: uppercase; }
  .score-high { color: #052e16; background: var(--high); }
  .score-mid { color: #3b2600; background: var(--mid); }
  .score-low { color: #e2e8f0; background: var(--low); }
  .score-bar { height: 6px; overflow: hidden; border-radius: 999px; background: #1c2634; }
  .score-bar > span { display: block; height: 100%; border-radius: 999px; }
  .fill-high { background: linear-gradient(90deg, #16a34a, var(--high)); }
  .fill-mid { background: linear-gradient(90deg, #d97706, var(--mid)); }
  .fill-low { background: linear-gradient(90deg, #475569, #94a3b8); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    font-size: 0.72rem;
  }
  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 14px;
    margin: 0;
  }
  .stats > div { min-width: 0; }
  .stats dt {
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .stats dd {
    margin: 2px 0 0;
    font-size: 0.92rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .up { color: var(--up); }
  .down { color: var(--down); }
  .txns { display: flex; gap: 14px; margin: 0; font-size: 0.82rem; font-variant-numeric: tabular-nums; }
  .txns .buy { color: var(--up); }
  .txns .sell { color: var(--down); }
  .link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top: auto;
    padding: 9px 14px;
    border: 1px solid #2b3d54;
    border-radius: 10px;
    color: #cfe3ff;
    font-size: 0.85rem;
    font-weight: 600;
    text-decoration: none;
  }
  .link:hover { border-color: #3d5a7d; background: rgba(22, 35, 51, 0.6); }
  .link:focus-visible, .card:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
  .empty {
    margin-top: 32px;
    padding: 40px 24px;
    border: 1px dashed var(--border);
    border-radius: 16px;
    text-align: center;
    color: var(--muted);
  }
  .empty h2 { margin: 0 0 8px; color: var(--text); font-size: 1.2rem; }
  .empty p { margin: 0 auto; max-width: 52ch; }
  .foot { margin-top: 40px; color: var(--muted); font-size: 0.76rem; }
  @media (prefers-reduced-motion: reduce) {
    .card { transition: none; }
    .card:hover { transform: none; }
  }
</style>
</head>
<body>
<main class="wrap">
  <header class="hero">
    <p class="eyebrow">Token Radar</p>
    <h1>Fresh SOL launches, ranked</h1>
    <p class="lede">Pairs created in the last 24 hours with at least $20,000 in liquidity. Each signal is scored 0–100 from liquidity (30%), 24h volume (40%), and 24h trade count (30%), each on a log scale.</p>
    <p class="meta">${esc(summary)}</p>
  </header>
${body}
  <footer class="foot">Data: DexScreener latest token profiles &amp; boosts, resolved to pairs. Scores are a heuristic ranking aid, not financial advice.</footer>
</main>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* Radar state                                                         */
/* ------------------------------------------------------------------ */

interface RadarState {
  report: RadarReport;
  html: string;
  json: string;
}

/**
 * Latest radar output. Served by GET / and GET /signals.json, and written to
 * static/index.html and out/signals.json on every successful refresh.
 */
let radarState: RadarState = buildRadarState([], [], Date.now());

/** True once at least one fetch pass has completed without throwing. */
let hasGoodData = false;

function buildRadarState(
  tokens: readonly string[],
  pairs: readonly DexPair[],
  now: number,
): RadarState {
  const signals = buildSignals(pairs, now);
  const top = signals.slice(0, TOP_N);

  const report: RadarReport = {
    generatedAt: new Date(now).toISOString(),
    chain: TARGET_CHAIN,
    sources: [PROFILES_URL, BOOSTS_URL, TOKEN_PAIRS_URL],
    filters: {
      minLiquidityUsd: MIN_LIQUIDITY_USD,
      maxAgeHours: MAX_AGE_MS / 3_600_000,
    },
    tokensDiscovered: tokens.length,
    count: signals.length,
    signals,
  };

  return {
    report,
    html: renderPage(report, top),
    json: `${JSON.stringify(report, null, 2)}\n`,
  };
}

/**
 * Run one radar pass and publish the artefacts. If a fetch fails and we
 * already hold good data, the previous state is kept untouched.
 */
async function refreshRadar(): Promise<void> {
  const now = Date.now();

  let tokens: string[] = [];
  let pairs: DexPair[] = [];
  let fetchFailed = false;

  try {
    const discovered = await fetchDiscoveredTokens();
    tokens = discovered.tokens;
    for (const warning of discovered.warnings) {
      console.error(`warning: ${warning}`);
    }
    pairs = await fetchPairs(tokens);
  } catch (error) {
    // Graceful: keep the last good data (or publish an empty report on the
    // very first pass) rather than crashing.
    fetchFailed = true;
    console.error(`warning: radar fetch failed: ${errorMessage(error)}`);
  }

  if (fetchFailed && hasGoodData) {
    console.error("warning: radar fetch failed; keeping last good data");
    return;
  }

  radarState = buildRadarState(tokens, pairs, now);
  hasGoodData = true;

  await Promise.all([
    mkdir(OUT_DIR, { recursive: true }),
    mkdir(STATIC_DIR, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(join(OUT_DIR, "signals.json"), radarState.json, "utf8"),
    writeFile(join(STATIC_DIR, "index.html"), radarState.html, "utf8"),
  ]);

  console.log(`tokens discovered: ${tokens.length}`);
  console.log(`signals: ${radarState.report.count}`);
}

/* ------------------------------------------------------------------ */
/* Harness protocol                                                    */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** POST {"port": <port>} to MAKEFUN_ENV_URL + "/register". */
async function registerWithHarness(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl.replace(/\/+$/, "")}/register`;

  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }

      console.log(`registered with ${url} (HTTP ${response.status})`);
      return;
    } catch (error) {
      console.error(`warning: registration attempt ${attempt} failed: ${errorMessage(error)}`);
      if (attempt < REGISTER_ATTEMPTS) {
        await sleep(REGISTER_RETRY_DELAY_MS);
      }
    }
  }
}

/** Long-poll MAKEFUN_ENV_URL + "/done" and exit 0 once it returns. */
async function waitForDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/+$/, "")}/done`;

  for (;;) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(DONE_POLL_TIMEOUT_MS),
      });
      console.log(`/done returned HTTP ${response.status}; exiting`);
      process.exit(0);
    } catch (error) {
      console.error(`warning: /done poll failed: ${errorMessage(error)}`);
      await sleep(DONE_RETRY_DELAY_MS);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  // First pass plus a background refresh every 60s; failures keep the last
  // good data.
  void refreshRadar();
  setInterval(() => {
    void refreshRadar();
  }, REFRESH_INTERVAL_MS);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = (request.method ?? "GET").toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("method not allowed");
      return;
    }

    switch (url.pathname) {
      case "/healthz": {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end('{"ok":true}');
        return;
      }
      case "/": {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(radarState.html);
        return;
      }
      case "/signals.json": {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(radarState.json);
        return;
      }
      default: {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
      }
    }
  });

  // Let the OS pick a free port; never hardcode one.
  server.listen(0, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    console.log(`token-radar listening on port ${port}`);

    const envUrl = process.env.MAKEFUN_ENV_URL;
    if (envUrl === undefined || envUrl.trim() === "") {
      console.log("registration skipped");
      return;
    }

    void registerWithHarness(envUrl, port);
    void waitForDone(envUrl);
  });
}

main().catch((error: unknown) => {
  console.error(`fatal: ${errorMessage(error)}`);
  process.exitCode = 1;
});