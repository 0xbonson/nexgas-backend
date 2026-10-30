# NEX-GAS Backend Service

Backend service for **NEX-GAS** (Anaerobic Digestion & Biogas Monitoring System). Built with Node.js, Express 5, TypeScript (NodeNext ESM), SQLite (`better-sqlite3` in WAL mode), `ws` WebSocket gateway, and `mqtt.js` with HiveMQ Cloud TLS.

---

## 1. Arsitektur Sistem

```
┌─────────────────┐       MQTT (TLS 8883)       ┌────────────────────────────────────────────────────────┐
│  ESP32 DevKit   │ ──────────────────────────> │                   NeX-Gas-Backend                      │
│ (Gas & Pressure │ <────────────────────────── │                                                        │
│  Sensors, Valve)│        Command (cmd)        │  1. MQTT Service (TLS, auto-reconnect, Zod validation) │
└─────────────────┘                             │  2. SQLite Persistence (WAL mode, NULL preservation)   │
                                                │  3. REST API (Express 5, CORS, sliding-window limiter) │
                                                │  4. WebSocket Gateway (Heartbeat, live broadcasts)     │
                                                └──────────────────────────┬─────────────────────────────┘
                                                                           │  HTTP REST & WebSocket
                                                                           ▼
                                                ┌────────────────────────────────────────────────────────┐
                                                │                   NeX-Gas-Frontend                     │
                                                │         (Next.js 16 SPA, Dashboard, History)           │
                                                └────────────────────────────────────────────────────────┘
```

---

## 2. Cara Menjalankan Backend Secara Lokal

### Prasyarat
- Node.js v20+ atau v22+ (teruji pada Node.js v26.12.1)
- npm v10+

### Langkah Instalasi & Menjalankan:
```bash
# 1. Masuk ke folder backend
cd NeX-Gas-Backend

# 2. Salin template konfigurasi environment
cp .env.example .env

# 3. Install dependencies
npm install

# 4. Jalankan migrasi database SQLite dan jalankan server dalam mode development
npm run dev

# Atau build dan jalankan dalam mode produksi:
npm run build
npm start
```
Server akan aktif di `http://localhost:3001` dan WebSocket di `ws://localhost:3001/ws`.

---

## 3. Cara Menjalankan Frontend Secara Lokal

```bash
# 1. Masuk ke folder frontend
cd ../NeX-Gas-Frontend

# 2. Salin konfigurasi environment
cp .env.example .env.local

# 3. Pastikan mengarah ke backend lokal di .env.local:
# NEXT_PUBLIC_API_URL=http://localhost:3001
# NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
# NEXT_PUBLIC_DEVICE_ID=nexgas-001

# 4. Install dependencies & jalankan server Next.js
npm install
npm run dev
```
Buka `http://localhost:3000` di peramban web.

---

## 4. Environment Variables Reference

Konfigurasi backend diatur melalui `.env` (divalidasi oleh Zod di `src/config/env.ts`):

| Variabel | Tipe | Default | Keterangan |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | string | `development` | Environment runtime (`development`, `production`, `test`) |
| `PORT` | number | `3001` | Port HTTP REST API dan WebSocket gateway |
| `HOST` | string | `0.0.0.0` | Host interface address |
| `MQTT_BROKER_HOST` | string | *wajib jika connect* | Hostname cluster HiveMQ Cloud |
| `MQTT_BROKER_PORT` | number | `8883` | Port TLS HiveMQ Cloud |
| `MQTT_USERNAME` | string | *wajib jika connect* | Kredensial username broker MQTT |
| `MQTT_PASSWORD` | string | *wajib jika connect* | Kredensial password broker MQTT |
| `DEFAULT_DEVICE_ID` | string | `nexgas-001` | ID default perangkat ESP32 |
| `DATABASE_PATH` | string | `./data/nexgas.sqlite` | Lokasi file database SQLite (`:memory:` untuk testing) |
| `LOG_LEVEL` | string | `info` | Level log (`trace`, `debug`, `info`, `warn`, `error`) |
| `CORS_ALLOWED_ORIGINS`| string | `http://localhost:3000,...` | Daftar origin yang diizinkan (dipisah koma) |
| `RATE_LIMIT_COMMAND_MAX` | number | `10` | Batas maksimum perintah per window rate limit |
| `RATE_LIMIT_COMMAND_WINDOW_MS`| number | `10000` | Durasi window rate limit command (ms) |

---

## 5. MQTT Topics & Payloads (Firmware Contract)

Struktur topik: `nexgas/{DEVICE_ID}/{TOPIC_TYPE}`

