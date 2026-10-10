export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    signal: options.signal || AbortSignal.timeout(120_000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') {
      window.dispatchEvent(new Event('tlk:unauthorized'));
    }
    const error = Error(data?.error || 'HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  if (!data) throw Error('Respons server tidak valid.');
  return data;
}
