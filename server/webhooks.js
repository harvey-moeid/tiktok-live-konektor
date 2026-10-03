const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function dispatchWebhook(event, webhooks) {
  const targets = (webhooks || []).filter(h =>
    h && h.enabled !== false && /^https:\/\//i.test(String(h.url || '')) &&
    (!Array.isArray(h.events) || !h.events.length || h.events.includes(event.event))
  );

  await Promise.allSettled(targets.map(async h => {
    const retries = Math.min(Math.max(Number(process.env.WEBHOOK_RETRIES || 3), 0), 5);
    const timeoutMs = Math.min(Math.max(Number(process.env.WEBHOOK_TIMEOUT_MS || 5000), 1000), 15000);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(String(h.url), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-tlk-event-id': String(event.id || ''),
              'x-tlk-event-version': String(event.version || 1)
            },
            body: JSON.stringify(event),
            signal: controller.signal
          });
          if (!response.ok) throw Error('HTTP ' + response.status);
        } finally {
          clearTimeout(timer);
        }
        return;
      } catch (e) {
        if (attempt === retries) {
          console.warn('[webhook]', h.url, e?.message || String(e));
          return;
        }
        await wait(Math.min(1500 * 2 ** attempt, 6000));
      }
    }
  }));
}
