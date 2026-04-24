import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── Exchange fetchers ────────────────────────────────────────────────────────

async function fetchBinance() {
  // Try multiple endpoints — Binance blocks some cloud provider IPs
  const hosts = [
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://api4.binance.com',
  ]
  for (const host of hosts) {
    try {
      const res  = await fetch(`${host}/api/v3/exchangeInfo`, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) continue
      const data = await res.json()
      const coins = new Set()
      for (const s of data.symbols) {
        if (s.status === 'TRADING' && s.quoteAsset === 'USDT') {
          coins.add(s.baseAsset.toUpperCase())
        }
      }
      if (coins.size > 0) return [...coins]
    } catch (e) {
      console.error(`Binance ${host} failed:`, e.message)
    }
  }
  return []
}

async function fetchUpbit() {
  const res = await fetch('https://api.upbit.com/v1/market/all', {
    headers: { Accept: 'application/json' }
  })
  const data = await res.json()
  const coins = new Set()
  for (const m of data) {
    // market format: "KRW-BTC", "BTC-ETH"
    const [, base] = m.market.split('-')
    if (base) coins.add(base.toUpperCase())
  }
  return [...coins]
}

async function fetchBithumb() {
  const res = await fetch('https://api.bithumb.com/public/ticker/ALL_KRW')
  const data = await res.json()
  if (data.status !== '0000') return []
  return Object.keys(data.data)
    .filter(k => k !== 'date')
    .map(k => k.toUpperCase())
}

async function fetchOKX() {
  const res = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT')
  const data = await res.json()
  const coins = new Set()
  for (const inst of data.data ?? []) {
    coins.add(inst.baseCcy.toUpperCase())
  }
  return [...coins]
}

async function fetchBybit() {
  // Bybit paginates — loop until no nextPageCursor
  const coins  = new Set()
  let cursor   = ''
  let attempts = 0
  while (attempts++ < 10) {
    const url = `https://api.bybit.com/v5/market/instruments-info?category=spot&limit=500${cursor ? '&cursor=' + cursor : ''}`
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const data = await res.json()
    for (const inst of data.result?.list ?? []) {
      coins.add(inst.baseCoin.toUpperCase())
    }
    cursor = data.result?.nextPageCursor ?? ''
    if (!cursor) break
  }
  return [...coins]
}

async function fetchKucoin() {
  const res = await fetch('https://api.kucoin.com/api/v1/symbols')
  const data = await res.json()
  const coins = new Set()
  for (const s of data.data ?? []) {
    coins.add(s.baseCurrency.toUpperCase())
  }
  return [...coins]
}

// ── Main handler ─────────────────────────────────────────────────────────────

const FETCHERS = {
  binance: fetchBinance,
  upbit:   fetchUpbit,
  bithumb: fetchBithumb,
  okx:     fetchOKX,
  bybit:   fetchBybit,
  kucoin:  fetchKucoin,
}

export default async function handler(req, res) {
  // Protect endpoint: Vercel cron sends x-vercel-cron-signature, manual call needs secret
  const isVercelCron = req.headers['x-vercel-cron-signature'] !== undefined
  const isManual     = req.query.secret === process.env.CRON_SECRET

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const counts = {}
  const rows   = []
  const now    = new Date().toISOString()

  await Promise.allSettled(
    Object.entries(FETCHERS).map(async ([exchange, fn]) => {
      try {
        const coins = await fn()
        counts[exchange] = coins.length
        for (const symbol of coins) {
          rows.push({ exchange, symbol, updated_at: now })
        }
      } catch (err) {
        console.error(`[${exchange}]`, err.message)
        counts[exchange] = 0
      }
    })
  )

  // Upsert in chunks of 500
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('exchange_listings')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'exchange,symbol' })
    if (error) console.error('upsert error:', error.message)
  }

  // Clean up coins no longer listed (updated_at is stale)
  await supabase
    .from('exchange_listings')
    .delete()
    .lt('updated_at', now)

  res.json({ ok: true, counts, total: rows.length })
}
