import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

const EXCHANGES = ['binance', 'upbit', 'bithumb', 'okx', 'bybit', 'kucoin']

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 's-maxage=300') // Vercel edge cache 5 min

  const { data, error } = await supabase
    .from('exchange_listings')
    .select('exchange, symbol, updated_at')

  if (error) return res.status(500).json({ error: error.message })
  if (!data?.length) return res.json({ coins: [], exchanges: EXCHANGES.slice(1), lastUpdated: null })

  // Group by exchange
  const byExchange = Object.fromEntries(EXCHANGES.map(e => [e, new Set()]))
  for (const row of data) {
    byExchange[row.exchange]?.add(row.symbol)
  }

  const lastUpdated = data[0].updated_at

  // Build per-coin comparison (only Binance coins)
  const others = EXCHANGES.filter(e => e !== 'binance')
  const coins  = [...byExchange.binance].sort().map(symbol => {
    const row = { symbol }
    let missing = 0
    for (const ex of others) {
      row[ex] = byExchange[ex].has(symbol)
      if (!row[ex]) missing++
    }
    row.missing = missing
    return row
  })

  // Sort: most missing first, then alphabetical
  coins.sort((a, b) => b.missing - a.missing || a.symbol.localeCompare(b.symbol))

  res.json({ coins, exchanges: others, lastUpdated, total: coins.length })
}
