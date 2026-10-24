import dns from 'node:dns/promises';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { publicWebhookUrl } from '../client/src/webhook-url.js';

export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export async function resolvePublicAddress(hostname, lookup = dns.lookup) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw Error('Webhook DNS harus hanya menunjuk alamat publik.');
  }
  return records[0];
}

export function sendWebhook(value, body, headers, timeoutMs) {
  const url = publicWebhookUrl(value);
  return new Promise((resolve, reject) => {
    // Resolve once at connection time; the checked address is the one TLS uses.
    const request = https.request(url, {
      method: 'POST', agent: false, signal: AbortSignal.timeout(timeoutMs),
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      lookup(hostname, options, callback) {
        resolvePublicAddress(hostname).then(record => {
          if (options.all) callback(null, [record]);
          else callback(null, record.address, record.family);
        }, callback);
      }
    }, response => {
      const status = response.statusCode;
      response.destroy(); // Response bodies are not needed, and may be unbounded.
      if (status >= 200 && status < 300) resolve();
      else reject(Error('HTTP ' + status)); // Redirects are never followed.
    });
    request.once('error', reject);
    request.end(body);
  });
}
