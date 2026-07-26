# 出票前「用戶選設計」功能設計 — smart 推薦 3 preset + 自訂

> Archived implementation specification. The feature is implemented in
> `pipeline/themes.mjs`, `pipeline/customTheme.mjs`, and `pipeline/trip.mjs`.
>
> 狀態：**設計定案，待實作**。收束 2026-07-14 brainstorm。
> 下一步：Zack review → writing-plans skill → 實作。尚未寫任何實作程式碼。

## 1. 目標與流程

讓終端用戶在**行程規劃完成、出票之前**選擇票面設計。系統按目的地**聰明推薦 3 個
preset**，外加第 4 個「自己描述」的自訂選項。整套要能同時用於現在的 CLI 與未來打包的 MCP。

流程：

```
用戶給完行程資訊
  → pipeline 規劃行程(agents → composer,產出 plan)
  → 【出票前】問：「票要怎麼設計?」 → 顯示 3 推薦 preset + 1 自訂
  → 用戶選
  → 渲染出票(preset 直接套 / 自訂即時產+守門)
```

## 2. 第 1 段：orchestrator 拆成「規劃」與「出票」兩階段

現在 orchestrator 是一條龍（`agents → composer → resolveTheme → render` 中間不停）。
在「規劃好」與「出票」之間插入設計選擇點，做法是把它切成兩個可呼叫的函式：

- **`planTrip(sentence, opts)`** → 跑 agents + composer，產出**行程 plan（final_itinerary，尚未定
  theme）** + **`designOptions`**（見第 3 段）。**不渲染。**
- **`renderTicket(plan, choice, opts)`** → 依 `choice` 解出 theme（preset 名 → 直接用；custom →
  即時產 + 守門，見第 4 段）→ 呼叫現有 `renderItinerary` 出票。回 `{ outputDir, themeUsed }`。

兩個介面同時服務兩種使用情境（不寫兩套）：

- **A（現在 CLI 互動）**：單一程序內 `planTrip` → 印選單 → 讀 stdin → `renderTicket`。
  現有 `orchestrator.mjs` 改成呼叫這兩個函式；非互動情境（如 `--design=` 旗標或 `--mock`）
  跳過提問走預設。
- **B（未來 MCP）**：拆成兩個 tool —— `plan_trip` 回 `designOptions`、`render_ticket` 收
  `choice`。MCP 本就適合多次 tool call，天然不用中途卡住等互動。

**附帶價值**：這同時是「MCP 打包」的前置鋪路（orchestrator 抽成函式），一次做完，
Composio 連接器、選設計、MCP 三條線都受惠。與連接器 spec
（`2026-07-14-composio-connectors-design.md`）的實作可協同。

`choice` 形狀：`{ kind: 'preset', name } | { kind: 'custom', style }`。

## 3. 第 2 段：目的地聰明推薦 3 preset（+ 第 4 自訂）

### 3.1 theme metadata（附加，不動現有色）

每個 `THEMES` 條目加一小塊挑選用 metadata：

```js
japan: {
  label: '京都 · JR 青綠票',
  blurb: '青綠油墨票面 + 朱紅判子(済),日本鐵路車票感',
  regions: ['japan', '日本', 'Asia/Tokyo'],
  mood: ['復古', '鐵道', '沉靜'],
  tokens: {...}, pattern: ..., motifs: ...,   // 現有,不動
}
```

**協調點**：此 metadata 與 region-theming session 的「系統自動選皮」共用同一份 theme 目錄與
目的地比對資料。metadata 形狀（`label`/`blurb`/`regions`/`mood`）**實作前須與該 session 對齊**，
避免兩套。

### 3.2 推薦邏輯（在 `planTrip` 階段跑一次）

1. 把「目的地 + brief」與**整個 theme 目錄**（各條 label/blurb/regions/mood）交給 LLM，
   回**排名前 3** 的 theme 名 + 每個一句「為什麼推薦」。用 LLM 而非寫死規則，是為了處理目錄
   裡沒直接對應的新城市（挑調性最近者）。**LLM 只從「已通過對比的 preset」裡挑、不碰顏色
   → 零對比風險。**
2. **確定性 fallback**：LLM 失敗、或可選 theme < 3 時 → 以現有 `resolveTheme()` 的目的地判斷
   當第 1 個，其餘用 `default` 補滿。永遠湊得出 3 個。
3. **第 4 個永遠是「✏️ 自己描述」**（`custom`）。

### 3.3 `designOptions` 輸出形狀

```js
{
  presets: [
    { name: 'japan', label: '京都 · JR 青綠票', blurb: '...', why: '最貼合目的地' },
    { name: 'default', label: '經典 · 瑞士鐵路紅', blurb: '...', why: '通用耐看' },
    { name: 'night',  label: '夜行 · 深色票面',   blurb: '...', why: '適合城市夜景' },
  ],
  custom: { enabled: true, label: '✏️ 自己描述', hint: '用一句話講你要的風格' },
}
```

