import fs from 'node:fs';

const reportPath = process.argv[2] || 'audit.json';
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const allowedAdvisory = 'GHSA-ch52-4w7c-c8xp';

const seen = new Set();
function pathIsAllowed(name, vulnerabilities) {
  if (seen.has(name)) return true;
  seen.add(name);
  const item = vulnerabilities[name];
  if (!item || !Array.isArray(item.via)) return true;
  for (const via of item.via) {
    if (typeof via === 'object' && via.url) {
      if (!via.url.toLowerCase().includes(allowedAdvisory.toLowerCase())) return false;
      continue;
    }
    if (typeof via === 'string' && !pathIsAllowed(via, vulnerabilities)) return false;
  }
  return true;
}

const vulnerabilities = report.vulnerabilities || {};
const blocking = [];
for (const [name, item] of Object.entries(vulnerabilities)) {
  const severity = String(item.severity || '').toLowerCase();
  if (!['high', 'critical'].includes(severity)) continue;
  if (!pathIsAllowed(name, vulnerabilities)) blocking.push(name);
}

if (blocking.length) {
  console.error('Blocking high/critical npm audit findings:', blocking.join(', '));
  process.exit(1);
}

const allowed = Object.entries(vulnerabilities)
  .filter(([, item]) => ['high', 'critical'].includes(String(item.severity || '').toLowerCase()))
  .map(([name]) => name);

if (allowed.length) {
  console.warn('Allowed high/critical findings are limited to GHSA-ch52-4w7c-c8xp and its dependency chain:', allowed.join(', '));
}
console.log('Security audit passed: no unapproved high/critical runtime findings.');
