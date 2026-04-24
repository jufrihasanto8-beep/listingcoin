import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

// Default avg delay (hari) — akan dioverride oleh data real jika tersedia
const DEFAULT_AVG = { upbit: 60, bithumb: 45 }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 's-maxage=300')

  const { data, error } = await supabase
    .from('exchange_listings')
    .select('exchange, symbol, first_seen')

  if (error) return res.status(500).json({ error: error.message })

  // Group by exchange
  const byEx = {}
  for (const row of data) {
    if (!byEx[row.exchange]) byEx[row.exchange] = {}
    byEx[row.exchange][row.symbol] = new Date(row.first_seen)
  }

  const binance = byEx['binance'] ?? {}
  const now     = new Date()

  // Hitung rata-rata delay dari data real (coin yang ada di Binance DAN Upbit/Bithumb)
  function calcAvgDelay(exchange) {
    const exData = byEx[exchange] ?? {}
    const delays = []
    for (const [sym, binanceDate] of Object.entries(binance)) {
      if (!exData[sym]) continue
      const days = (exData[sym] - binanceDate) / 86400000
      // Hanya masukkan jika ada selisih > 1 hari (bukan data hari yang sama / belum di-seed)
      if (days > 1 && days < 3000) delays.push(days)
    }
    if (delays.length < 5) return null // butuh minimal 5 data poin
    return delays.reduce((s, d) => s + d, 0) / delays.length
  }

  const avgUpbit   = calcAvgDelay('upbit')   ?? DEFAULT_AVG.upbit
  const avgBithumb = calcAvgDelay('bithumb') ?? DEFAULT_AVG.bithumb
  const dataIsReal = calcAvgDelay('upbit') !== null

  // Buat prediction untuk koin yang belum listing di Upbit atau Bithumb
  const upbit   = byEx['upbit']   ?? {}
  const bithumb = byEx['bithumb'] ?? {}

  const predictions = []
  for (const [symbol, binanceDate] of Object.entries(binance)) {
    const onUpbit   = !!upbit[symbol]
    const onBithumb = !!bithumb[symbol]
    if (onUpbit && onBithumb) continue // sudah listing di keduanya

    const daysOnBinance = (now - binanceDate) / 86400000

    const scoreUpbit   = onUpbit   ? null : Math.round((daysOnBinance / avgUpbit)   * 100)
    const scoreBithumb = onBithumb ? null : Math.round((daysOnBinance / avgBithumb) * 100)
    const maxScore     = Math.max(scoreUpbit ?? 0, scoreBithumb ?? 0)

    predictions.push({
      symbol,
      daysOnBinance: Math.round(daysOnBinance),
      binanceSince:  binanceDate.toISOString().split('T')[0],
      onUpbit,
      onBithumb,
      scoreUpbit,
      scoreBithumb,
      maxScore,
    })
  }

  // Sort: score tertinggi dulu (paling "overdue")
  predictions.sort((a, b) => b.maxScore - a.maxScore)

  res.json({
    predictions: predictions.slice(0, 200),
    avgDelays: { upbit: Math.round(avgUpbit), bithumb: Math.round(avgBithumb) },
    dataIsReal,
    total: predictions.length,
  })
}
