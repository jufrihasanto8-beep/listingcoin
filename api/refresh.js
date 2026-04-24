import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const EXCHANGE_LABELS = {
  upbit: 'Upbit', bithumb: 'Bithumb', okx: 'OKX', bybit: 'Bybit', kucoin: 'KuCoin'
}

// ── WhatsApp via Fonnte ───────────────────────────────────────────────────────

async function sendWA(message) {
  if (!process.env.FONNTE_TOKEN || !process.env.FONNTE_TARGET) return
  try {
    await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        Authorization: process.env.FONNTE_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        target:      process.env.FONNTE_TARGET,
        message,
        countryCode: '62',
      }),
    })
  } catch (e) {
    console.error('Fonnte error:', e.message)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchCoinGeckoExchange(exchangeId) {
  const coins = new Set()
  const pages = await Promise.allSettled(
    [1, 2, 3, 4, 5].map(page =>
      fetch(`https://api.coingecko.com/api/v3/exchanges/${exchangeId}/tickers?page=${page}`, {
        signal: AbortSignal.timeout(8000),
      }).then(r => r.json())
    )
  )
  for (const result of pages) {
    if (result.status !== 'fulfilled') continue
    for (const t of result.value.tickers ?? []) {
      if (t.target === 'USDT') coins.add(t.base.toUpperCase())
    }
  }
  return [...coins]
}

// ── Exchange fetchers ─────────────────────────────────────────────────────────

async function fetchBinance() {
  return fetchCoinGeckoExchange('binance')
}

async function fetchUpbit() {
  const res  = await fetch('https://api.upbit.com/v1/market/all', { headers: { Accept: 'application/json' } })
  const data = await res.json()
  const coins = new Set()
  for (const m of data) {
    const [, base] = m.market.split('-')
    if (base) coins.add(base.toUpperCase())
  }
  return [...coins]
}

async function fetchBithumb() {
  const res  = await fetch('https://api.bithumb.com/public/ticker/ALL_KRW')
  const data = await res.json()
  if (data.status !== '0000') return []
  return Object.keys(data.data).filter(k => k !== 'date').map(k => k.toUpperCase())
}

async function fetchOKX() {
  const res  = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT')
  const data = await res.json()
  const coins = new Set()
  for (const inst of data.data ?? []) coins.add(inst.baseCcy.toUpperCase())
  return [...coins]
}

async function fetchBybit() {
  return fetchCoinGeckoExchange('bybit_spot')
}

async function fetchKucoin() {
  const res  = await fetch('https://api.kucoin.com/api/v1/symbols')
  const data = await res.json()
  const coins = new Set()
  for (const s of data.data ?? []) coins.add(s.baseCurrency.toUpperCase())
  return [...coins]
}

const FETCHERS = {
  binance: fetchBinance,
  upbit:   fetchUpbit,
  bithumb: fetchBithumb,
  okx:     fetchOKX,
  bybit:   fetchBybit,
  kucoin:  fetchKucoin,
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron-signature'] !== undefined
  const isManual     = req.query.secret === process.env.CRON_SECRET
  if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' })

  const now    = new Date().toISOString()
  const counts = {}
  const fresh  = {} // exchange → Set<symbol>

  // 1. Fetch semua exchange secara paralel
  await Promise.allSettled(
    Object.entries(FETCHERS).map(async ([exchange, fn]) => {
      try {
        const coins = await fn()
        counts[exchange] = coins.length
        fresh[exchange]  = new Set(coins)
      } catch (err) {
        console.error(`[${exchange}]`, err.message)
        fresh[exchange] = new Set()
        counts[exchange] = 0
      }
    })
  )

  // 2. Ambil data lama dari Supabase
  const { data: existing } = await supabase
    .from('exchange_listings')
    .select('exchange, symbol')

  const existingSet  = new Set((existing ?? []).map(r => `${r.exchange}:${r.symbol}`))
  const isFirstRun   = existingSet.size === 0
  const binanceCoins = fresh['binance'] ?? new Set()

  // 3. Deteksi listing baru (koin Binance yang baru muncul di exchange lain)
  const newListings = [] // { exchange, symbol }
  if (!isFirstRun) {
    for (const [exchange, coins] of Object.entries(fresh)) {
      if (exchange === 'binance') continue
      for (const symbol of coins) {
        if (!existingSet.has(`${exchange}:${symbol}`) && binanceCoins.has(symbol)) {
          newListings.push({ exchange, symbol })
        }
      }
    }
  }

  // 4. Simpan listing events baru ke Supabase
  if (newListings.length > 0) {
    await supabase
      .from('listing_events')
      .upsert(
        newListings.map(e => ({ ...e, detected_at: now })),
        { onConflict: 'symbol,exchange', ignoreDuplicates: true }
      )
  }

  // 5. Kirim WA alert kalau ada listing baru
  if (newListings.length > 0) {
    // Grup per exchange
    const grouped = {}
    for (const { exchange, symbol } of newListings) {
      if (!grouped[exchange]) grouped[exchange] = []
      grouped[exchange].push(symbol)
    }

    const lines = Object.entries(grouped).map(([ex, symbols]) =>
      `*${EXCHANGE_LABELS[ex] ?? ex}:* ${symbols.join(', ')}`
    )

    const message =
      `🚨 *NEW LISTING ALERT* 🚨\n\n` +
      `Koin Binance baru listing:\n\n` +
      lines.join('\n') +
      `\n\n⚡ Cek harga sekarang!\n${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}`

    await sendWA(message)
  }

  // 6. Upsert semua data segar ke exchange_listings
  const rows = []
  for (const [exchange, coins] of Object.entries(fresh)) {
    for (const symbol of coins) {
      rows.push({ exchange, symbol, first_seen: now, updated_at: now })
    }
  }

  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('exchange_listings')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'exchange,symbol' })
    if (error) console.error('upsert error:', error.message)
  }

  // 7. Hapus koin yang sudah delisted
  await supabase.from('exchange_listings').delete().lt('updated_at', now)

  res.json({ ok: true, counts, newListings: newListings.length, total: rows.length })
}
