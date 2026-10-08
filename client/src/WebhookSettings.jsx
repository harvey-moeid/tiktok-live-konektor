import React, { useRef, useState } from 'react';
import {
  MAX_WEBHOOKS, WEBHOOK_EVENT_OPTIONS, KNOWN_WEBHOOK_EVENTS,
  copyWebhookRows, parseCustomWebhookEvents, toggleWebhookEvent, validateWebhookRows
} from './webhook-utils.js';

const persisted = source => copyWebhookRows(source);
const editable = (hooks, prefix = 'loaded') => persisted(hooks).map((hook, i) => ({ ...hook, rowKey: prefix + i }));

export default function WebhookSettings({ initialHooks, onSave }) {
  const [saved, setSaved] = useState(() => persisted(initialHooks));
  const [rows, setRows] = useState(() => editable(initialHooks));
  const [customFields, setCustomFields] = useState({});
  const [feedback, setFeedback] = useState(null);
  const [saving, setSaving] = useState(false);
  const nextKey = useRef(0);
  const current = persisted(rows);
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const error = validateWebhookRows(current);
  const enabledCount = rows.filter(row => row.enabled).length;

  function edit(rowKey, update) {
    setRows(previous => previous.map(row => row.rowKey === rowKey ? { ...row, ...update(row) } : row));
    setFeedback(null);
  }
  function addRow() {
    if (rows.length >= MAX_WEBHOOKS || saving) return;
    setRows(previous => [...previous, {
      rowKey: 'new-' + (++nextKey.current), url: '', enabled: false, events: []
    }]);
    setFeedback(null);
  }
  function removeRow(rowKey) {
    if (saving) return;
    setRows(previous => previous.filter(row => row.rowKey !== rowKey));
    setCustomFields(previous => {
      const next = { ...previous };
      delete next[rowKey];
      return next;
    });
    setFeedback(null);
  }
  function addCustomEvents(row) {
    const { events, error: inputError } = parseCustomWebhookEvents(customFields[row.rowKey]);
    if (inputError) return setFeedback({ type: 'error', text: inputError });
    const merged = [...new Set([...(row.events || []), ...events])];
    if (merged.length > 50) return setFeedback({ type: 'error', text: 'Maksimal 50 jenis event per webhook.' });
    edit(row.rowKey, () => ({ events: merged }));
    setCustomFields(previous => ({ ...previous, [row.rowKey]: '' }));
  }
  function reset() {
    if (saving) return;
    setRows(editable(saved, 'reset-'));
    setCustomFields({});
    setFeedback(null);
  }
  async function save() {
    if (!dirty || saving) return;
    if (error) return setFeedback({ type: 'error', text: error });
    setSaving(true);
    setFeedback(null);
    try {
      const result = await onSave(current);
      const normalized = persisted(result);
      setSaved(normalized);
      setRows(editable(normalized, 'saved-'));
      setCustomFields({});
      setFeedback({ type: 'success', text: 'Pengaturan webhook berhasil disimpan.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Gagal menyimpan webhook.' });
    } finally {
      setSaving(false);
    }
  }
  return <section className="webhook-page" role="tabpanel" aria-label="Integrasi Webhook">
    <div className="webhook-heading">
      <div>
        <span className="section-overline">INTEGRASI WEBSITE</span>
        <h2>Webhook LIVE</h2>
        <p>Kirim komentar, like, gift, dan aktivitas LIVE otomatis ke website lain.</p>
      </div>
      <div className="webhook-heading-actions">
        <span className="webhook-count">{enabledCount} aktif / {rows.length} total</span>
        <button className="primary" type="button" onClick={addRow} disabled={saving || rows.length >= MAX_WEBHOOKS}>+ Tambah webhook</button>
      </div>
    </div>

    <div className="webhook-security-note">
      <strong>Keamanan:</strong> Endpoint penerima harus memakai HTTPS dan memverifikasi token rahasia sendiri. Webhook belum memakai signature HMAC; jangan gunakan untuk pemberian koin atau reward bernilai tanpa validasi tambahan.
      <a href="https://github.com/harvey-moeid/tiktok-live-konektor/blob/main/docs/INTEGRASI_WEBSITE.md" target="_blank" rel="noopener noreferrer">Panduan integrasi ↗</a>
    </div>

    {rows.length === 0 ? <div className="webhook-empty">
      <span className="webhook-empty-icon" aria-hidden="true">↗</span>
      <h3>Belum ada webhook</h3>
      <p>Tambahkan alamat HTTPS website penerima untuk mulai mengirim event ketika LIVE aktif.</p>
      <button type="button" className="secondary" onClick={addRow}>+ Webhook pertama</button>
    </div> :
      <div className="webhook-grid">
        {rows.map((row, index) => {
          const extras = row.events.filter(value => !KNOWN_WEBHOOK_EVENTS.has(value));
          const all = row.events.length === 0;
          return <article className="webhook-card" key={row.rowKey}>
            <div className="webhook-card-top">
              <div>
                <span className="webhook-number">DESTINASI {String(index + 1).padStart(2, '0')}</span>
                <h3>Website / API penerima</h3>
              </div>
              <label className="webhook-toggle">
                <input type="checkbox" checked={row.enabled} disabled={saving}
                  onChange={e => edit(row.rowKey, () => ({ enabled: e.target.checked }))}/>
                <span>{row.enabled ? 'Aktif' : 'Nonaktif'}</span>
              </label>
            </div>
            <label htmlFor={'webhook-url-' + row.rowKey}>URL endpoint webhook</label>
            <input id={'webhook-url-' + row.rowKey} type="url" inputMode="url"
              placeholder="https://website-anda.com/api/tiktok/webhook"
              autoComplete="off" maxLength={2048}
              value={row.url} disabled={saving}
              onChange={e => edit(row.rowKey, () => ({ url: e.target.value }))}/>
            <small className="hint">Menerima POST JSON. Gunakan URL HTTPS publik dengan autentikasi penerima.</small>

            <fieldset className="webhook-event-fieldset" disabled={saving}>
              <legend>Jenis event yang dikirim</legend>
              <div className="webhook-event-options">
                <button type="button" aria-pressed={all} className={all ? 'selected' : ''}
                  onClick={() => edit(row.rowKey, () => ({ events: [] }))}>Semua event</button>
                {WEBHOOK_EVENT_OPTIONS.map(([name, label]) =>
                  <button key={name} type="button"
                    aria-pressed={row.events.includes(name)} className={row.events.includes(name) ? 'selected' : ''}
                    onClick={() => edit(row.rowKey, previous => ({ events: toggleWebhookEvent(previous.events, name) }))}>
                    {label}
                  </button>
                )}
              </div>
              <small className="hint">{all
                ? 'Semua event termasuk jenis lain yang didukung konektor akan dikirim.'
                : row.events.length + ' jenis dipilih. Klik jenis yang sudah aktif untuk membatalkannya.'}</small>
              {extras.length > 0 && <div className="webhook-extra-events">
                {extras.map(event => <button type="button" key={event} title={'Hapus ' + event}
                  onClick={() => edit(row.rowKey, previous => ({ events: previous.events.filter(name => name !== event) }))}>
                  {event} ×
                </button>)}
              </div>}
              <div className="webhook-custom">
                <input type="text" aria-label={'Jenis event tambahan untuk webhook ' + (index + 1)}
                  placeholder="Event lain: subscribe, emote"
                  value={customFields[row.rowKey] || ''} disabled={saving}
                  onChange={e => setCustomFields(previous => ({ ...previous, [row.rowKey]: e.target.value }))}/>
                <button type="button" className="secondary" onClick={() => addCustomEvents(row)}
                  disabled={saving || !(customFields[row.rowKey] || '').trim()}>Tambah jenis</button>
              </div>
            </fieldset>
            <div className="webhook-card-foot">
              <span>{row.enabled ? '● Siap menerima event saat LIVE' : '○ Tidak akan menerima event'}</span>
              <button type="button" className="webhook-remove" onClick={() => removeRow(row.rowKey)} disabled={saving}>Hapus webhook</button>
            </div>
          </article>;
        })}
      </div>
    }

    <div className="webhook-savebar">
      <div className="webhook-save-info">
        <strong>{dirty ? 'Perubahan belum disimpan' : 'Semua perubahan tersimpan'}</strong>
        <span>{error && dirty ? error : 'Perubahan hanya berlaku setelah disimpan.'}</span>
      </div>
      <div className="webhook-save-actions">
        <button type="button" className="ghost" disabled={!dirty || saving} onClick={reset}>Batalkan</button>
        <button type="button" className="primary" disabled={!dirty || saving}
          onClick={save}>{saving ? 'Menyimpan…' : 'Simpan webhook'}</button>
      </div>
    </div>
    {feedback && <div role={feedback.type === 'error' ? 'alert' : 'status'}
      className={feedback.type === 'error' ? 'error-detail' : 'notice'}>{feedback.text}</div>}
  </section>;
}
