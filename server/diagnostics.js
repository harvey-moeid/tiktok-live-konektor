const credentialNames = ['JWT_SECRET', 'ADMIN_PASSWORD', 'WS_TOKEN', 'API_KEY', 'EULER_API_KEY', 'PYTHON_FALLBACK_TOKEN', 'WEBHOOK_SIGNING_SECRET'];

export function redactText(value, secrets = credentialNames.map(name => process.env[name]).filter(Boolean)) {
  let text = String(value || '');
  for (const secret of secrets) {
    text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
  }
  return text
    .replace(/([?&](?:api[_-]?key|key|token|signApiKey|signature)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .slice(0, 1000);
}

export function redactDiagnostic(value, secrets, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactDiagnostic(item, secrets, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
    key, /authorization|cookie|token|password|secret|api.?key|headers|request|response|config/i.test(key)
      ? '[redacted]' : redactDiagnostic(item, secrets, depth + 1)
  ]));
}
