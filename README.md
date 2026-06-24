# Storage Organizer Web

一個可搜尋、可共同編輯、支援暫存區與 LLM 覆核提示詞的家庭收納系統。

## 本機開發

```bash
npm install
npm run build
npm start
```

開發模式：

```bash
npm run dev
```

後端 API：

```bash
npm run dev:server
```

## 環境變數

- `APP_PASSWORD`: 共同編輯密碼，預設為 `0505`
- `PORT`: 伺服器埠號，預設為 `3000`
- `DATA_ROOT`: 共享資料實際寫入的資料夾

如果沒有設定 `DATA_ROOT`，系統會使用專案內的 `data/`。

## 資料來源

- 初始結構種子：`src/data/inventory.json`
- 本機共享資料：`data/inventory.shared.json`
- 正式部署持久化資料：`$DATA_ROOT/inventory.shared.json`

當正式部署的資料檔不存在時，系統會優先用 `data/inventory.shared.json` 當種子；若找不到，才退回 `src/data/inventory.json`。

## Render 正式部署

專案已內建 `render.yaml`，適合部署成一個 Node Web Service。

### 部署前準備

1. 把整個 `storage-organizer-web` 推到 GitHub。
2. 登入 [Render](https://render.com/)。
3. 選擇 `New +` -> `Blueprint`。
4. 連接你的 GitHub repo。
5. 匯入根目錄的 `render.yaml`。
6. 在 Render 介面填入 `APP_PASSWORD`。

### 這份設定會做什麼

- `buildCommand`: `npm ci && npm run build`
- `startCommand`: `npm start`
- `healthCheckPath`: `/api/health`
- `DATA_ROOT`: 指向 Render persistent disk
- `disk`: 掛載在 `/opt/render/project/src/storage`

### 重要提醒

- 共享資料寫入本機檔案，所以要保留編輯內容，必須使用 Render 的 persistent disk。
- Render 的 persistent disk 只會保留掛載路徑下的檔案。
- 這代表正式上線時請不要把共享資料留在容器的暫存檔系統。

## 驗證指令

```bash
npm run lint
npm run build
node --check server.mjs
```
