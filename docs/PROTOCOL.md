# Nova Rush – Giao thức client ↔ server

Tài liệu này là "hợp đồng" giữa server và mọi client (PixiJS hiện tại, Cocos sau này).
Client nào tuân theo đúng giao thức này đều chơi được.

## Quy ước chung

- Tiền luôn là **số nguyên cent**: `100` = 1.00 credit.
- Multiplier tại thời điểm `t` ms kể từ khi bay: `floor(e^(0.00006·t) · 100) / 100`.
  Client phải dùng **đúng** công thức này (xem `client/src/core/curve.ts` và `server/src/fair.js`).
- Server là nguồn sự thật duy nhất. Client chỉ vẽ lại; mọi cash-out được server tính theo đồng hồ của server.

## REST (`/api`)

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| POST | `/api/login` `{username}` | – | Tạo hoặc đăng nhập tài khoản demo, trả về `{token, user}` |
| GET | `/api/me` | Bearer | Thông tin user |
| GET | `/api/my-bets` | Bearer | 50 cược gần nhất |
| GET | `/api/config` | – | Giới hạn cược, house edge |
| GET | `/api/fair` | – | Terminal hash, salt, công thức |
| GET | `/api/rounds/recent` | – | 30 vòng gần nhất (hash, crash point, salt, edge) |
| POST | `/api/verify` `{hash, salt, houseEdge}` | – | Tính lại crash point |

Admin: `/api/admin/*`, đăng nhập bằng `POST /api/admin/login {password}` → Bearer token (xem `server/src/api.js`).

## WebSocket (`/ws`)

Mọi message có dạng JSON `{ "t": <type>, "d": <payload> }`.

### Client → Server

| t | d | Phản hồi |
|---|---|---|
| `ping` | `{c: clientTimeMs}` | `pong {c, serverTime}`, dùng để đồng bộ đồng hồ |
| `auth` | `{reqId, token}` | `ack {reqId, ok, user, myBets}` |
| `bet` | `{reqId, slot: 0\|1, amount, autoCashout: number\|null}` | `ack {reqId, ok, bet}`; chỉ nhận trong pha `betting` |
| `cancel` | `{reqId, slot}` | `ack {reqId, ok}`; chỉ nhận trong pha `betting` |
| `cashout` | `{reqId, slot}` | `ack {reqId, ok, bet}`; chỉ nhận trong pha `running` |

Khi lỗi: `ack {reqId, ok: false, code, error}`. Các mã lỗi: `NOT_BETTING`, `NOT_RUNNING`, `BAD_SLOT`, `BAD_AMOUNT`,
`BAD_AUTO`, `DUP_BET`, `NO_FUNDS`, `NO_BET`, `DONE`, `CRASHED`, `BANNED`, `AUTH`.

### Server → Client

| t | d |
|---|---|
| `hello` | `{serverTime, config, online, round, bets[], history[]}`, gửi ngay khi kết nối |
| `round:betting` | `{phase, roundId, bettingEndsAt}` |
| `round:running` | `{phase, roundId, startedAt}` |
| `round:crashed` | `{phase, roundId, crashPoint, hash, crashedAtMs}` |
| `round:paused` | `{}`, admin đã tạm dừng game |
| `bet` | `PublicBet`, có người vừa đặt cược |
| `cancel` | `{username, slot}` |
| `cashout` | `PublicBet` (có `cashoutAt`, `payout`) |
| `balance` | `{balance}`, chỉ gửi cho chính chủ |
| `online` | `{count}` |
| `config` | cấu hình mới sau khi admin sửa |
| `kicked` | `{reason}`, tài khoản bị khoá |

`PublicBet = {username, slot, amount, autoCashout, cashoutAt, payout}`

### Vòng đời một vòng chơi

```
betting (bettingMs) ──► running (đến khi m ≥ crashPoint) ──► crashed (crashedMs) ──► betting ...
                                                                   │
                                            admin bật "paused" ────┴──► paused (chờ đến khi tắt)
```
