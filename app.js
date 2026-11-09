/* 書封知識心智圖 Book Cover Search
 * 流程：封面照片 → Claude 視覺辨識書名/作者 → Google Books + Claude 網路搜尋
 *       → Claude 擷取知識節點(JSON) → Markdown → markmap 心智圖
 * 全部在瀏覽器端執行，可直接部署到 GitHub Pages。
 */
(() => {
  "use strict";

  // ---------- 設定 ----------
  const API_URL = "https://api.anthropic.com/v1/messages";
  const WEB_SEARCH_TOOL = "web_search_20250305";
  const STORE_KEY = "bookCoverSearch.settings";

  const defaults = {
    apiKey: "",
    model: "claude-sonnet-5-5",
    lang: "繁體中文",
    maxSearch: 5,
    useGoogleBooks: true,
  };

  const loadSettings = () => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") }; }
    catch { return { ...defaults }; }
  };
  const saveSettings = (s) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* 無法儲存時僅保留在記憶體 */ }
  };
  let settings = loadSettings();

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    fileInput: $("fileInput"), dropZone: $("dropZone"), preview: $("preview"), dropHint: $("dropHint"),
    runBtn: $("runBtn"), steps: $("steps"), status: $("status"),
    bookCard: $("bookCard"), bookTitle: $("bookTitle"), bookAuthor: $("bookAuthor"), bookExtra: $("bookExtra"),
    bookMeta: $("bookMeta"), researchBtn: $("researchBtn"),
    sourcesBox: $("sourcesBox"), sourcesList: $("sourcesList"),
    summary: $("summary"), svg: $("mindmap"), mapEmpty: $("mapEmpty"),
    fitBtn: $("fitBtn"), editBtn: $("editBtn"), pngBtn: $("pngBtn"), svgBtn: $("svgBtn"), mdBtn: $("mdBtn"),
    editor: $("editor"), mdText: $("mdText"), applyMdBtn: $("applyMdBtn"),
    settingsBtn: $("settingsBtn"), settingsDlg: $("settingsDlg"),
    apiKey: $("apiKey"), model: $("model"), lang: $("lang"), maxSearch: $("maxSearch"), useGoogleBooks: $("useGoogleBooks"),
  };

  const state = { image: null, book: null, markdown: "", mm: null, busy: false };

  // ---------- 小工具 ----------
  const setStatus = (msg, isError = false) => {
    el.status.textContent = msg || "";
    el.status.classList.toggle("error", !!isError);
  };
  const setStep = (name, cls) => {
    const li = el.steps.querySelector(`[data-step="${name}"]`);
    if (!li) return;
    li.classList.remove("active", "done", "fail");
    if (cls) li.classList.add(cls);
  };
  const resetSteps = (from = "identify") => {
    const order = ["identify", "search", "extract", "render"];
    order.slice(order.indexOf(from)).forEach((s) => setStep(s, null));
  };
  const stripHtml = (html) => {
    const d = document.createElement("div");
    d.innerHTML = html || "";
    return (d.textContent || "").trim();
  };
  const escapeMd = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/^([#>\-*+]|\d+\.)\s/, "\\$1 ").trim();

  /** 從模型輸出中取出第一個 JSON 物件 */
  const parseJson = (text) => {
    const cleaned = text.replace(/```(?:json)?/gi, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("AI 回傳的內容不是 JSON：\n" + text.slice(0, 300));
    const raw = cleaned.slice(start, end + 1);
    try { return JSON.parse(raw); }
    catch (e) {
      // 簡單修復：移除結尾多餘逗號、把中文引號外的智慧引號換掉
      const fixed = raw.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, "\\\"");
      try { return JSON.parse(fixed); }
      catch { throw new Error("AI 回傳的 JSON 格式有誤，請再按一次「辨識並產生心智圖」。(" + e.message + ")"); }
    }
  };

  // ---------- 圖片處理 ----------
  /** 縮小圖片（長邊 ≤ 1568px）並轉成 base64 JPEG，以節省 API 用量 */
  const fileToImage = (file) => new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) return reject(new Error("請選擇圖片檔"));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1568;
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = c.toDataURL("image/jpeg", 0.9);
      URL.revokeObjectURL(url);
      resolve({ dataUrl, base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("無法讀取這張圖片")); };
    img.src = url;
  });

  const acceptFile = async (file) => {
    try {
      state.image = await fileToImage(file);
      el.preview.src = state.image.dataUrl;
      el.preview.hidden = false;
      el.dropHint.hidden = true;
      el.runBtn.disabled = false;
      resetSteps();
      setStatus("圖片已載入，按「辨識並產生心智圖」開始。");
    } catch (e) {
      setStatus(e.message, true);
    }
  };

  // ---------- Claude API ----------
  /**
   * 呼叫 Claude Messages API。
   * 若使用網路搜尋（server tool）時回傳 pause_turn，會自動接續直到完成。
   * 回傳 { text, sources }。
   */
  async function callClaude({ system, content, tools, toolChoice, maxTokens = 4096 }) {
    if (!settings.apiKey) throw new Error("請先到「⚙️ 設定」輸入 Claude API 金鑰。");
    const messages = [{ role: "user", content }];
    const textParts = [];
    const sources = new Map();
    let toolInput = null;
    let stopReason = "";

    for (let round = 0; round < 6; round++) {
      const body = { model: settings.model, max_tokens: maxTokens, messages };
      if (system) body.system = system;
      if (tools) body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;

      let res;
      try {
        res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": settings.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new Error("無法連線到 Claude API，請檢查網路連線。(" + e.message + ")");
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error?.message || res.statusText;
        if (res.status === 401) throw new Error("API 金鑰無效，請到設定重新輸入。");
        if (res.status === 429) throw new Error("請求太頻繁或額度不足，請稍後再試。(" + msg + ")");
        const err = new Error(`Claude API 錯誤 ${res.status}：${msg}`);
        err.status = res.status;
        throw err;
      }

      for (const block of data.content || []) {
        if (block.type === "text") {
          textParts.push(block.text);
          for (const c of block.citations || []) {
            if (c.url) sources.set(c.url, c.title || c.url);
          }
        } else if (block.type === "tool_use") {
          toolInput = block.input;
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) {
            if (r.url && !sources.has(r.url)) sources.set(r.url, r.title || r.url);
          }
        } else if (block.type === "web_search_tool_result" && block.content?.error_code) {
          console.warn("web search error:", block.content.error_code);
        }
      }

      stopReason = data.stop_reason;
      if (data.stop_reason === "pause_turn") {
        // 長時間的伺服器端工具呼叫被暫停 → 把目前內容送回去讓它繼續
        messages.push({ role: "assistant", content: data.content });
        continue;
      }
      break;
    }
    return { text: textParts.join(""), sources, toolInput, stopReason };
  }

  const noForcedTool = new Set();
  /** 以「強制工具呼叫」取得結構化 JSON（由 API 保證格式正確），失敗時退回解析文字 */
  async function callForJson({ system, content, toolName, description, schema, maxTokens }) {
    const tools = [{ name: toolName, description, input_schema: schema }];
    let r;
    if (noForcedTool.has(settings.model)) {
      r = await callClaude({ system, content, maxTokens, tools });
    } else {
      try {
        r = await callClaude({ system, content, maxTokens, tools, toolChoice: { type: "tool", name: toolName } });
      } catch (e) {
        // 部分模型不支援強制指定工具 → 改由模型自行呼叫工具（auto），並記住這個模型
        if (e.status === 400 && /tool_choice/i.test(e.message)) {
          noForcedTool.add(settings.model);
          r = await callClaude({ system, content, maxTokens, tools });
        } else throw e;
      }
    }
    if (r.stopReason === "max_tokens") throw new Error("AI 回覆太長被截斷，請再試一次（或在設定改用其他模型）。");
    if (r.toolInput && typeof r.toolInput === "object") return r.toolInput;
    return parseJson(r.text);
  }

  // ---------- 步驟 1：辨識封面 ----------
  async function identifyBook() {
    const system = "你是專業的圖書館員，擅長從書本封面辨識書籍資訊。";
    const prompt = `請仔細辨識這張書本封面照片，輸出以下 JSON：
{
  "title": "書名（照封面上的文字，含副標題）",
  "original_title": "若為翻譯書，推測的原文書名；否則空字串",
  "authors": ["作者"],
  "translators": ["譯者，沒有則空陣列"],
  "publisher": "出版社，看不到則空字串",
  "language": "封面主要語言",
  "isbn": "看得到 ISBN 才填，否則空字串",
  "other_text": "封面上其他有助辨識的文字（標語、系列名等）",
  "confidence": 0 到 1 之間的數字,
  "is_book_cover": true 或 false
}`;
    const str = { type: "string" };
    const info = await callForJson({
      system,
      maxTokens: 1500,
      toolName: "save_book_info",
      description: "儲存從封面辨識出的書籍資訊",
      schema: {
        type: "object",
        properties: {
          title: str, original_title: str,
          authors: { type: "array", items: str }, translators: { type: "array", items: str },
          publisher: str, language: str, isbn: str, other_text: str,
          confidence: { type: "number" }, is_book_cover: { type: "boolean" },
        },
        required: ["title", "authors", "is_book_cover"],
      },
      content: [
        { type: "image", source: { type: "base64", media_type: state.image.mediaType, data: state.image.base64 } },
        { type: "text", text: prompt + "\n\n請用 save_book_info 工具回傳結果。" },
      ],
    });
    if (info.is_book_cover === false) {
      throw new Error("這張圖片看起來不像書本封面，請換一張更清楚的封面照片。");
    }
    if (!info.title) throw new Error("無法從封面辨識出書名，請手動在下方輸入書名後按「重新搜尋」。");
    return info;
  }

  // ---------- 步驟 2a：Google Books 書目資料 ----------
  async function googleBooks(book) {
    if (!settings.useGoogleBooks) return null;
    const terms = [];
    if (book.isbn) terms.push("isbn:" + book.isbn.replace(/[^0-9Xx]/g, ""));
    else {
      terms.push("intitle:" + book.title);
      if (book.authors?.[0]) terms.push("inauthor:" + book.authors[0]);
    }
    const url = "https://www.googleapis.com/books/v1/volumes?maxResults=3&q=" + encodeURIComponent(terms.join(" "));
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const item = (data.items || []).find((it) => it.volumeInfo?.description) || data.items?.[0];
      if (!item) return null;
      const v = item.volumeInfo;
      return {
        title: v.title + (v.subtitle ? "：" + v.subtitle : ""),
        authors: v.authors || [],
        publisher: v.publisher || "",
        publishedDate: v.publishedDate || "",
        pageCount: v.pageCount || "",
        categories: v.categories || [],
        description: stripHtml(v.description || ""),
        thumbnail: v.imageLinks?.thumbnail?.replace("http://", "https://") || "",
        link: v.infoLink || "",
      };
    } catch {
      return null;
    }
  }

  // ---------- 步驟 2b：Claude 網路搜尋 ----------
  async function researchBook(book, gb) {
    const who = (book.authors || []).join("、");
    const gbText = gb?.description ? `\n\nGoogle Books 的書籍簡介（供參考）：\n${gb.description}` : "";
    const prompt = `請上網搜尋這本書的相關介紹：
書名：${book.title}${book.original_title ? `（原文：${book.original_title}）` : ""}
作者：${who || "不詳"}
${book.publisher ? "出版社：" + book.publisher : ""}${book.other_text ? "\n封面其他文字：" + book.other_text : ""}${gbText}

請搜尋出版社/書店的內容簡介、目錄、書評或讀書心得，然後用${settings.lang}寫一份詳細的「研究筆記」，包含：
1. 這本書的核心主旨（一兩句話）
2. 書的結構：主要篇章或單元與各自重點（若找得到目錄請依目錄整理）
3. 書中的關鍵概念、理論、方法、案例或人物，各自簡短說明
4. 作者背景、寫作目的、目標讀者
5. 讀者常提到的重要收穫或評價
只寫有根據的內容，找不到的部分就註明「未找到」，不要編造。`;
    return callClaude({
      maxTokens: 6000,
      tools: [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: Number(settings.maxSearch) || 5 }],
      content: [{ type: "text", text: prompt }],
    });
  }

  // ---------- 步驟 3：擷取知識節點 ----------
  async function extractNodes(book, notes) {
    const system = "你是知識架構師，擅長把一本書的內容整理成清楚、有層次的心智圖。";
    const prompt = `以下是關於《${book.title}》的研究筆記。請擷取這本書的「知識節點」並組織成心智圖，使用${settings.lang}。

規則：
- 中心主題是書名。
- 4 到 7 個主分支，例如：核心主旨、各篇章／主題、關鍵概念、方法或工具、案例、作者與背景、適合讀者／收穫（依書的類型選擇最合適的分法）。
- 每個主分支 2 到 6 個子節點，子節點下可再有 0 到 4 個孫節點（最多 3 層）。
- 節點名稱要短（中文不超過 14 個字），是「概念」而非長句；需要補充時放在 note（不超過 40 字）。
- 只能使用筆記中有根據的內容，不要編造。

輸出 JSON 格式：
{
  "summary": "用 2~3 句話說明這本書在講什麼",
  "root": "書名",
  "branches": [
    { "name": "主分支", "note": "", "children": [
      { "name": "子節點", "note": "簡短說明", "children": [ { "name": "孫節點", "note": "" } ] }
    ]}
  ]
}

研究筆記：
"""
${notes}
"""`;
    const leaf = { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"] };
    const node = (children) => ({
      type: "object",
      properties: { name: { type: "string" }, note: { type: "string" }, children: { type: "array", items: children } },
      required: ["name"],
    });
    const tree = await callForJson({
      system,
      maxTokens: 8000,
      toolName: "save_mindmap",
      description: "儲存整理好的書籍知識心智圖",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          root: { type: "string" },
          branches: { type: "array", items: node(node(leaf)) },
        },
        required: ["summary", "root", "branches"],
      },
      content: [{ type: "text", text: prompt + "\n\n請用 save_mindmap 工具回傳結果。" }],
    });
    if (!Array.isArray(tree.branches) || !tree.branches.length) throw new Error("AI 沒有擷取到知識節點，請再試一次。");
    return tree;
  }

  // ---------- 樹狀結構 → Markdown ----------
  function treeToMarkdown(tree, book) {
    const lines = [`# ${escapeMd(tree.root || book.title)}`];
    const label = (n) => escapeMd(n.name) + (n.note ? ` <small>— ${escapeMd(n.note)}</small>` : "");
    for (const b of tree.branches) {
      lines.push("", `## ${label(b)}`);
      const walk = (nodes, depth) => {
        for (const n of nodes || []) {
          if (!n?.name) continue;
          lines.push(`${"  ".repeat(depth)}- ${label(n)}`);
          walk(n.children, depth + 1);
        }
      };
      walk(b.children, 0);
    }
    return lines.join("\n");
  }

  // ---------- 繪製心智圖 ----------
  function renderMarkdown(md) {
    const mmLib = window.markmap;
    if (!mmLib?.Transformer || !mmLib?.Markmap) throw new Error("心智圖元件載入失敗，請檢查網路後重新整理頁面。");
    state.markdown = md;
    el.mdText.value = md;
    const transformer = new mmLib.Transformer();
    const { root } = transformer.transform(md);
    const opts = mmLib.deriveOptions
      ? mmLib.deriveOptions({ colorFreezeLevel: 2, initialExpandLevel: -1, maxWidth: 260, spacingVertical: 8 })
      : {};
    el.mapEmpty.hidden = true;
    if (!state.mm) state.mm = mmLib.Markmap.create(el.svg, opts, root);
    else { state.mm.setOptions?.(opts); state.mm.setData(root); }
    setTimeout(() => state.mm.fit(), 60);
    [el.fitBtn, el.editBtn, el.pngBtn, el.svgBtn, el.mdBtn].forEach((b) => (b.disabled = false));
  }

  // ---------- 畫面：書籍資訊與來源 ----------
  function showBook(book, gb) {
    el.bookCard.hidden = false;
    el.bookTitle.value = book.title || "";
    el.bookAuthor.value = (book.authors || []).join("、");
    el.bookExtra.value = [book.publisher, book.original_title].filter(Boolean).join(" / ");
    el.bookMeta.innerHTML = "";
    if (gb) {
      if (gb.thumbnail) {
        const img = document.createElement("img");
        img.src = gb.thumbnail; img.alt = "Google Books 封面";
        el.bookMeta.appendChild(img);
      }
      const info = document.createElement("div");
      const facts = [gb.publisher, gb.publishedDate, gb.pageCount && gb.pageCount + " 頁", gb.categories.join(", ")].filter(Boolean);
      info.textContent = "Google Books：" + gb.title + (facts.length ? "｜" + facts.join("｜") : "");
      el.bookMeta.appendChild(info);
    }
  }

  function showSources(sources, gb) {
    el.sourcesList.innerHTML = "";
    const all = new Map(sources);
    if (gb?.link) all.set(gb.link, "Google Books：" + gb.title);
    for (const [url, title] of all) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = title;
      li.appendChild(a);
      el.sourcesList.appendChild(li);
    }
    el.sourcesBox.hidden = all.size === 0;
  }

  // ---------- 主流程 ----------
  async function run({ skipIdentify = false } = {}) {
    if (state.busy) return;
    if (!settings.apiKey) { openSettings(); setStatus("請先輸入 Claude API 金鑰。", true); return; }
    state.busy = true;
    el.runBtn.disabled = el.researchBtn.disabled = true;
    let current = skipIdentify ? "search" : "identify";
    resetSteps(current);
    try {
      // 1. 辨識
      if (!skipIdentify) {
        setStep("identify", "active"); setStatus("正在辨識封面…");
        state.book = await identifyBook();
        setStep("identify", "done");
      } else {
        state.book = {
          ...(state.book || {}),
          title: el.bookTitle.value.trim(),
          authors: el.bookAuthor.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
          publisher: el.bookExtra.value.trim(),
          isbn: "",
        };
        if (!state.book.title) throw new Error("請輸入書名。");
      }
      showBook(state.book, null);

      // 2. 搜尋
      current = "search";
      setStep("search", "active"); setStatus(`正在搜尋《${state.book.title}》的介紹…（約需 20～60 秒）`);
      const gb = await googleBooks(state.book);
      showBook(state.book, gb);
      let notes = "", sources = new Map();
      try {
        const r = await researchBook(state.book, gb);
        notes = r.text; sources = r.sources;
      } catch (e) {
        // 網路搜尋未啟用時，退而使用 Google Books 簡介
        if (gb?.description && e.status && e.status !== 401) {
          console.warn(e);
          notes = gb.description;
          setStatus("網路搜尋失敗（" + e.message + "），改用 Google Books 簡介繼續。");
        } else throw e;
      }
      if (!notes.trim()) throw new Error("找不到這本書的介紹，請確認書名後重新搜尋。");
      showSources(sources, gb);
      setStep("search", "done");

      // 3. 擷取知識節點
      current = "extract";
      setStep("extract", "active"); setStatus("正在擷取知識節點…");
      const tree = await extractNodes(state.book, notes);
      setStep("extract", "done");

      // 4. 繪圖
      current = "render";
      setStep("render", "active");
      el.summary.hidden = !tree.summary;
      el.summary.textContent = tree.summary || "";
      renderMarkdown(treeToMarkdown(tree, state.book));
      setStep("render", "done");
      setStatus("完成！點擊節點可收合／展開，也可以按「✏️ 編輯」修改。");
    } catch (e) {
      console.error(e);
      setStep(current, "fail");
      setStatus(e.message || String(e), true);
    } finally {
      state.busy = false;
      el.runBtn.disabled = !state.image;
      el.researchBtn.disabled = false;
    }
  }

  // ---------- 匯出 ----------
  const download = (blob, name) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const fileBase = () => (state.book?.title || "mindmap").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

  /** 複製目前心智圖成獨立 SVG 字串（含樣式、完整範圍） */
  function buildSvgString() {
    const svg = el.svg;
    const g = svg.querySelector("g");
    const box = g.getBBox();
    const pad = 24;
    const clone = svg.cloneNode(true);
    clone.querySelector("g").removeAttribute("transform");
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("viewBox", `${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`);
    clone.setAttribute("width", Math.ceil(box.width + pad * 2));
    clone.setAttribute("height", Math.ceil(box.height + pad * 2));
    clone.removeAttribute("style");
    clone.removeAttribute("id");
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", box.x - pad); bg.setAttribute("y", box.y - pad);
    bg.setAttribute("width", box.width + pad * 2); bg.setAttribute("height", box.height + pad * 2);
    bg.setAttribute("fill", "#ffffff");
    clone.insertBefore(bg, clone.firstChild);
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `.markmap{font:300 16px/20px "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;}
      .markmap-foreign{display:inline-block} .markmap-foreign>div>div{display:inline-block;white-space:nowrap}
      .markmap-foreign small{color:#7a7064}`;
    clone.insertBefore(style, clone.firstChild);
    return { text: new XMLSerializer().serializeToString(clone), w: box.width + pad * 2, h: box.height + pad * 2 };
  }

  function exportSvg() {
    const { text } = buildSvgString();
    download(new Blob([text], { type: "image/svg+xml" }), fileBase() + ".svg");
  }

  function exportPng() {
    const { text, w, h } = buildSvgString();
    const scale = 2;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w * scale; c.height = h * scale;
      const ctx = c.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        c.toBlob((b) => (b ? download(b, fileBase() + ".png") : setStatus("PNG 匯出失敗，請改用 SVG。", true)), "image/png");
      } catch {
        setStatus("這個瀏覽器不允許匯出 PNG，請改用「⬇ SVG」。", true);
      }
    };
    img.onerror = () => setStatus("PNG 匯出失敗，請改用「⬇ SVG」。", true);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
  }

  // ---------- 設定對話框 ----------
  function openSettings() {
    el.apiKey.value = settings.apiKey;
    el.model.value = settings.model;
    el.lang.value = settings.lang;
    el.maxSearch.value = settings.maxSearch;
    el.useGoogleBooks.checked = settings.useGoogleBooks;
    el.settingsDlg.showModal();
  }
  el.settingsDlg.addEventListener("close", () => {
    if (el.settingsDlg.returnValue !== "save") return;
    settings = {
      apiKey: el.apiKey.value.trim(),
      model: el.model.value,
      lang: el.lang.value,
      maxSearch: Math.min(10, Math.max(1, Number(el.maxSearch.value) || 5)),
      useGoogleBooks: el.useGoogleBooks.checked,
    };
    saveSettings(settings);
    setStatus("設定已儲存。");
  });

  // ---------- 事件綁定 ----------
  el.settingsBtn.addEventListener("click", openSettings);
  el.fileInput.addEventListener("change", (e) => e.target.files[0] && acceptFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((t) => el.dropZone.addEventListener(t, (e) => { e.preventDefault(); el.dropZone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => el.dropZone.addEventListener(t, (e) => { e.preventDefault(); el.dropZone.classList.remove("drag"); }));
  el.dropZone.addEventListener("drop", (e) => e.dataTransfer.files[0] && acceptFile(e.dataTransfer.files[0]));
  window.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) acceptFile(item.getAsFile());
  });

  el.runBtn.addEventListener("click", () => run());
  el.researchBtn.addEventListener("click", () => run({ skipIdentify: true }));
  el.fitBtn.addEventListener("click", () => state.mm?.fit());
  el.editBtn.addEventListener("click", () => { el.editor.hidden = !el.editor.hidden; });
  el.applyMdBtn.addEventListener("click", () => {
    try { renderMarkdown(el.mdText.value); setStatus("心智圖已更新。"); }
    catch (e) { setStatus(e.message, true); }
  });
  el.mdBtn.addEventListener("click", () => download(new Blob([state.markdown], { type: "text/markdown" }), fileBase() + ".md"));
  el.svgBtn.addEventListener("click", exportSvg);
  el.pngBtn.addEventListener("click", exportPng);
  window.addEventListener("resize", () => state.mm?.fit());

  if (!settings.apiKey) setStatus("第一次使用請先按右上角「⚙️ 設定」輸入 Claude API 金鑰。");

  // 供測試使用
  window.__bookApp = { renderMarkdown, treeToMarkdown, state };
})();
