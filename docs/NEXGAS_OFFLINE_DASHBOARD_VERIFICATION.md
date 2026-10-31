# Laporan Verifikasi Dashboard NEX-GAS Saat Perangkat Offline

Dokumen ini memverifikasi bahwa dashboard NEX-GAS tetap berfungsi penuh, informatif, dan akurat menampilkan kondisi terakhir perangkat saat ESP32 dalam status **OFFLINE**, dengan data yang diambil langsung dari **Turso Cloud** tanpa rekayasa atau data mock.

---

## 1. Verifikasi Data Turso Cloud (Record Terakhir Alat Fisik)

Record terakhir yang dikirimkan oleh ESP32 sebelum dicabut berada pada tabel `telemetry_history` Turso Cloud:
- **Record ID**: `189`
- **Timestamp Penerimaan**: `2026-10-31T15:59:31.131Z` (Pukul **22:59:31 WIB**, 31 Oktober 2026)
- **Uptime Firmware**: `573777 ms` (~9.5 menit)
- **Sensor Kebocoran (MQ-4 #2 ambient)**: `7.595573 ppm`
- **Sensor CH₄ (MQ-4 #1 jalur gas)**: `-1` (`null`) — belum ada pembacaan
- **Sensor H₂S (MQ-136 #1 inlet & #2 outlet)**: `-1` (`null`) — belum ada pembacaan
- **Sensor Suhu & Kelembapan (DHT22 #1 & #2)**: `-1` (`null`) — timeout / belum terhubung
- **Pin GPIO33 (pH floating tanpa sensor)**: `20.71882` (tegangan analog floating karena sensor pH belum dipasang)
- **Status Perangkat**: `offline`

```json
{
  "id": 189,
  "device_id": "nexgas-001",
  "received_at": "2026-10-31T15:59:31.131Z",
  "uptime_ms": 573777,
  "leak_ppm": 7.595573,
  "ch4_estimate": null,
  "h2s_after": null,
  "temperature_c": null,
  "humidity_pct": null,
  "ph": 20.71882,
  "raw_payload": "{\"ts\":1793462370,\"uptimeMs\":573777,\"h2sBefore\":-1,\"h2sAfter\":-1,\"ch4\":-1,\"leak\":7.595573,\"pressureDigester\":-1,\"pressureCollector\":-1,\"temperature\":-1,\"humidity\":-1,\"gasLineTemperature\":-1,\"gasLineHumidity\":-1,\"ph\":20.71882,\"flow\":0,\"gasSinceStartL\":0,\"sensorsReady\":true,\"rssi\":-54}"
}
```

---

## 2. Implementasi Perbaikan Endpoint & Frontend

1. **Endpoint REST Snapshot Publik (`/api/device/snapshot`)**:
   - Ditambahkan pada backend ([routes.ts](file:///Users/bonson/Documents/NEXGAS/NeX-Gas-Backend/src/api/routes.ts)) untuk menyediakan kondisi terakhir perangkat dan telemetry historis dari Turso Cloud secara langsung saat klien membuka dashboard tanpa perlu otentikasi login manual.
2. **Label dan Waktu Penerimaan Data**:
   - Header status menampilkan label eksplisit:
     `Data terakhir diterima: 22.59.31 WIB (31 Okt 2026)`
   - Status badge perangkat tetap **`Offline`** (warna merah `danger`, tanpa rekayasa online palsu).
3. **Penyaringan Ketat Sensor pH**:
   - Nilai pembacaan pH mentah di luar rentang fisiologis 0–14 (seperti `20.71882` akibat floating pin GPIO33) dan belum terkalibrasi secara ketat diubah menjadi `-1` (`SENSOR_UNAVAILABLE`).
   - UI menampilkan **`— pH`** dengan label status **`Sensor belum dipasang`** dan keterangan *"Sensor pH belum dipasang pada alat"*.
4. **Keamanan Parameter Gas & Kualitas Biogas**:
   - CH₄ dan H₂S bernilai `-1` ditampilkan sebagai **`— %`** dan **`— ppm`** dengan status **`Menunggu data alat`**.
   - Status Kualitas Biogas **TIDAK** menyatakan *"Aman"*; melainkan bertuliskan **`Data Belum Lengkap`** / **`Menunggu Data`** dengan indikator netral karena parameter esensial belum terpenuhi.
5. **Representasi Sensor Kebocoran (MQ-4)**:
   - Nilai kebocoran `7.595573` ditampilkan secara jujur sebagai pembacaan terakhir: **`7.6 ppm`** dengan status **`Belum tervalidasi`** dan hint *"Pembacaan terakhir sebelum alat offline"*.
6. **Sensor Lingkungan (DHT22)**:
   - Suhu dan Kelembapan Digester serta Jalur Gas menampilkan **`— °C`** dan **`— %`** dengan status **`Sensor belum ada`** dan hint *"DHT22 belum terhubung"*.

---

## 3. Bukti Tangkapan Layar Browser (Live Rendered Dashboard)

Berikut adalah tangkapan layar penuh dari browser Google Chrome pada `http://localhost:3000`:

![Dashboard NEX-GAS Saat Offline](/Users/bonson/.gemini/antigravity/brain/dd7a69d5-1e4f-4881-977d-28e50ab67a14/dashboard_screenshot_full.png)

---

## 4. Hasil Pengujian Backend & Frontend

- **NeX-Gas-Backend Build**: Sukses (`tsc` exit 0).
- **NeX-Gas-Backend Tests**: 29/29 test files lolos, 206/206 tests passed (100%).
- **NeX-Gas-Frontend Lint**: 0 warning, 0 error (`eslint` exit 0).
- **NeX-Gas-Frontend Build**: Sukses terkompilasi dalam 936 ms (Next.js Turbopack).
