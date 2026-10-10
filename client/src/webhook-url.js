// The server additionally validates DNS and pins the resolved public address.
export function publicWebhookUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !host.includes('.') || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw Error('Gunakan HTTPS publik tanpa kredensial, fragmen, atau alamat IP.');
  }
  return url;
}
