# OpenStick Control Center

Panel web untuk mengontrol dan memantau WiFi dan 4G di Linux OpenStick menggunakan `nmcli` (NetworkManager) dan `mmcli` (ModemManager, opsional untuk info sinyal/operator).

Tanpa dependency npm, hanya modul bawaan Node.js (>= 12).

## Fitur
- Dashboard: status konektivitas, interface, IP, kecepatan up/down real-time, CPU/RAM/suhu
- Saklar radio WiFi dan WWAN
- WiFi: scan, sambung/putus, hotspot (AP)
- 4G: info modem (operator, teknologi, sinyal, IMEI), profil APN, sambung/putus, reset modem
- Kelola koneksi tersimpan (aktifkan, putus, autoconnect, hapus)
- Reboot perangkat

## Prasyarat
```
apt install network-manager modemmanager nodejs
```
Jalankan sebagai root (atau user dengan izin polkit untuk NetworkManager).

## Instalasi
```
mkdir -p /opt/openstick-cc
cp server.js index.html package.json /opt/openstick-cc/
cp openstick-cc.service /etc/systemd/system/
nano /etc/systemd/system/openstick-cc.service   # ganti AUTH_PASS
systemctl daemon-reload
systemctl enable --now openstick-cc
```
Buka `http://<ip-openstick>:8080`.

Coba manual: `AUTH_PASS=rahasia node server.js`

## Environment
| Variabel | Default | Keterangan |
|---|---|---|
| PORT | 8080 | Port HTTP |
| HOST | 0.0.0.0 | Alamat bind |
| AUTH_USER | admin | Username Basic Auth |
| AUTH_PASS | (kosong) | Password; kosong = tanpa autentikasi |

## API singkat
- `GET /api/status`
- `GET /api/wifi/scan?ifname=wlan0`
- `POST /api/wifi/connect` `{ssid,password,ifname}` · `POST /api/wifi/disconnect` `{ifname}`
- `POST /api/radio` `{type:"wifi"|"wwan",enabled}`
- `POST /api/hotspot/start` `{ifname,ssid,password,band}` · `POST /api/hotspot/stop`
- `GET /api/mobile` · `POST /api/mobile/profile` `{name,apn,username,password,pin,connect}` · `POST /api/mobile/reset`
- `POST /api/connection/{up,down,delete,autoconnect}` `{uuid}`
- `POST /api/system/reboot`

## Catatan keamanan
- Selalu set `AUTH_PASS`. Basic Auth tidak terenkripsi, jadi akses hanya lewat jaringan tepercaya (misal LAN/USB), jangan diekspos ke internet.
- Hotspot dibuat dengan PMF dinonaktifkan (`802-11-wireless-security.pmf 1`) karena driver WiFi OpenStick sering gagal dengan error "802.1X supplicant took too long to authenticate".
- Password WiFi/APN dikirim ke `nmcli` lewat argumen, sehingga bisa terlihat sekilas di `ps` oleh user lokal lain.
- Semua perintah memakai `execFile` (tanpa shell), jadi input tidak bisa menyisipkan perintah.
