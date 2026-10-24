// Keep commercial signer errors distinct from TikTok Room ID discovery failures.
export const EULER_BUSINESS_PLAN_MESSAGE =
  'Eulerstream menolak permintaan signature TikTok LIVE: endpoint ini membutuhkan paket Business. API key Community atau Room ID manual tidak mengubah hak akses signing. Gunakan paket/provider signing yang memiliki akses resmi, atau konfigurasi fallback Python sebagai alternatif (tidak dijamin berhasil).';

export function isEulerBusinessPlanError(details) {
  const seen = new WeakSet();
  let message = '';
  try {
    message = JSON.stringify(details, (_key, value) => {
      if (value instanceof Error) return { name: value.name, message: value.message, cause: value.cause };
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      return value;
    }) || '';
  } catch {
    message = String(details || '');
  }
  return /requires?\s+(?:a\s+)?business\s+plan/i.test(message) &&
    /(?:eulerstream|fetchWebcastSignatureFromEulerRoute|sign(?:ature|ing)?|endpoint)/i.test(message);
}
