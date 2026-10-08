# Integrasi website lain dengan TikTok LIVE Konektor

Panduan ini menjadikan **`tiktok-live-konektor` sebagai satu sumber data TikTok LIVE** untuk beberapa website (misalnya dashboard, overlay, game, dan sistem interaksi). Website konsumen tidak perlu menjalankan konektor TikTok masing-masing.

> **Status fitur:** REST API v1, external WebSocket, dan webhook tersedia pada server Node. Fallback Python bersifat opsional, bergantung pada konfigurasi serta deployment layanan Python terpisah. Node dan Python tetap mengirimkan format event yang sama. Dokumentasi ini tidak membuktikan bahwa koneksi `@jalurtarot` sedang LIVE di produksi.

## 1. Gambaran sistem

```text
TikTok LIVE @jalurtarot
         |
 Node.js connector ──(jika gagal saat Start LIVE)──> Python TikTokLive
         |                                         |
         +----------------- event normalized ------+
                              |
                    tiktok-live-konektor
                              |
               REST API v1 / WebSocket / webhook
                     |       |        |
                Website A  Website B  Website C
```

- Jalankan **Start LIVE** dari dashboard admin konektor saat akun benar-benar sedang LIVE. `/api/v1/*` **read-only**, bukan endpoint untuk memulai/menghentikan LIVE.
- Cukup satu proses koneksi TikTok di pusat. Banyak website boleh memakai API yang sama; pertimbangkan pembatasan akses tiap consumer.
- Base URL contoh (ganti apabila domain produksi berubah):

  ```text
  https://tiktok-live-konektor.onrender.com
  ```

- Mode engine di status dapat berupa `node`, `python`, atau `none`; jangan anggap fallback Python tersedia tanpa deployment dan environment yang sesuai.

## 2. Siapkan environment di konektor (Render)

Contoh **nama variabel**, bukan secret sungguhan:

```dotenv
API_KEY=PASTE_RANDOM_SECRET_UNIK_PANJANG
API_ALLOWED_ORIGINS=https://website-a.example,https://website-b.example
TIKTOK_USERNAME=jalurtarot
```

1. Tambahkan `API_KEY` di **service Node `tiktok-live-konektor`**. Gunakan key acak panjang dan berbeda dari `JWT_SECRET`, `WS_TOKEN`, maupun `PYTHON_BRIDGE_TOKEN`.
2. Tambahkan origin browser yang diizinkan pada `API_ALLOWED_ORIGINS`. Pisahkan dengan koma, gunakan **origin persis** (`scheme://host[:port]`), tanpa trailing slash/path. Ini berlaku untuk REST **yang membawa header Origin** dan external WebSocket browser.
3. Simpan API key yang sama di **backend setiap website konsumen** dengan nama semisal `TLK_API_KEY`. Jangan menaruh API key di React/Vite frontend, HTML, kode yang dipublikasikan, ataupun URL publik.
4. Periksa `GET /api/health` dan aktifkan koneksi LIVE melalui dashboard admin. `ok: true` hanya berarti server merespons; lihat `status` atau `running` untuk mengetahui koneksi ke TikTok.
5. Untuk produksi dengan beberapa website, pertimbangkan **kunci terpisah per website**. Implementasi sekarang memakai **satu `API_KEY` bersama**; rotasi key akan memengaruhi semua consumer.

**Catatan:** CORS / `API_ALLOWED_ORIGINS` bukan autentikasi. Permintaan server-to-server biasanya tidak memiliki `Origin`; mereka tetap harus mengirim API key. Akses langsung melalui browser dengan key di query WebSocket hanya cocok untuk klien terkontrol, **bukan website publik**.

## 3. Endpoint HTTP

| Method | Endpoint | Auth | Isi / fungsi |
| --- | --- | --- | --- |
| GET | `/api/health` | Tidak | `ok`, `status`, `engine` server |
| GET | `/api/v1/status` | API key | `status`, `running`, `engine`, `pythonFallbackAvailable`, `roomId`, `lastEventAt`, `stats` |
| GET | `/api/v1/stats` | API key | `stats` dan info akun / room |
| GET | `/api/v1/events` | API key | `count`, `events` (terbaru dulu) |

