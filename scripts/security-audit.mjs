import fs from 'node:fs';

const reportPath = process.argv[2] || 'audit.json';
const allowedAdvisories = new Set();
let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error('Could not parse npm audit report:', e?.message || String(e));
  process.exit(1);
}

if (report?.error) {
  console.error('npm audit returned an error:', report.error?.summary || report.error?.message || JSON.stringify(report.error));
  process.exit(1);
}

const vulnerabilities = report?.vulnerabilities;
if (!vulnerabilities || typeof vulnerabilities !== 'object') {
  console.error('npm audit report is missing the vulnerabilities object.');
  process.exit(1);
}

function advisoryId(via) {
  if (!via || typeof via !== 'object') return '';
  const source = String(via.url || via.source || '');
  const match = source.match(/GHSA-[\w-]+/i);
  return match?.[0]?.toUpperCase() || '';
}

const memo = new Map();
function pathIsAllowed(name, visiting = new Set()) {
  if (memo.has(name)) return memo.get(name);
  if (visiting.has(name)) return false;
  const item = vulnerabilities[name];
  if (!item || !Array.isArray(item.via) || item.via.length === 0) {
    memo.set(name, false);
    return false;
  }

  const nextVisiting = new Set(visiting);
  nextVisiting.add(name);
  const allowed = item.via.every(via => {
    if (typeof via === 'string') return pathIsAllowed(via, nextVisiting);
    const id = advisoryId(via);
    return id && allowedAdvisories.has(id);
  });
  memo.set(name, allowed);
  return allowed;
}

const highOrCritical = Object.entries(vulnerabilities)
  .filter(([, item]) => ['high', 'critical'].includes(String(item?.severity || '').toLowerCase()));
const blocking = highOrCritical.filter(([name]) => !pathIsAllowed(name)).map(([name]) => name);

if (blocking.length) {
  console.error('Blocking high/critical npm audit findings:', blocking.join(', '));
  process.exit(1);
}

const allowed = highOrCritical.map(([name]) => name);
if (allowed.length) {
  console.warn('Allowed high/critical findings are limited to explicit advisories and their dependency chains:', allowed.join(', '));
}
console.log('Security audit passed: no unapproved high/critical runtime findings.');
