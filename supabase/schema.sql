-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS exchange_listings (
  exchange  TEXT        NOT NULL,
  symbol    TEXT        NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (exchange, symbol)
);

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_exchange ON exchange_listings(exchange);
CREATE INDEX IF NOT EXISTS idx_symbol   ON exchange_listings(symbol);

-- Allow public read (anon key is enough to read)
ALTER TABLE exchange_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON exchange_listings
  FOR SELECT USING (true);

CREATE POLICY "service write" ON exchange_listings
  FOR ALL USING (auth.role() = 'service_role');
