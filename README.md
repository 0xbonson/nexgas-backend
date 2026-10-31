# NEX-GAS Backend Service

Backend service untuk **NEX-GAS** (Sistem Pemantauan Reaktor Biogas & Pemurnian Anaerobik Cerdas). Dibangun menggunakan Node.js, Express 5, TypeScript (NodeNext ESM), database Turso Cloud (libSQL) / SQLite lokal (`better-sqlite3` mode WAL), `ws` WebSocket gateway, dan `mqtt.js` dengan enkripsi TLS HiveMQ Cloud.

---

## 1. Tujuan Proyek NEX-GAS

NEX-GAS dirancang untuk memantau produksi biogas secara real-time pada reaktor digesti anaerobik skala komunal/industri kecil. Sistem ini mengawasi:
- Kualitas dan komposisi gas (kadar metana $\text{CH}_4$, hidrogen sulfida $\text{H}_2\text{S}$).
- Keamanan reaktor dan lingkungan (deteksi kebocoran gas metana ambient dan tekanan digester).
- Efektivitas pemurnian filter biogas sebelum disalurkan ke kompor atau generator listrik.
- Integrasi IoT berbasis cloud end-to-end yang tangguh, tetap mampu menyajikan data historis dan snapshot terakhir meskipun perangkat keras mikrokontroler sedang offline.

---

## 2. Arsitektur Sistem

```
┌─────────────────────────────────┐
│          ESP32 DevKit           │
│  - Sensor MQ-136 & MQ-4         │
│  - Sensor DHT22 & Tekanan       │
│  - Solenoid Valve & Aktuator    │
└────────────────┬────────────────┘
                 │
                 │ MQTT via TLS (Port 8883)
                 ▼
┌─────────────────────────────────┐
│          HiveMQ Cloud           │
│     (Broker MQTT Terkelola)     │
└────────────────┬────────────────┘
                 │
                 │ Subscribe / Publish
                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          NeX-Gas-Backend                               │
│  - MQTT Service: Auto-reconnect, Zod validation, TLS HiveMQ            │
│  - Database Engine: Turso Cloud (libSQL over HTTP) & SQLite (WAL mode) │
│  - REST API: Express 5, CORS (Vercel & localhost), Rate Limiter        │
│  - WebSocket Gateway: Live broadcasts (telemetry, state, status, event)│
│  - Snapshot API: `/api/device/snapshot` untuk hidrasi offline dashboard │
└────────────────┬───────────────────────────────────────────────────────┘
                 │
                 ├───────────────────────────────┐
                 │ HTTP REST & WebSocket         │ Public Ingress
                 ▼                               ▼
┌─────────────────────────────────┐  ┌─────────────────────────────────┐
│        NeX-Gas-Frontend         │  │        Cloudflare Tunnel        │
│  (Next.js Dashboard & Monitor)  │  │   (HTTPS & WSS Public Ingress)  │
└─────────────────────────────────┘  └─────────────────────────────────┘
```

---

## 3. Struktur Folder & Komponen Utama

```
NeX-Gas-Backend/
├── docs/
│   └── NEXGAS_OFFLINE_DASHBOARD_VERIFICATION.md # Laporan verifikasi dashboard offline & Turso
├── scripts/
│   ├── start-tunnel.sh       # Script otomatisasi Cloudflare Quick Tunnel (HTTPS/WSS)
│   └── stop-tunnel.sh        # Script penghentian tunnel
├── src/
│   ├── api/
│   │   ├── formatters.ts     # Pemetaan 17 field telemetry untuk kompatibilitas frontend
│   │   ├── middleware/       # Auth (JWT), CORS (mendukung *.vercel.app), error handler, limiter
│   │   └── routes.ts         # Endpoint REST (/api/telemetry, /api/device/snapshot, /api/command, dll)
│   ├── config/
│   │   └── env.ts            # Validasi konfigurasi environment menggunakan Zod
│   ├── database/
│   │   ├── client.ts         # Inisialisasi adapter Turso libSQL dan better-sqlite3
│   │   ├── migrations/       # Skema DDL tabel SQLite / Turso
│   │   └── repositories/     # Akses data (telemetry, state, status, events)
│   ├── mqtt/
│   │   ├── client.ts         # MQTT client dengan TLS dan auto-reconnection
│   │   └── handlers.ts       # Router pesan masuk topik MQTT
│   ├── websocket/
│   │   └── gateway.ts        # Broadcast event real-time ke client dashboard
│   └── index.ts              # Entrypoint server Express & WebSocket
├── tests/                    # 29 test suites (206 unit, integration, & security tests)
└── package.json
```

---

## 4. Status Sensor & Catatan Kejujuran Teknis

Sistem NEX-GAS mengutamakan integritas dan kejujuran data (data integrity). Dashboard dan backend tidak pernah memalsukan angka sensor jika perangkat keras belum siap atau belum terpasang:

