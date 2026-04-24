import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── Exchange fetchers ────────────────────────────────────────────────────────

async function fetchBinance() {
  // ticker/price is much smaller than exchangeInfo, less likely to be blocked
  const hosts = [
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://data.binance.com',
  ]
  for (const host of hosts) {
    try {
      const res = await fetch(`${host}/api/v3/ticker/price`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const data = await res.json()
      const coins = new Set()
      for (const item of data) {
        if (item.symbol.endsWith('USDT')) {
          coins.add(item.symbol.slice(0, -4))
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
  // tickers endpoint returns all in one call, no pagination needed
  const hosts = [
    'https://api.bybit.com',
    'https://api.bytick.com',
  ]
  for (const host of hosts) {
    try {
      const res  = await fetch(`${host}/v5/market/tickers?category=spot`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const data = await res.json()
      const coins = new Set()
      for (const t of data.result?.list ?? []) {
        if (t.symbol.endsWith('USDT')) {
          coins.add(t.symbol.slice(0, -4))
        }
      }
      if (coins.size > 0) return [...coins]
    } catch (e) {
      console.error(`Bybit ${host} failed:`, e.message)
    }
  }
  return []
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