CLI 據此印選單；MCP 直接回這個物件。

## 4. 第 3 段：custom 選項（即時產生 + 守門 + 降級）

用戶選 `custom` 並給一句風格 → `renderTicket` 跑：

### 4.1 即時產生
用「城市 theme 產生器 prompt」，`{{DESTINATION}}`=本趟目的地、`{{USER_STYLE}}`=用戶那句 →
LLM 回 theme JSON（tokens + 自報對比 + name/blurb）。

### 4.2 守門 —— 對比規則抽成共用模組（單一真實來源）
現對比鐵律只活在 `scripts/check-theme-contrast.mjs`。runtime 不該 shell 呼叫建置腳本。
把那 10 對檢查核心抽成模組 **`pipeline/contrast.mjs`**：`checkTokens(tokens) → { pass, failures[] }`。
**CLI 腳本與 runtime 守門都 import 它。** 守門做兩件事：

- **格式驗證**：每個值必須是合法 `#rrggbb`（擋 LLM 亂回 / CSS 注入）。
- **對比驗證**：跑那 10 對，任一 fail → 不放行。

### 4.3 降級（誠實，分層）
- 過守門 → 直接套用出票。
- **不過 → 自動修 1 次**：把 failing pairs 回丟 LLM 要它壓暗/去彩度重產 → 再驗一次。
- **仍不過 / LLM 掛 → 退回第 1 推薦 preset**，並誠實告知用戶：
  「你的配色有幾處對比不達標，先用『<preset label>』出票，想調整可改描述再試。」

### 4.4 治理邊界
- **custom theme 用完即棄，不寫進 `themes.mjs`。** 升為正式 preset 須走既有儀式（登記
  docs/design-system.md + CI 對比全綠），屬維護者手動動作，不讓終端用戶 runtime 改 repo。
  → `render`/`themeCss` 需能吃「一個臨時 token 覆寫物件」，不只吃註冊過的 theme 名
  （`themeCss` 本就從覆寫物件組 `:root`，餵它 custom tokens 即可）。
- **custom 只給「token 覆寫 + motifs 文字」，不開放 `pattern`（自訂 CSS 底紋）。**
  自訂底紋維持只有正式 preset 能有（避免任意 CSS 注入 + 維持策展）。

## 5. 介面總覽

```
planTrip(sentence, opts)            → { plan, designOptions }
renderTicket(plan, choice, opts)    → { outputDir, themeUsed }
   choice = { kind:'preset', name } | { kind:'custom', style }

// themes.mjs（新增）
THEMES[name].{ label, blurb, regions[], mood[] }        // metadata
recommendThemes(destination, brief) → presets[3]        // LLM + 確定性 fallback

// contrast.mjs（新增，抽自 scripts/check-theme-contrast.mjs）
checkTokens(tokens) → { pass, failures[] }

// render.mjs（擴充）
renderItinerary(itin, { customTokens })  // 接受臨時 token 覆寫物件
```

## 6. 測試

1. **兩階段契約測試**：`planTrip` 回 `{plan, designOptions}` 形狀正確；`renderTicket` 用 preset /
   custom 各出一份票，斷言 theme 有套上。
2. **推薦 fallback 測試**：LLM 失敗 / 目錄 < 3 → 斷言仍回 3 個且第 1 個為 `resolveTheme` 判斷值。
3. **共用對比模組測試**：`checkTokens` 對已知過/不過的 token 組回正確 `pass/failures`；且
   `scripts/check-theme-contrast.mjs` 改用它後行為不變（現有 default/japan 仍全綠）。
4. **custom 降級測試**：注入「壞 hex / 對比 fail / LLM 掛」→ 斷言各自走到 修 1 次 或 退 preset，
   且出得了票、不崩。
5. **回歸鐵律**：不選設計 / 舊 CLI 路徑 / 舊 JSON 重印 → 輸出與現況一致（沿用現有回歸保護）。

## 7. 不在本 spec 範圍

- **region-theming「系統自動選皮」** — 另一個 session 的 spec；本 spec 只共用其 theme 目錄與
  metadata，不重做自動選邏輯。
- **打包成 MCP 的完整設計**（產物交付 URL vs 檔案、長任務回報）— 之後另開 session；本 spec 只
  把「兩階段函式介面」這個前置做好。
- **城市 theme 產生器 prompt 本身** — 已於本 session 產出，作為 4.1 的引擎；prompt 全文另存。

## 8. 待確認 / 開放項

- theme metadata 形狀與 region-theming session 對齊（實作第一步先同步）。
- 推薦 LLM 的 prompt 措辭與「why 一句話」長度上限，實作時定。
- custom 自動修的重試上限固定為 1（可日後調）。
- CLI 互動的實際 UX（數字選 1–4、custom 再問一句風格）與非互動旗標（`--design=`）細節，
  writing-plans 階段展開。
