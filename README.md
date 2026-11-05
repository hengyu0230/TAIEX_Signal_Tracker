# 台股止跌訊號

自動整理外資買賣超、融資餘額、新台幣匯率、加權指數 K 線與均線，以及美股主要指數，
依四項條件判斷台股是否趨穩。資料由 GitHub Actions 定時抓取，網頁以 GitHub Pages 發布，
可在 iPhone「加入主畫面」後當作 App 使用。

## 部署步驟
1. 在 GitHub 建立新的公開（Public）儲存庫，將本資料夾所有檔案（含 `.github` 資料夾）上傳。
2. 進入儲存庫的 Settings → Pages，Source 選「Deploy from a branch」，分支選 `main`、資料夾選 `/ (root)`，儲存。
3. 進入 Settings → Actions → General，Workflow permissions 選「Read and write permissions」，儲存。
4. 進入 Actions 頁面，選「更新市場資料」，點「Run workflow」手動執行一次，建立第一份資料。
5. 約一至兩分鐘後，開啟 `https://<你的帳號>.github.io/<儲存庫名稱>/`。

## 加入 iPhone 主畫面
用 Safari 開啟網址 → 點分享按鈕 → 「加入主畫面」。

## 調整判斷門檻
編輯 `scripts/fetch-data.mjs` 最上方的 `CFG`，下次排程更新後生效。

資料來源：臺灣證券交易所、臺灣期貨交易所、美國聯準會經濟資料庫（FRED）、CNBC、Yahoo Finance、Google 新聞與各媒體 RSS。本工具依固定規則整理公開資料，不構成投資建議。

## 安全與隱私說明
- 本工具不需要也不保存任何帳號、密碼、金鑰或個人資料；網頁不使用 Cookie、追蹤或第三方程式。
- 網頁設有內容安全政策（CSP），只允許載入本網站自己的檔案；資料內容一律以純文字方式顯示。
- 網頁設定為不被搜尋引擎收錄，但公開儲存庫仍會出現在 GitHub 個人頁面上，知道帳號的人可以找到。
- 建議在 GitHub 的 Settings → Emails 勾選「Keep my email addresses private」，避免電子郵件出現在提交紀錄中。
- 自動排程只使用 GitHub 內建的權限，且僅能寫入本儲存庫；不會在其他事件（例如他人提出的 Pull Request）時執行。
- 資料來自臺灣證券交易所、臺灣期貨交易所、Yahoo Finance 與 Google 新聞，僅供個人非商業參考，請勿用於收費或商業用途。
- 新聞只保留標題、來源、時間與連結，僅接受 https 連結，點擊後以新分頁開啟且不傳送來源網址。
- 外觀設定與手機分頁選擇儲存在瀏覽器本機，不含任何個人資料。
