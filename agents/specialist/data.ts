// Market and project facts for one token, each tied to the URL it came from.
// Source: CoinGecko's public API (no key). Unknown fields stay null; nothing is guessed.
const API = "https://api.coingecko.com/api/v3";

export interface TokenProfile {
  found: true;
  query: string;
  coingeckoId: string;
  name: string;
  symbol: string;
  marketCapRank: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fullyDilutedValuationUsd: number | null;
  volume24hUsd: number | null;
  priceChangePct: { "24h": number | null; "7d": number | null; "30d": number | null; "1y": number | null };
  allTimeHighUsd: number | null;
  belowAllTimeHighPct: number | null;
  supply: { circulating: number | null; total: number | null; max: number | null };
  genesisDate: string | null;
  categories: string[];
  chains: Record<string, string>;
  links: { homepage: string[]; github: string[]; whitepaper: string | null; twitter: string | null };
  developer: { stars: number | null; forks: number | null; commitsLast4Weeks: number | null } | null;
  otherMatches: { id: string; name: string; symbol: string }[];
  retrievedAt: string;
  sources: string[];
}

export interface NotFound {
  found: false;
  query: string;
  retrievedAt: string;
  sources: string[];
}

async function get(url: string): Promise<any> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Data source returned HTTP ${response.status}`);
  return response.json();
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export async function lookupToken(query: string): Promise<TokenProfile | NotFound> {
  const retrievedAt = new Date().toISOString();
  const searchUrl = `${API}/search?query=${encodeURIComponent(query)}`;
  const search = await get(searchUrl);
  const coins: any[] = Array.isArray(search.coins) ? search.coins : [];
  if (!coins.length) return { found: false, query, retrievedAt, sources: [searchUrl] };

  // Prefer an exact symbol or name match; otherwise CoinGecko's top-ranked result.
  const q = query.trim().toLowerCase();
  const pick = coins.find(c => c.symbol?.toLowerCase() === q || c.name?.toLowerCase() === q) ?? coins[0];
  const coinUrl = `${API}/coins/${encodeURIComponent(pick.id)}?localization=false&tickers=false&community_data=false&developer_data=true&sparkline=false`;
  const coin = await get(coinUrl);
  const m = coin.market_data ?? {};
  const dev = coin.developer_data;

  return {
    found: true,
    query,
    coingeckoId: coin.id,
    name: coin.name,
    symbol: String(coin.symbol ?? "").toUpperCase(),
    marketCapRank: num(coin.market_cap_rank),
    priceUsd: num(m.current_price?.usd),
    marketCapUsd: num(m.market_cap?.usd),
    fullyDilutedValuationUsd: num(m.fully_diluted_valuation?.usd),
    volume24hUsd: num(m.total_volume?.usd),
    priceChangePct: {
      "24h": num(m.price_change_percentage_24h),
      "7d": num(m.price_change_percentage_7d),
      "30d": num(m.price_change_percentage_30d),
      "1y": num(m.price_change_percentage_1y),
    },
    allTimeHighUsd: num(m.ath?.usd),
    belowAllTimeHighPct: num(m.ath_change_percentage?.usd),
    supply: { circulating: num(m.circulating_supply), total: num(m.total_supply), max: num(m.max_supply) },
    genesisDate: coin.genesis_date ?? null,
    categories: (coin.categories ?? []).filter(Boolean),
    chains: Object.fromEntries(Object.entries(coin.platforms ?? {}).filter(([chain, address]) => chain && address)) as Record<string, string>,
    links: {
      homepage: (coin.links?.homepage ?? []).filter(Boolean),
      github: (coin.links?.repos_url?.github ?? []).filter(Boolean),
      whitepaper: coin.links?.whitepaper || null,
      twitter: coin.links?.twitter_screen_name ? `https://x.com/${coin.links.twitter_screen_name}` : null,
    },
    developer: dev
      ? { stars: num(dev.stars), forks: num(dev.forks), commitsLast4Weeks: num(dev.commit_count_4_weeks) }
      : null,
    otherMatches: coins
      .filter(c => c.id !== pick.id)
      .slice(0, 4)
      .map(c => ({ id: c.id, name: c.name, symbol: c.symbol })),
    retrievedAt,
    sources: [`https://www.coingecko.com/en/coins/${coin.id}`, coinUrl],
  };
}
