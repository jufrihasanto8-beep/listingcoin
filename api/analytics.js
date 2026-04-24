import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

const OTHERS = ['upbit', 'bithumb', 'okx', 'bybit', 'kucoin']
const LABELS = { upbit: 'Upbit', bithumb: 'Bithumb', okx: 'OKX', bybit: 'Bybit', kucoin: 'KuCoin' }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 's-maxage=300')

  const { data, error } = await supabase
    .from('exchange_listings')
    .select('exchange, symbol, first_seen')

  if (error) return res.status(500).json({ error: error.message })

  // Group by exchange → { symbol: Date }
  const byEx = {}
  for (const row of data) {
    if (!byEx[row.exchange]) byEx[row.exchange] = {}
    byEx[row.exchange][row.symbol] = new Date(row.first_seen)
  }

  const binance = byEx['binance'] ?? {}
  const trackedSince = Object.values(binance).sort((a, b) => a - b)[0] ?? null

  const stats = {}

  for (const ex of OTHERS) {
    const exData = byEx[ex] ?? {}
    const paired = [] // coins listed on both Binance and this exchange

    for (const [symbol, binanceDate] of Object.entries(binance)) {
      if (!exData[symbol]) continue
      const days = (exData[symbol] - binanceDate) / 86400000
      paired.push({ symbol, days: Math.round(days) })
    }

    // Listed before or same day as Binance (days <= 0) → already listed
    const alreadyListed  = paired.filter(p => p.days <= 0).length
    const listedAfter    = paired.filter(p => p.days > 0)
    const notListed      = Object.keys(binance).length - paired.length

    const avgDays = listedAfter.length
      ? Math.round(listedAfter.reduce((s, p) => s + p.days, 0) / listedAfter.length)
      : null

    const fastest = [...listedAfter].sort((a, b) => a.days - b.days).slice(0, 10)
    const slowest = [...listedAfter].sort((a, b) => b.days - a.days).slice(0, 10)

    // Bucket distribution: 0-7d, 7-30d, 30-90d, 90d+
    const buckets = { '0-7d': 0, '7-30d': 0, '30-90d': 0, '90d+': 0 }
    for (const p of listedAfter) {
      if (p.days <= 7)       buckets['0-7d']++
      else if (p.days <= 30) buckets['7-30d']++
      else if (p.days <= 90) buckets['30-90d']++
      else                   buckets['90d+']++
    }

    stats[ex] = {
      label:         LABELS[ex],
      totalBinance:  Object.keys(binance).length,
      alreadyListed,
      listedAfterCount: listedAfter.length,
      notListed,
      coveragePct:   Math.round((paired.length / Math.max(Object.keys(binance).length, 1)) * 100),
      avgDays,
      fastest,
      slowest,
      buckets,
    }
  }

  res.json({ stats, trackedSince })
}
