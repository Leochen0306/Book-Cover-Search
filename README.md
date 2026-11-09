# 📖 書封知識心智圖 Book Cover Search

上傳（或用手機拍）一本書的封面照片，程式會：

1. **辨識封面**：用 Claude 的視覺能力讀出書名、作者、出版社。
2. **上網搜尋**：用 Claude 的網路搜尋工具找出版社簡介、目錄、書評，並同時查詢 Google Books 書目資料。
3. **擷取知識節點**：把搜尋到的介紹整理成「主旨、篇章、關鍵概念、方法、案例、作者背景…」等有層次的節點。
4. **繪製心智圖**：用 [markmap](https://markmap.js.org/) 畫成可縮放、可收合的心智圖，並可匯出 PNG / SVG / Markdown。

整個程式是純前端（HTML + CSS + JavaScript），不需要後端伺服器，可以直接放在 GitHub Pages 上執行。

## 使用方式

1. 打開網頁，按右上角 **⚙️ 設定**，貼上你的 Claude API 金鑰（到 [Claude Console](https://console.anthropic.com/settings/keys) 申請）。
   - 金鑰只會存在你自己瀏覽器的 localStorage，由瀏覽器直接呼叫 Anthropic API。
   - 需要在 Console 的組織設定中**啟用 Web search**，否則會改用 Google Books 簡介產生心智圖。
2. 點擊上傳區拍照／選圖，或把圖片拖曳進來，也可以直接 `Ctrl+V` 貼上。
3. 按 **🔍 辨識並產生心智圖**，等待約 30～90 秒。
4. 如果書名辨識錯誤，在「② 辨識結果」修改書名，按 **↻ 用這個書名重新搜尋**。
5. 按 **✏️ 編輯** 可以用 Markdown 修改節點後重新繪製。

## 部署到 GitHub Pages

```bash
git clone https://github.com/Leochen0306/Book-Cover-Search.git
cd Book-Cover-Search
# 把本專案的檔案複製進來後：
git add .
git commit -m "Book cover mind map web app"
git push origin main
```

接著在 GitHub 儲存庫：**Settings → Pages → Build and deployment → Source 選 “Deploy from a branch” → Branch 選 `main`、資料夾 `/ (root)` → Save**。
約一分鐘後網址會是：<https://leochen0306.github.io/Book-Cover-Search/>

## 檔案結構

| 檔案 | 說明 |
|---|---|
| `index.html` | 頁面結構、設定對話框、載入 d3 / markmap |
| `style.css` | 版面與樣式（支援手機） |
| `app.js` | 主程式：圖片處理 → 辨識 → 搜尋 → 擷取節點 → 繪圖 → 匯出 |

## 程式流程（給想修改的同學）

```
封面照片 ──縮圖成 JPEG──▶ identifyBook()   Claude 視覺辨識 → {title, authors, ...}
                         googleBooks()    Google Books API → 簡介、分類、頁數
                         researchBook()   Claude + web_search 工具 → 研究筆記 + 來源網址
                         extractNodes()   Claude → 知識節點 JSON {summary, root, branches[]}
                         treeToMarkdown() JSON → Markdown（# 中心、## 主分支、- 子節點）
                         renderMarkdown() markmap 繪製心智圖
```

可以調整的地方：
- `extractNodes()` 裡的提示詞規則（分支數量、層數、節點字數）決定心智圖長相。
- 設定中可切換模型（Sonnet / Opus / Haiku）、心智圖語言、搜尋次數上限。

## 費用與注意事項

- 每處理一本書大約呼叫 Claude 3 次，加上數次網路搜尋（網路搜尋另計費），費用依模型而定。
- API 金鑰放在瀏覽器端，**只適合自己或課堂內使用**；請勿把含金鑰的網址或螢幕截圖公開。
- AI 產生的內容可能有誤，請以原書為準。

---
丕楷 AI 增能專案
