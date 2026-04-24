export default async function handler(req, res) {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (!process.env.FONNTE_TOKEN || !process.env.FONNTE_TARGET) {
    return res.status(400).json({ error: 'FONNTE_TOKEN atau FONNTE_TARGET belum diset di env variables' })
  }

  try {
    const response = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        Authorization: process.env.FONNTE_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        target:      process.env.FONNTE_TARGET,
        message:     '✅ Test berhasil! Crypto Listing Tracker siap kirim alert ke WA kamu.',
        countryCode: '62',
      }),
    })

    const result = await response.json()
    res.json({ ok: true, fonnte_response: result })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}