Header untuk REST:

```http
Authorization: Bearer YOUR_API_KEY
```

Sebagai alternatif, REST menerima `X-API-Key`. Endpoint `/api/health` sengaja publik.

Contoh pengujian **dari terminal pribadi / backend**:

```bash
export TLK_BASE_URL="https://tiktok-live-konektor.onrender.com"
export TLK_API_KEY="ISI_DARI_SECRET_MANAGER"

curl -i "$TLK_BASE_URL/api/health"
curl -i -H "Authorization: Bearer $TLK_API_KEY" "$TLK_BASE_URL/api/v1/status"
curl -i -H "Authorization: Bearer $TLK_API_KEY" "$TLK_BASE_URL/api/v1/stats"
curl -i -H "Authorization: Bearer $TLK_API_KEY" \
  "$TLK_BASE_URL/api/v1/events?type=chat,like,gift&limit=20"
```

Opsi `GET /api/v1/events`:
- `type`: tipe event dipisahkan koma, seperti `chat,like,gift`. Nilai yang dikenali: `chat`, `like`, `gift`, `follow`, `share`, `member`, `viewer`, `stream`.
- `limit`: antara 1 dan 200 (default 50).
- `before`: timestamp ISO 8601 sebagai batas waktu, misalnya `2026-10-08T13:00:00.000Z`. Gunakan URL encoding ketika dikirim pada URL.

Contoh bentuk satu event (data ilustrasi, bukan siaran nyata):

```json
{
  "id": "9a18b3d0-33c9-4489-9ca2-e611f7baf784",
  "event": "gift",
  "timestamp": "2026-10-08T13:05:00.000Z",
  "roomId": "7693584931198438164",
  "username": "jalurtarot",
  "version": 1,
  "data": {
    "username": "viewer_contoh",
    "nickname": "Viewer",
    "giftName": "Rose",
    "repeatCount": 3,
    "repeatEnd": true,
    "diamondCount": 1,
    "totalValue": 3
  }
}
```

`username` tingkat atas adalah penyiar; `data.username` adalah pengirim event. Statistik `stats` mencakup `chat`, `likes`, `gifts`, `giftCoins`, `follows`, `viewerCount`, `peakViewers`, dan `topGifter`. Jangan menyamakan nilai diamond atau `totalValue` dengan uang tunai.

**Batasan data:** sejarah event dan statistik sekarang disimpan di **memori proses Node** (event history default maks. 500; konfigurasi mendukung hingga 2000). Restart, sleep Render, atau event burst dapat menyebabkan data hilang. `/api/v1/events` **bukan database permanen** dan `before` adalah filter waktu, bukan cursor penjamin pengiriman tepat sekali.

## 4. Website Cloudflare Pages + Worker: REST backend/proxy

Contoh Worker yang bisa dipasang pada route `/api/tiktok/*` milik website sendiri. Key tidak pernah diberikan ke browser. Contoh ini hanya mengekspos data yang boleh dilihat publik; **tambahkan autentikasi pengguna** jika statistik/event tidak boleh diakses sembarang pengunjung.

Simpan secret pada Cloudflare Worker: `TLK_API_KEY`. Variabel `TLK_BASE_URL` opsional.