### 1. Telemetry (`nexgas/{DEVICE_ID}/telemetry`)
Dipublikasikan setiap ~5 detik oleh ESP32.
```json
{
  "ts": 1730282400,
  "uptimeMs": 125000,
  "h2sBefore": -1,
  "h2sAfter": 2.3,
  "ch4": 64.5,
  "leak": 0,
  "pressureDigester": 1.45,
  "pressureCollector": 0.95,
  "temperature": 36.5,
  "humidity": 86.0,
  "gasLineTemperature": 34.0,
  "gasLineHumidity": 82.0,
  "ph": 7.15,
  "flow": 0.05,
  "gasSinceStartL": 145.2,
  "sensorsReady": true,
  "rssi": -62
}
```

### 2. State (`nexgas/{DEVICE_ID}/state`)
Dipublikasikan secara retain saat terjadi perubahan status atau setiap 30 detik.
```json
{
  "valveOpen": false,
  "valveMode": "auto",
  "filterWarning": false,
  "leakWarning": false,
  "filterHealth": 94,
  "pressureCalibrated": true,
  "phCalibrated": true,
  "sensorsReady": true,
  "buffered": 0,
  "uptimeMs": 130000,
  "firmware": "1.0.0"
}
```

### 3. Status (`nexgas/{DEVICE_ID}/status`)
Retained payload: `"online"` saat terhubung, `"offline"` melalui MQTT Last Will & Testament (LWT).

### 4. Event (`nexgas/{DEVICE_ID}/event`)
Dipublikasikan saat terjadi peristiwa perangkat keras penting:
```json
{
  "ts": 1730282600,
  "uptimeMs": 140000,
  "type": "valve_closed_leak",
  "severity": "waspada",
  "message": "Solenoid valve closed automatically due to methane leak threshold"
}
```

### 5. Command (`nexgas/{DEVICE_ID}/cmd`)
Topik langganan firmware untuk menerima instruksi:
- Mode: `{"mode": "auto"}` atau `{"mode": "manual"}`
- Valve: `{"valve": "open"}` atau `{"valve": "close"}`
- Tare: `{"tare": true}`
- Kalibrasi Tekanan: `{"cal_pressure_point": {"sensor": "digester", "kpa": 1.5}}`
- Kalibrasi MQ: `{"cal_mq": {"gas": "h2s", "ref_ppm": 10.0}}`
- Kalibrasi pH: `{"cal_ph": {"ph": 7.0}}`

---

## 6. REST API Reference

Semua response mengembalikan JSON dengan status HTTP standar.

### Diagnostics & Health
- `GET /health`: Status liveness, uptime, heap memory, dan status koneksi MQTT broker (`mqttConnected: true/false`).
- `GET /health/ready`: Status kesiapan layanan (`ready: true`), path database aktif, dan topik MQTT yang dilanggani.
- `GET /api/config`: Konfigurasi runtime non-sensitif (kredensial dan password otomatis disembunyikan).

### Data Terkini
- `GET /api/telemetry/latest?deviceId={deviceId}`: Telemetry terbaru dalam format data normal backend (NULL preservation) dan model `frontend`.
- `GET /api/state?deviceId={deviceId}`: Status valve, mode, dan kesehatan filter saat ini.
- `GET /api/status?deviceId={deviceId}`: Status online/offline LWT perangkat.

### Riwayat & Paginasi
- `GET /api/history/telemetry?deviceId=...&limit=50&offset=0&from=...&to=...`: Riwayat telemetry kronologis.
- `GET /api/history/events?deviceId=...&severity=waspada&type=...&limit=50`: Riwayat event perangkat keras.
- `GET /api/history/state?deviceId=...&limit=50`: Riwayat transisi state valve dan kalibrasi.
- `GET /api/history/status?deviceId=...&limit=50`: Riwayat transisi status online/offline.

### Perintah Valve & Kalibrasi
- `POST /api/command`: Menerbitkan perintah ke topik `nexgas/{deviceId}/cmd` (QoS 1).
  - Body: `{ "deviceId": "nexgas-001", "command": { "mode": "manual" } }`
  - Response jujur (200 OK):
    ```json
    {
      "status": "published",
      "verificationStatus": "pending_execution",
      "message": "Command published to device MQTT topic. Physical execution is governed by ESP32 firmware safety checks.",
      "protocolNote": "Firmware does not emit correlated command ACKs; state transitions are broadcast asynchronously on nexgas/{DEVICE_ID}/state."
    }
    ```
  - Rejection: HTTP 503 jika broker MQTT offline; HTTP 429 jika melebihi rate limit; HTTP 400 jika payload/ID tidak valid.

---

## 7. WebSocket Message Reference

- **Endpoint**: `ws://<host>:<port>/ws`
- **Ping / Pong**: Client mengirim `{"type": "ping"}`; server merespons `{"type": "pong", "timestamp": "..."}`.
- **Broadcast Events**:
  1. `telemetry`: Update pembacaan sensor setiap ~5 detik.
  2. `state`: Update status valve, kalibrasi, dan filter.
  3. `status`: Update online / offline.
  4. `event`: Peristiwa hardware beserta objek mapping notifikasi UI (`AppNotification`).

