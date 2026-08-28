# Meet Transcript Saver

一個不需要後端的 Chrome Extension。它會讀取 Google Meet 畫面上已顯示的即時字幕，保存在 Chrome 本機，並匯出成 Markdown 或 JSON。

## MVP 功能

- 手動開始、停止字幕擷取
- 保存講者、字幕文字與時間
- 合併 Meet 持續修正的同一段字幕，避免逐字重複
- popup 關閉後仍持續擷取
- Meet 分頁重新整理後恢復進行中的 session
- 保留多次會議紀錄
- 匯出 Markdown 與 JSON
- 不錄音、不呼叫 Google Meet API、不傳送到外部伺服器

## 安裝

1. 在 Chrome 開啟 `chrome://extensions`。
2. 開啟右上角的「開發人員模式」。
3. 點「載入未封裝項目」。
4. 選取本 repository 的根目錄。
5. 第一次安裝後，重新整理已經開啟的 Google Meet 分頁。

這個專案不需要執行 build，也不需要安裝 npm package。

## 使用

1. 進入 Google Meet 會議。
2. 按 Meet 下方工具列的「即時字幕」，讓字幕出現在畫面上。
3. 點 Chrome 工具列中的 extension 圖示。
4. 按「開始擷取」。
5. 看到「正在擷取字幕」後，可以關閉 popup；擷取仍會繼續。
6. 會議結束前按「停止」。
7. 選擇保存的會議，匯出 Markdown 或 JSON。

如果狀態一直停在「正在等待字幕」，先確認畫面真的出現過一段字幕。若 extension 是在 Meet 分頁開啟後才安裝，也要先重新整理該分頁。

## 資料格式

每個字幕段落包含：

```json
{
  "speaker": "Howie",
  "text": "今天我們先確認產品的時程。",
  "status": "final",
  "startedAt": "2026-08-28T02:58:49.000Z",
  "updatedAt": "2026-08-28T02:58:55.000Z",
  "finalizedAt": "2026-08-28T02:58:55.000Z"
}
```

所有 session 都以 extension 專用的 `chrome.storage.local` 保存。匯出的 JSON 使用 `schemaVersion: 1`，方便未來加入其他格式。

## 開發與驗證

需要 Node.js 18 或更新版本：

```sh
npm test
npm run check
```

變更程式後，到 `chrome://extensions` 按此 extension 的重新載入按鈕，再重新整理 Meet 分頁。

### 手動測試清單

- [ ] 未開字幕時顯示「正在等待字幕」
- [ ] 第一位講者出現後變為「正在擷取字幕」
- [ ] 同一句逐步增長時只保存一段
- [ ] 兩位講者輪流說話時能分成不同段落
- [ ] 關閉 popup 後仍繼續保存
- [ ] 重新整理 Meet 分頁後可恢復進行中的 session
- [ ] 停止後可以分別匯出 Markdown 與 JSON
- [ ] 在非 Meet 分頁仍可匯出已保存的會議

## 已知限制

- 只能保存目前使用者畫面上有顯示的 Google Meet 即時字幕。
- Google Meet 沒有公開、穩定的即時字幕 DOM API；Meet 改版後可能需要調整字幕區域辨識方式。
- 字幕關閉、分頁被瀏覽器休眠或網路中斷期間的內容無法補回。
- MVP 沒有提供刪除歷史 session 的 UI；可在 Chrome 的 extension 資料中清除。
- 長時間、大量會議最終會受到 `chrome.storage.local` 容量限制，正式版應加入容量提示與歷史管理。

## 隱私

逐字稿可能包含個人通訊內容。使用前請告知與會者，並依組織政策與所在地規定取得必要同意。

目前版本只在本機處理及保存資料，沒有分析服務、追蹤器或任何外部資料傳輸。