| Komponen / Sensor | Status Fisik | Status Pembacaan & Telemetry | Penanganan di Backend & Dashboard |
| :--- | :--- | :--- | :--- |
| **MQ-136 (H₂S Inlet)** | Belum terpasang | Firmware mengirim `-1` | Disimpan sebagai `NULL` di database dan ditampilkan sebagai tanda `—` di dashboard. Efisiensi filter tidak diasumsikan 100%. |
| **MQ-136 (H₂S Outlet)** | Terpasang | Terbaca | Disimpan di database Turso dan disajikan pada panel pemurnian. |
| **MQ-4 (CH₄ Gas Line)** | Terpasang | Terbaca | Disimpan di database Turso dan disajikan pada gauge konsentrasi metana. |
| **MQ-4 (Kebocoran Ambient)** | Terpasang | Terbaca (~7.6 ppm) | **Belum Tervalidasi**: Ditampilkan di dashboard dengan label disclaimer khusus karena pengujian di ruang terbuka belum terkalibrasi chamber gas standar. |
| **DHT22 #1 & #2 (Suhu/Hum)** | Terpasang | Timeout / Unresponsive | Driver firmware ESP32 mengalami kendala waktu sinyal DHTesp (NAN). Disimpan sebagai `NULL` dan dashboard menampilkan `—` (tidak menampilkan suhu palsu 0°C atau 25°C). |
| **Sensor pH (GPIO33)** | Belum terpasang | Floating ADC | Nilai pembacaan mentah difilter ketat (`ph < 0 || ph > 14`). Dashboard dan backend tidak menampilkan pH palsu (ditampilkan `—`). |
| **Solenoid Valve** | Terpasang | Terkontrol otomatis / manual | Status valve dilaporkan jujur melalui topik state. Perintah aktuator memerlukan autentikasi JWT. |

---

## 5. Fitur Utama yang Selesai

1. **Dual Database Engine (Turso Cloud & SQLite WAL)**:
   - Mendukung Turso Cloud berbasis HTTP (`@libsql/client`) untuk arsitektur serverless/cloud.
   - Fallback otomatis ke database lokal SQLite menggunakan WAL mode untuk pengujian offline tanpa jaringan.
2. **Offline Dashboard Snapshot (`/api/device/snapshot`)**:
   - Ketika ESP32 sedang offline atau dicabut, backend secara otomatis mengambil record terakhir dari Turso Cloud dan memetakan 17 field telemetry ke bentuk siap konsumsi frontend.
   - Frontend menampilkan label transparan: *"Data terakhir diterima"* beserta timestamp lokal.
3. **MQTT Telemetry Ingestion (TLS 8883)**:
   - Terkoneksi aman ke HiveMQ Cloud dengan TLS.
   - Parsing dan validasi payload menggunakan Zod.
   - Logging terstruktur tanpa membocorkan token atau kredensial sensitif.
4. **CORS Dinamis & Cloudflare Quick Tunnel**:
   - CORS middleware mengizinkan akses dari `localhost:3000`, preview branch, serta seluruh subdomain `https://*.vercel.app`.
   - Script `npm run tunnel:start` untuk membuat URL HTTPS publik secara instan tanpa perlu akun berbayar.
5. **Keamanan Eksekusi Aktuator**:
   - `PUBLIC_MQTT_TEST_MODE`: Mode proteksi publik yang memblokir semua perintah valve dan kalibrasi (HTTP 403) jika diaktifkan.
   - Autentikasi berbasis JWT dengan role `operator` dan `admin`.

---

## 6. Cara Menjalankan Backend Secara Lokal

### Prasyarat
- Node.js v20+ atau v22+
- npm v10+

### Langkah Menjalankan:
```bash
# 1. Masuk ke direktori backend
cd NeX-Gas-Backend

# 2. Salin template konfigurasi environment
cp .env.example .env

# 3. Sesuaikan .env dengan kredensial Anda:
# - TURSO_DATABASE_URL & TURSO_AUTH_TOKEN (opsional, untuk cloud)
# - MQTT_HOST, MQTT_USERNAME, MQTT_PASSWORD (HiveMQ Cloud)

# 4. Install dependensi
npm install

# 5. Jalankan mode development
npm run dev

# 6. Atau build dan jalankan mode produksi
npm run build
npm start
```
Server akan aktif di `http://localhost:5001` dan WebSocket di `ws://localhost:5001/ws`.

### Menjalankan Pengujian (Test Suite):
```bash
npm test
```
Seluruh 29 file pengujian (206 tests) mencakup unit test, integritas endpoint REST, validasi schema, pemetaan Zod, dan ketahanan WebSocket.

---

## 7. Cloudflare Tunnel (Akses Eksternal)

Untuk menghubungkan frontend di Vercel dengan backend lokal:
```bash
# Memulai tunnel publik
npm run tunnel:start

# Menghentikan tunnel
npm run tunnel:stop
```
URL publik yang dihasilkan dapat dimasukkan ke variabel `NEXT_PUBLIC_API_URL` dan `NEXT_PUBLIC_WS_URL` di Vercel.

---

## 8. Lisensi & Kontributor

Proyek ini dikembangkan oleh Tim Pengembang NEX-GAS untuk mendukung transisi energi terbarukan ramah lingkungan.