---

## 8. Database Schema (SQLite WAL)

Database tersimpan di SQLite dengan mode WAL (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`).

1. `schema_migrations`: Pelacakan versi migrasi skema.
2. `telemetry_history`: Riwayat sensor kronologis dengan index `(device_id, received_at)` dan `(device_id, raw_timestamp, uptime_ms)`. Nilai sensor yang tidak tersedia disimpan sebagai `NULL`.
3. `device_current_state`: Baris tunggal per perangkat (UPSERT O(1)) untuk status terkini.
4. `state_history`: Log append-only setiap transisi state valve atau kalibrasi.
5. `device_current_status`: Status koneksi LWT terkini per perangkat.
6. `status_history`: Log append-only setiap transisi koneksi online/offline.
7. `event_history`: Log append-only peristiwa perangkat keras penting (`boot`, `valve_closed_leak`, dll).

---

## 9. Cara Menjalankan Pengujian

```bash
# Menjalankan seluruh 23 test suites (142 unit, integration, & E2E tests) di backend:
cd NeX-Gas-Backend
npm test

# Menjalankan seluruh test suites (20 unit & integration tests) di frontend:
cd ../NeX-Gas-Frontend
npm test
```

---

## 10. Batasan Teknis & Semantik Sensor

1. **Sensor H₂S Hulu (`h2sBefore = -1`)**:
   Sensor MQ-136 kedua (sebelum filter) belum dipasang secara fisik pada prototipe. Nilai `-1` dari firmware dilindungi sebagai `NULL` di database dan `—` di frontend. Sistem **tidak pernah** mengasumsikan efisiensi penyaringan 100% dari data yang tidak ada.
2. **Estimasi CH₄ & Flow**:
   Sensor MQ-4 mengukur resistansi relatif gas, bukan persentase kemurnian gas bersertifikat. Nilai aliran (`flow`) dihitung dari laju penurunan tekanan, bukan flowmeter langsung.
3. **Sinkronisasi NTP (`ts = 0`)**:
   Jika perangkat belum mendapatkan sinkronisasi NTP, `ts = 0` dinormalisasi menjadi `null` pada kolom waktu perangkat, sementara waktu kedatangan backend (`receivedAt`) dan uptime perangkat (`uptimeMs`) tetap dicatat secara akurat.
4. **Keterbatasan Acknowledgment Perintah Firmware**:
   ESP32 firmware mengeksekusi perintah di `handleCommand()` dan mempublikasikan status baru, namun tidak menghasilkan ID korelasi atau acknowledgment diskrit. Backend dan frontend melaporkan status perintah secara jujur sebagai `published` / `pending_execution`, bukan "pasti berhasil dibuka/ditutup".

---

## 11. Panduan Deployment Masa Depan

1. **Backend**:
   - Dapat di-deploy sebagai kontainer Docker di Google Cloud Run, Railway, atau VPS.
   - Menggunakan mount volume persisten untuk file database SQLite (`/data/nexgas.sqlite`).
   - Masukkan kredensial HiveMQ Cloud TLS port 8883 pada environment variables server.
2. **Frontend**:
   - Berupa Next.js static export yang dapat di-hosting di Vercel atau GitHub Pages.
   - Atur `NEXT_PUBLIC_API_URL` ke domain backend HTTPS publik (misal: `https://api.nex-gas.id`).
   - Atur `NEXT_PUBLIC_WS_URL` ke WebSocket WSS publik (misal: `wss://api.nex-gas.id/ws`).

---

## 12. Deploy (Docker / Railway / VPS)

Repo ini menyertakan `Dockerfile` multi-stage (build TypeScript + `better-sqlite3`,
lalu runtime slim) dan `.dockerignore`.

```bash
# build & jalankan lokal
docker build -t nexgas-backend .
docker run -p 5001:5001 --env-file .env -v nexgas-data:/data nexgas-backend

# cek
curl http://localhost:5001/health
curl http://localhost:5001/health/ready
```

Variabel wajib di production:

| Variabel | Catatan |
| --- | --- |
| `JWT_SECRET` | minimal 32 karakter, **tidak boleh** default dev key |
| `CORS_ALLOWED_ORIGINS` | harus memuat origin frontend, mis. `https://nex-gas.vercel.app` |
| `MQTT_HOST` / `MQTT_USERNAME` / `MQTT_PASSWORD` | kredensial HiveMQ Cloud |
| `PUBLIC_MQTT_TEST_MODE` | `true` = semua perintah ditolak (mode uji publik) |
| `DB_PATH` | arahkan ke volume persisten (`/data/nexgas.sqlite` di image) |

Railway: buat project dari repo GitHub ini → service otomatis memakai `Dockerfile`,
tambahkan **Volume** ke `/data`, isi env di atas, lalu generate domain publik.
Backend menyajikan REST dan WebSocket (`/ws`) pada port yang sama.
