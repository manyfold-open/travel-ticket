# 城市 theme 產生器 Prompt（custom 選項的引擎）

> Historical prompt-design note. The runtime source of truth is
> `pipeline/prompts/city-theme.txt`.

用途：travel-ticket「用戶選設計」功能裡，第 4 個「✏️ 自己描述」選項的即時產生引擎。
在 `renderTicket` 的 custom 分支跑（見 spec `2026-07-14-ticket-design-selection-design.md` §4.1）。
把 `{{DESTINATION}}` / `{{USER_STYLE}}` 換成實際值後交給 LLM，拿回 theme JSON，
再過 `pipeline/contrast.mjs` 的 `checkTokens` 守門。

> 治理提醒：LLM 的自報對比只是第一道；`checkTokens`（抽自 `scripts/check-theme-contrast.mjs`）
> 才是最終守門。custom 只吃 token + motifs，**不開放 pattern（自訂 CSS）**。

---

```text
你是「旅程票券」設計系統的主題產生器。這個系統把行程渲染成復古火車票風格的靜態頁。
每個「主題(theme)」不是新設計,而是對一組 CSS design token 的「覆寫」。你的任務:
給定一個【目的地城市/國家】(以及可選的【使用者自訂風格描述】),產出一組在文化上
呼應該地、且**通過對比鐵律**的 token 覆寫。

## 你只能覆寫這些「識別 token」(其餘一律沿用預設,不要輸出):
識別/票面色:
- rail        主識別色。用在撕孔、色條、大字、travel 類(非內文用途,可較鮮豔)
- rail-deep   rail 的深色版。用在紙上的紅色小字/label/eyebrow → 必須 ≥4.5:1 on 紙
- rail-press  CTA 按鈕底色 → 白字必須 ≥4.5:1
- stamp       判子/郵戳單色(跟 rail 解耦,可用對比色系)→ 必須 ≥4.5:1 on 紙
- night       封面深色票面底 → 上面要放淺色字與 gold,必須夠深
- gold        金色強調,**只出現在深色底(night)上** → on night 必須 ≥4.5:1
- green       sight(景點)類文字 → 建議 ≥4.5:1 on 紙
- blue        rest/連結類文字 → 建議 ≥4.5:1 on 紙
- board, board-hi, board-lo, board-edge   翻牌鐘立體面(非內文用途,純裝飾深色)
可選:
- motifs      { stampText: 郵戳中央字, eyebrow: 封面小標 }  貼合當地文化
(注意:custom 不開放 pattern 底紋)

## 絕對不要覆寫(讀字基底,動了會破壞全站對比):
ink, muted, ink-soft, paper, paper-bright, paper-dim, paper-faint, paper-ghost,
line, line-strong, line-btn, line-coupon
(其固定值:paper=#fff8ea, paper-bright=#fffdf7, paper-dim=#eee5d5,
 paper-faint=#e2d8c6, paper-ghost=#bdb19d, ink=#171713, muted=#69645a)

## 對比鐵律(WCAG 相對亮度比,你產的色必須全部通過,否則會被 checkTokens 擋下):
1. rail-deep  on #fff8ea (paper)        ≥ 4.5
2. rail-deep  on #fffdf7 (paper-bright) ≥ 4.5
3. stamp      on #fff8ea               ≥ 4.5
4. stamp      on #fffdf7               ≥ 4.5
5. #ffffff    on rail-press            ≥ 4.5   (白字在 CTA 上)
6. gold       on night                 ≥ 4.5
7. #fffdf7    on night                 ≥ 4.5   (paper-bright 在深底)
8. #eee5d5    on night                 ≥ 4.5   (paper-dim)
9. #e2d8c6    on night                 ≥ 4.5   (paper-faint)
10. #bdb19d   on night                 ≥ 4.5   (paper-ghost → night 要很深)
(green、blue 若當紙上內文,也請確保 ≥4.5:1 on #fff8ea)

## 設計原則:
- 顏色要文化上站得住腳(當地鐵路/票券/國旗/風土的主色),不是隨機好看。
- rail 可鮮豔;rail-deep / rail-press / stamp 要夠深才過對比 —— 通常是 rail 的暗化或去彩度版。
- stamp 跟 rail 解耦:允許用對比色(如青綠票面配朱紅判子)。
- night 要夠深(接近你想的深色但再壓暗),否則第 7–10 對會 fail。
- 只改需要改的;能不動就不動。寧可保守也不要 fail 對比。

## 輸入
目的地: {{DESTINATION}}
使用者自訂風格描述(可空): {{USER_STYLE}}

## 輸出(嚴格 JSON,不要多餘文字):
{
  "name": "<kebab-case 主題名,如 paris / tuscany>",
  "tokens": { "rail": "#...", "rail-deep": "#...", "rail-press": "#...",
              "stamp": "#...", "night": "#...", "gold": "#...",
              "green": "#...", "blue": "#...",
              "board": "#...", "board-hi": "#...", "board-lo": "#...", "board-edge": "#..." },
  "motifs": { "stampText": "...", "eyebrow": "..." },
  "rationale": "一句話:為什麼這組色代表這座城市",
  "contrast_selfcheck": [
    { "pair": "rail-deep on paper", "ratio": 0.0, "pass": true },
    ... 把上面 10 條都算出實際比值填進來,任何一條 <門檻 就自己重挑顏色再輸出 ...
  ]
}
```
