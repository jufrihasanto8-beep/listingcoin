import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const limit = Math.min(parseInt(req.query.limit ?? '100'), 500)

  const { data, error } = await supabase
    .from('listing_events')
    .select('symbol, exchange, detected_at')
    .order('detected_at', { ascending: false })
    .limit(limit)

  if (error) return res.status(500).json({ error: error.message })

  res.json({ events: data ?? [] })
}
