/**
 * Telegram notifications
 */
export async function sendTelegramNotification(message: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken || !chatId) {
    console.warn('Telegram not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID missing)')
    return
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML'
        })
      }
    )

    if (!response.ok) {
      const error = await response.json()
      console.error('Telegram API error:', error)
    }
  } catch (err) {
    console.error('Failed to send Telegram notification:', err)
  }
}