```js
// worker.js — route: https://website-a.example/api/tiktok/*
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const prefix = "/api/tiktok/";
    if (request.method !== "GET" || !url.pathname.startsWith(prefix)) {
      return new Response("Not found", { status: 404 });
    }

    const action = url.pathname.slice(prefix.length);
    if (!["status", "stats", "events"].includes(action)) {
      return new Response("Not found", { status: 404 });
    }
    if (!env.TLK_API_KEY) {
      return new Response("Server secret belum diatur", { status: 503 });
    }

    const base = (env.TLK_BASE_URL || "https://tiktok-live-konektor.onrender.com")
      .replace(/\/+$/, "");
    const upstreamUrl = new URL(base + "/api/v1/" + action);
    if (action === "events") {
      const types = new Set(["chat", "like", "gift", "follow", "share", "member", "viewer", "stream"]);
      const requested = (url.searchParams.get("type") || "chat,like,gift").split(",")
        .map(x => x.trim()).filter(x => types.has(x));
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 200);
      upstreamUrl.searchParams.set("type", (requested.length ? requested : ["chat", "like", "gift"]).join(","));
      upstreamUrl.searchParams.set("limit", String(limit));
    }

    try {
      const response = await fetch(upstreamUrl.toString(), {
        headers: { Authorization: "Bearer " + env.TLK_API_KEY },
        cf: { cacheTtl: 0 }
      });
      // Hanya teruskan body respons, jangan teruskan header autentikasi/secret.
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    } catch {
      return Response.json({ error: "Upstream TikTok LIVE tidak dapat dihubungi" }, { status: 502 });
    }
  }
};
```

Di frontend website **milik origin yang sama**:

```js
const res = await fetch("/api/tiktok/status");
if (!res.ok) throw new Error("Tidak bisa membaca status LIVE");
const { status, running, engine, stats } = await res.json();
console.log({ status, running, engine, stats });
```

Jika Worker berfungsi sebagai proxy lintas domain, tambahkan kebijakan CORS **di proxy itu** dan validasi asal permintaan. Contoh di atas sengaja tidak mengaktifkan CORS umum. Untuk data sensitif, wajib verifikasi sesi/otorisasi pemakai **sebelum** meneruskan permintaan ke konektor. `API_ALLOWED_ORIGINS` di konektor bukan pengganti perlindungan proxy milik website.

## 5. Realtime WebSocket (untuk komentar, like, gift)

Endpoint eksternal:

```text
wss://tiktok-live-konektor.onrender.com/live
```

Gunakan autentikasi header ketika konek **dari server**:

```http
Authorization: Bearer YOUR_API_KEY
```

Bila hanya butuh event tertentu, tambahkan `?events=chat,like,gift` (atau `?types=...`). Tanpa filter, semua event yang disiarkan akan dikirim. WebSocket eksternal tidak mengharuskan cookie login dashboard.

**Contoh consumer Node.js (backend saja):**

```bash
npm install ws
```

```js
// consumer.mjs — jalankan di server website, JANGAN di frontend
import WebSocket from "ws";

const endpoint = "wss://tiktok-live-konektor.onrender.com/live?events=chat,like,gift";
const key = process.env.TLK_API_KEY;
if (!key) throw Error("Set TLK_API_KEY di environment backend");

let retryMs = 1000;
function connect() {
  const ws = new WebSocket(endpoint, {
    headers: { Authorization: "Bearer " + key }
  });
  ws.on("open", () => { retryMs = 1000; console.log("LIVE stream connected"); });
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === "chat") console.log("CHAT", msg.data.username, msg.data.message);
    if (msg.event === "like") console.log("LIKE", msg.data.username, msg.data.likeCount);
    if (msg.event === "gift") console.log("GIFT", msg.id, msg.data.giftName, msg.data.repeatCount);
    // Teruskan hanya informasi yang dibutuhkan ke frontend via SSE/Socket.IO sendiri.
  });
  ws.on("error", err => console.error("LIVE stream error:", err.message));
  ws.on("close", () => {
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, 30000);
    setTimeout(connect, wait);
  });
}
connect();
```

Untuk website publik gunakan **satu koneksi upstream di backend**, lalu fan-out ke browser lewat SSE, Socket.IO, atau WebSocket milik website. Jangan membuat satu koneksi langsung ke konektor dengan API key di browser setiap kali pengunjung membuka halaman. Format event sama pada engine Node/Python.

## 6. Webhook: memicu tindakan di website lain

