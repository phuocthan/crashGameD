# Nova Rush 🚀

Game **Crash** gốc (thiết kế, đồ hoạ và code đều tự làm) dành cho portfolio:

- **Client PixiJS v8** (TypeScript + Vite): đồ thị multiplier realtime, tàu "Nova Pod" vẽ bằng vector, particle, hiệu ứng nổ, 2 ô cược, auto cash-out, auto bet.
- **Server Node.js** (Express + WebSocket + SQLite tích hợp sẵn trong Node): server quyết định mọi kết quả, **provably fair** bằng chuỗi hash SHA-256.
- **Admin tool**: dashboard realtime, quản lý user (cộng/trừ tiền, khoá), lịch sử vòng chơi, cấu hình game, đổi seed chain, audit log.

> Chỉ dùng credit demo, không có tiền thật.

## Chạy local

Yêu cầu **Node.js ≥ 22.13** (dùng `node:sqlite`; đã kiểm tra trên Node 24).

```powershell
npm install
```

```powershell
npm run dev
```

| Trang | URL |
|---|---|
| Game (dev, hot reload) | http://localhost:5180 |
| Admin | http://localhost:3001/admin (mật khẩu mặc định `admin123`) |

Đổi mật khẩu admin hoặc port bằng biến môi trường:

```powershell
$env:ADMIN_PASSWORD = "mat-khau-moi"; $env:PORT = "3001"; npm run dev
```

Bản production: `npm run build` rồi `npm start`, khi đó game được phục vụ luôn ở http://localhost:3001.
Database nằm ở `server/data/nova-rush.db`. Xoá file này để reset toàn bộ dữ liệu.

Test thuật toán provably fair:

```powershell
npm test -w server
```

## Cấu trúc

```
server/
  src/fair.js     chuỗi hash, công thức crash point, đường cong multiplier
  src/game.js     vòng chơi: betting → running → crashed, đặt/huỷ/cash-out, auto cash-out
  src/hub.js      WebSocket: đẩy sự kiện, nhận lệnh
  src/api.js      REST cho người chơi và admin
  src/db.js       schema SQLite, settings, audit log
  src/bots.js     bot chỉ để hiển thị (không đụng số dư, không tính vào thống kê)
  public/admin/   admin tool (HTML/CSS/JS thuần)
client/
  src/core/       ★ logic thuần TypeScript, KHÔNG phụ thuộc PixiJS → tái dùng cho Cocos
  src/view/       renderer PixiJS (GameScene, Ship)
  src/ui/         UI DOM: ô cược, modal provably fair, toast
docs/PROTOCOL.md  giao thức client ↔ server
```

## Provably fair hoạt động thế nào

1. Server sinh `seed` bí mật, tạo chuỗi `h[0] = sha256(seed)`, `h[k] = sha256(h[k-1])` gồm 10.000 game.
2. Hash cuối (`terminal hash`) được công bố **trước** khi chơi.
3. Các game dùng chuỗi theo chiều ngược lại. Sau mỗi vòng, hash của vòng đó được công khai.
   Ai cũng kiểm tra được `sha256(hash vòng này) == hash vòng trước`.
4. `crash = max(1, floor((1 − edge) / (1 − x) · 100) / 100)` với `x` lấy từ `HMAC_SHA256(hash, salt)`.
   Từ đó `P(crash ≥ m) = (1 − edge) / m`, RTP lý thuyết = 1 − edge.

Người chơi bấm **Fairness** trong game để tự kiểm tra ngay trên trình duyệt (Web Crypto), không cần tin server.

## Chuyển sang Cocos Creator

Kiến trúc đã tách sẵn để việc port chỉ phải viết lại phần hiển thị:

| Phần | Khi port sang Cocos |
|---|---|
| `client/src/core/*` (`GameClient`, `curve`, `types`, `emitter`) | **Copy nguyên** vào `assets/scripts/core/`. Cocos chạy TS và có `WebSocket`, `fetch`. Chỉ cần thay `localStorage` bằng `sys.localStorage` |
| `client/src/view/GameScene.ts` | Viết lại bằng `Graphics` của Cocos (đường cong, lưới), `ParticleSystem2D` (khói, nổ), `Label` (multiplier) |
| `client/src/ui/*` | Dựng lại bằng prefab/UI của Cocos; logic trạng thái nút cược trong `BetPanel.view()` có thể giữ nguyên |
| `server/` | Không đổi gì |

Gợi ý: tách `BetPanel.view()` thành một hàm thuần trong `core/` trước khi port, để cả hai bản dùng chung.

## Hướng phát triển tiếp

- Đăng nhập có mật khẩu/OAuth, rate limit cho WebSocket
- Client seed do người chơi tự đặt
- Chat, bảng xếp hạng, hiệu ứng âm thanh
- Đóng gói Docker
