# Product

> Current product principles. Originally derived from `README.md`,
> `docs/design-system.md`, and project memory on 2026-07-03.
> 策略答案若與你的想法不符，直接改這份檔案。

## Register

brand

（產出手冊的「車票美學」本身就是產品價值；studio 入口頁是工具，但穿同一套票券制服。）

## Users

- 主要使用者：專案作者本人與朋友——會用一句話描述旅程、等 6 分鐘拿到一疊車票風手冊的人。
- 情境：從公開 Worker 或本地 Studio 輸入需求；手冊在桌機與手機上閱讀，本地產物也可離線開啟。
- 要完成的工作：把模糊的旅遊想法變成可核對、可預訂的逐日行程，並拿到值得分享的美術品級手冊。

## Product Purpose

一句話 → multi-agent pipeline → 車票風格旅遊手冊靜態站。成功的樣子：
手冊像「真的被機器印出來的長途車票」，資訊誠實（agent 狀態、占位提醒都印在票面上），
且任何 final_itinerary JSON 丟進 render.mjs 都能印出同等品質的一疊票。

## Brand Personality

- 三個詞：**印刷感、誠實、機械浪漫**。
- 語氣：介面 label 用車票的國際慣例（英文大寫短詞），內容敘述用繁體中文；按鈕寫會發生的事（「出票」不是「送出」）。
- 情緒目標：拿到手冊像撕下一張剛印好的票——溫熱、具體、可信。

## Anti-references

- 泛 SaaS 模板（hero + 三欄卡 + CTA）、紫色漸層、玻璃擬態。
- 「旅遊部落格」風：大照片輪播、心靈系文案。
- 任何會讓人問「這是不是 AI 生成的」的預設美學。裝飾必須承載資訊（signature 條碼原則）。

## Design Principles

1. **真的車票會這樣印嗎？** 所有視覺決策回到這個判準（docs/design-system.md Stage 0）。
2. **兩層資訊**：人寫的（Noto Sans TC）與機器印的（IBM Plex Mono、大寫、tabular-nums）不可混用。
3. **誠實是設計**：agent skipped/failed、占位資料都印在票面上，不藏。
4. **大膽額度花在 signature**：trip_id 派生條碼；其餘保持安靜。
5. **單一真實來源**：tokens 只能來自 docs/design-system.md；render.mjs 是唯一渲染器。

## Accessibility & Inclusion

- 底線見 docs/design-system.md Stage 5 checklist：紙上文字對比 ≥4.5:1、gold 不上紙、
  全站 :focus-visible、aria-pressed、prefers-reduced-motion、lang="zh-Hant"。
- 目標 WCAG 2.1 AA。
