// Заведомо проблемный участок — try/catch проглатывает ошибку оплаты.
// Клиент жалуется «нажимаю оплатить — ничего не происходит», но в логах
// чисто: catch блок ничего не пишет.

export async function processPayment(amount: number, cardId: string): Promise<{ ok: boolean }> {
  try {
    const result = await callPaymentGateway(amount, cardId);
    return { ok: result.success };
  } catch {
    // BUG: молча проглатываем — UI не знает, что оплата упала.
    return { ok: false };
  }
}

async function callPaymentGateway(_amount: number, _cardId: string): Promise<{ success: boolean }> {
  throw new Error('not implemented');
}
