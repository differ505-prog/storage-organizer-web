# Storage Organizer Web

一個可搜尋、可共同編輯、支援暫存區與 LLM 覆核提示詞的家庭收納系統。

## 本機開發

```bash
npm install
npm run dev
```

如果你要測正式版打包：

```bash
npm run build
npm run preview
```

## 環境變數

- `VITE_SUPABASE_URL`: Supabase 專案網址
- `VITE_SUPABASE_ANON_KEY`: Supabase anon key
- `VITE_EDIT_PASSWORD`: 前端顯示與編輯解鎖密碼，預設 `0505`

可先複製 `.env.example`：

```bash
cp .env.example .env.local
```

## 資料來源

- 初始結構種子：`src/data/inventory.json`
- 本次匯入種子：`data/inventory.shared.json`
- Supabase 初始化 SQL：`supabase/setup.sql`

如果尚未設定 Supabase，前端會退回 `src/data/inventory.json` 以唯讀模式顯示。

## 免卡部署方案

推薦用：

- 前端：`Vercel`
- 雲端資料：`Supabase`

這樣可以避開 Render persistent disk 的付費要求。

## Supabase 設定

1. 到 [Supabase](https://supabase.com/) 建立新專案
2. 開啟 `SQL Editor`
3. 把 `supabase/setup.sql` 全部貼上並執行
4. 到 `Project Settings -> Data API`
5. 複製：
   - `Project URL`
   - `anon public key`

### SQL 會做什麼

- 建立 `public.storage_items`
- 開啟讀寫政策
- 匯入目前的收納資料

### 重要提醒

- 目前這版的「密碼 0505」是前端的簡易解鎖，不是高安全性帳號系統。
- 這很適合家庭共用，但不適合放真正敏感資料。
- 如果你之後要更嚴謹，我可以再改成 Supabase Auth 或 Vercel API 驗證版。

## Vercel 部署

1. 到 [Vercel](https://vercel.com/) 用 GitHub 登入
2. `Add New...` -> `Project`
3. 選擇這個 repo：`differ505-prog/storage-organizer-web`
4. 匯入後打開 `Environment Variables`
5. 新增：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_EDIT_PASSWORD`
6. `VITE_EDIT_PASSWORD` 填 `0505`
7. 按 `Deploy`

Vercel 會自動偵測這是 Vite 專案，不需要卡號。

## 你實際要做的最短步驟

1. 在 Supabase 建專案
2. 執行 `supabase/setup.sql`
3. 把 `Project URL` 與 `anon key` 貼進 Vercel
4. 部署完成後，用 `0505` 解鎖編輯

## 驗證指令

```bash
npm run lint
npm run build
```
