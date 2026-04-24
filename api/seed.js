import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const BATCH = 3 // 3 coins per call agar tidak timeout

export default async function handler(req, res) {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const offset = parseInt(req.query.offset ?? '0')

  // 1. Ambil binance coins dari DB (belum di-seed = first_seen sangat baru / < 2 hari)
  const cutoff = new Date(Date.now() - 2 * 86400 * 1000).toISOString()
  const { data: coins, error } = await supabase
    .from('exchange_listings')
    .select('symbol, first_seen')
    .eq('exchange', 'binance')
    .gte('first_seen', cutoff) // hanya yang belum di-seed
    .order('symbol')
    .range(offset, offset + BATCH - 1)

  const { count: total } = await supabase
    .from('exchange_listings')
    .select('*', { count: 'exact', head: true })
    .eq('exchange', 'binance')
    .gte('first_seen', cutoff)

  if (!coins?.length) {
    return res.json({ done: true, message: 'Semua coin sudah di-seed', total: 0 })
  }

  // 2. Ambil coins list dari CoinGecko (untuk mapping symbol → ID)
  let cgList
  try {
    cgList = await fetch('https://api.coingecko.com/api/v3/coins/list', {
      signal: AbortSignal.timeout(8000)
    }).then(r => r.json())
  } catch {
    return res.status(503).json({ error: 'CoinGecko timeout, coba lagi' })
  }

  // Build symbol → [ids] map (ambil yang pertama saja)
  const symbolToId = {}
  for (const coin of cgList) {
    const sym = coin.symbol.toUpperCase()
    if (!symbolToId[sym]) symbolToId[sym] = coin.id // ambil pertama = biasanya yang paling dikenal
  }

  // 3. Fetch first_data_at secara paralel untuk batch ini
  const updates = await Promise.allSettled(
    coins.map(async ({ symbol }) => {
      const cgId = symbolToId[symbol]
      if (!cgId) return { symbol, status: 'not_found' }

      const detail = await fetch(
        `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
        { signal: AbortSignal.timeout(6000) }
      ).then(r => r.json())

      const firstDataAt = detail?.market_data?.first_data_at
      if (!firstDataAt) return { symbol, status: 'no_data' }

      await supabase
        .from('exchange_listings')
        .update({ first_seen: firstDataAt })
        .eq('exchange', 'binance')
        .eq('symbol', symbol)

      return { symbol, firstDataAt, status: 'ok' }
    })
  )

  const processed = updates.map(r => r.value ?? { status: 'error' })
  const nextOffset = offset + BATCH
  const done = nextOffset >= (total ?? 0)

  res.json({ done, nextOffset, processed, remaining: Math.max(0, (total ?? 0) - nextOffset) })
}