Di dashboard admin konektor, atur webhook berbentuk:

```json
{
  "url": "https://website-a.example/hooks/tiktok/SECRET_RANDOM_UNIK",
  "enabled": true,
  "events": ["chat", "gift"]
}
```

Konfigurasi webhook disimpan melalui pengaturan admin; endpoint `/api/v1/*` **tidak menyediakan** pembuatan webhook maupun kontrol LIVE untuk website lain. Konektor saat ini:
- Mengirim `POST` JSON event via HTTPS ke URL yang terdaftar.
- Menyertakan `x-tlk-event-id` dan `x-tlk-event-version` sebagai **metadata**, bukan bukti autentikasi.
- Mencoba ulang saat respons gagal, dengan batas timeout/retry yang dapat dikonfigurasi.
- Membatasi maksimal 20 webhook.

**Penting:** implementasi webhook **belum menyertakan signature HMAC**. Karena itu, URL token acak panjang di path hanyalah perlindungan minimal: validasi token dengan aman di penerima, gunakan HTTPS, rate limiting, autentikasi tambahan sesuai kebutuhan, dan jangan mempercayai `x-tlk-event-id` sebagai tanda bahwa request pasti berasal dari konektor. Untuk saldo/koin atau reward bernilai, tambahkan penandatanganan payload dan verifikasi signature pada kedua sisi **sebelum** mengaktifkan transaksi otomatis.

Semua handler harus **idempotent**: simpan `event.id` yang telah diproses di database consumer, pastikan kombinasi event tidak diproses dua kali, dan jangan gunakan penambahan koin langsung dari perulangan percobaan webhook. Perhatikan bahwa event dalam memori dapat hilang saat restart; pengiriman saat ini bukan *exactly once*.

## 7. Pemilihan metode

| Kebutuhan consumer | Pilihan |
| --- | --- |
| Dashboard jumlah komentar/like/gift dan status | REST API dari backend, refresh berkala |
| Overlay atau game yang perlu event seketika | WebSocket backend → browser dengan relay sendiri |
| Gift memicu workflow/animasi server | Webhook + idempotency + verifikasi request |
| Banyak website menggunakan akun TikTok yang sama | Satu service konektor pusat, banyak consumer |
| Koneksi Node tidak berhasil ketika Start LIVE | Python fallback **jika layanan terpasang dan diatur** |

## 8. Troubleshooting

| Gejala | Pemeriksaan |
| --- | --- |
| HTTP `401` REST / handshake WS | `API_KEY` salah, tidak dikirim, atau salah cara autentikasi |
| HTTP `403` dengan `Origin` | Origin browser belum termasuk `API_ALLOWED_ORIGINS` secara persis |
| HTTP `503` di `/api/v1/*` | `API_KEY` belum ada di environment konektor |
| HTTP `429` | Limit koneksi / request; kurangi reconnect/polling |
| `/api/health` sukses tetapi LIVE offline | Backend hidup tetapi belum `Start LIVE` atau tidak terhubung ke TikTok |
| Event kosong setelah restart | History hanya disimpan di memori |
| Event berhenti dan koneksi terputus | Cek status LIVE, log Render, reconnect ber-backoff |
| Python fallback tidak dipakai | Cek deployment `tiktok-live-python`, `PYTHON_FALLBACK_URL` atau `PYTHON_FALLBACK_HOSTNAME`, dan `PYTHON_FALLBACK_TOKEN` di Node |
| Koin/gift terhitung ganda | Gunakan `event.id` untuk idempotency, pahami gift streak dan retry webhook |

**Checklist produksi**: secret hanya pada backend, exact origin bila perlu browser, konektor LIVE aktif, consumer menggunakan retry/backoff, tidak ada API key di browser, webhook dilindungi, data penting disimpan persisten, dan setiap situs punya pembatasan akses serta observabilitas masing-masing.

Lihat juga [README utama](../README.md) untuk konfigurasi Render, autentikasi admin, dan Python fallback.
