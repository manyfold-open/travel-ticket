// Generic itinerary renderer — takes a final_itinerary JSON object and writes
// the ticket-style static site (index.html + day-*.html) into an output dir.
// Extracted and generalized from scripts/generate-itinerary-preview.mjs so the
// pipeline (or any caller) can render arbitrary trips, not just the Swiss demo.
import { buildPwaAssetFiles, pwaNames } from './pwa.mjs'
import { THEMES, themeCss } from './themes.mjs'
import { assertBritishEnglish } from './english.mjs'
import { assertLanguageOutput, locale, normalizeLanguage } from './language.mjs'

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]))

const css = `
/* Hallmark · design-system: docs/design-system.md · concept: train-ticket stack · register: brand · genre: bespoke (ticket) */
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800;900&family=Caveat:wght@500;600;700&family=IBM+Plex+Mono:wght@500;600;700&family=Noto+Sans:wght@400;500;700;900&display=swap');
:root {
  color-scheme: light;
  --ink: #171713;
  --muted: #69645a;
  --paper: #fff8ea;
  --line: #d6c7aa;
  --rail: #e3372d;
  --rail-deep: #9c322b;
  --stamp: #9c322b;
  --gold: #f3c95f;
  --blue: #176b87;
  --green: #1f5d4a;
  --night: #292a25;
  --board: #191916;
  --rail-press: #c82018;
  --paper-bright: #fffdf7;
  --paper-dim: #eee5d5;
  --paper-faint: #e2d8c6;
  --paper-ghost: #bdb19d;
  --ink-soft: #4d473d;
  --line-strong: #b9aa90;
  --line-btn: #c8b99e;
  --line-coupon: #c7b89b;
  --desk: #efe0c3;
  --desk-shade: #ddd8c8;
  --stack-1: #f3e7cf;
  --stack-2: #eadcc2;
  --stack-edge: #d1c0a0;
  --board-hi: #2d2c27;
  --board-lo: #11110f;
  --board-edge: #070706;
  --lane-gradient: linear-gradient(90deg,#f5e7ca,#fffaf0,#e7efea);
  --font-display: "Archivo", sans-serif;
  --font-body: "Noto Sans", "Archivo", sans-serif;
  --font-mono: "IBM Plex Mono", "Noto Sans", ui-monospace, monospace;
  --font-hand: "Caveat", "Noto Sans", cursive;
  --shadow: 0 24px 70px rgba(34,28,19,.18);
}
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
a, button { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
body {
  margin: 0;
  color: var(--ink);
  font-family: "Noto Sans", "Archivo", sans-serif;
  background: linear-gradient(135deg,var(--desk),var(--paper) 45%,var(--desk-shade));
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: .35;
  background-image: repeating-linear-gradient(135deg,rgba(23,23,19,.05) 0 1px,transparent 1px 18px);
}
a { color: inherit; text-decoration: none; }
button { font: inherit; }
.page {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  min-height: 100svh;
  display: grid;
  /* minmax(0,1fr)：擋住 nowrap 內容（microprint/serial）的 min-content 撐爆 track */
  grid-template-columns: minmax(0, 1fr);
  place-items: center;
  padding: 28px;
}
.ticket-stack {
  width: min(1180px, 100%);
  position: relative;
}
.ticket-stack::before,
.ticket-stack::after {
  content: "";
  position: absolute;
  inset: 16px -10px -16px 10px;
  background: var(--stack-1);
  border: 1px solid var(--stack-edge);
  transform: rotate(-1.1deg);
  z-index: -2;
}
.ticket-stack::after {
  inset: 30px -20px -30px 22px;
  transform: rotate(1.2deg);
  background: var(--stack-2);
  z-index: -3;
}
.ticket {
  position: relative;
  overflow: hidden;
  background: var(--paper);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
}
.ticket::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 18px;
  background: repeating-radial-gradient(circle at 9px 12px, transparent 0 5px, var(--rail) 5px 7px, transparent 7px 25px);
}
.ticket-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(310px, .65fr);
  min-height: 720px;
}
.main {
  position: relative;
  background: var(--night);
  color: var(--paper-bright);
  padding: 34px 34px 28px 46px;
}
.main::before {
  content: "";
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(135deg, rgba(255,255,255,.055) 0 1px, transparent 1px 18px);
}
.main > * { position: relative; }
.stub {
  position: relative;
  padding: 30px 28px 26px 34px;
  border-left: 1px dashed var(--line-strong);
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.stub::before,
.stub::after {
  content: "";
  position: absolute;
  left: -14px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--desk);
  border: 1px solid var(--line);
}
.stub::before { top: -14px; }
.stub::after { bottom: -14px; }
.eyebrow,
.label,
.cta,
.nav a,
.mode button,
.stamp {
  font-family: "Archivo", sans-serif;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: .11em;
}
.eyebrow { font-size: 12px; color: var(--gold); }
.day-ticket .eyebrow { color: var(--rail-deep); }
a:focus-visible,
button:focus-visible {
  outline: 3px solid var(--gold);
  outline-offset: 2px;
}
.day-ticket .main a:focus-visible,
.day-ticket .main button:focus-visible,
.stub a:focus-visible {
  outline-color: var(--rail);
}
h1 {
  font-family: "Archivo", sans-serif;
  font-size: clamp(48px, 8vw, 96px);
  line-height: .96;
  text-wrap: balance;
  margin: 16px 0 14px;
  text-transform: uppercase;
}
h1 span { color: var(--gold); }
.h1-note {
  margin: -4px 0 16px;
  font: 500 14px/1.6 var(--font-body);
  color: var(--muted);
  text-wrap: pretty;
}
.summary {
  font-size: 15px;
  line-height: 1.95;
  letter-spacing: .012em;
  color: var(--paper-dim);
  max-width: 62ch;
  text-wrap: pretty;
}
.summary p { margin: 0 0 14px; }
.summary p:last-child { margin-bottom: 0; }
.route-pills,
.stats,
.day-passes,
.mini-grid,
.agenda,
.fineprint,
.source-strip,
.status-strip {
  display: grid;
  gap: 10px;
}
.route-pills {
  display: flex;
  flex-wrap: wrap;
  margin: 16px 0;
}
.route-pills span {
  border: 1px solid rgba(255,255,255,.24);
  padding: 7px 10px;
  background: rgba(255,255,255,.08);
  font-size: 12px;
  font-weight: 900;
}
.stats {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 26px;
}
.stat {
  border: 1px solid rgba(255,255,255,.2);
  padding: 13px;
}
.stat b {
  display: block;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 22px;
}
.stat span {
  font-size: 12px;
  color: var(--paper-faint);
  font-weight: 900;
  text-transform: uppercase;
}
.route-line {
  position: relative;
  margin: 12px 0;
  padding-left: 28px;
}
.route-line::before {
  content: "";
  position: absolute;
  left: 8px;
  top: 10px;
  bottom: 10px;
  width: 4px;
  background: var(--rail);
}
.stop {
  position: relative;
  display: block;
  padding: 0 0 20px 18px;
  font-family: "Archivo", sans-serif;
  font-weight: 900;
  font-size: 25px;
}
.stop:hover { color: var(--rail-deep); }
.stop::before {
  content: "";
  position: absolute;
  left: -28px;
  top: 8px;
  width: 16px;
  height: 16px;
  border: 4px solid var(--rail);
  background: var(--paper);
  border-radius: 50%;
}
.stop small {
  display: block;
  font: 700 13px/1.4 var(--font-body);
  color: var(--muted);
  margin-top: 2px;
}
.stub-title {
  color: var(--rail-deep);
  border-bottom: 1px dashed var(--line-strong);
  padding-bottom: 10px;
}
.kv {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 11px;
  align-items: end;
}
.kv span {
  font-size: 12px;
  color: var(--muted);
  font-weight: 900;
}
.kv b {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 20px;
  text-align: right;
}
.cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: auto;
  background: var(--rail-press);
  color: var(--paper-bright);
  padding: 14px 16px;
  border: 0;
}
.cta:hover,
.cta:active {
  background: var(--rail-deep);
  color: var(--paper-bright);
}
.nav a:hover,
.mode button.active {
  background: var(--rail-press);
  color: var(--paper-bright);
}
.day-passes {
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  margin-top: 28px;
}
.pass {
  background: rgba(255,248,234,.96);
  color: var(--ink);
  border: 1px solid var(--line);
  padding: 13px 13px 13px 18px;
  clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
}
.pass:hover {
  border-color: var(--rail);
  background: var(--paper-bright);
}
.pass:hover b { color: var(--rail-press); }
.pass b {
  display: block;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 19px;
  color: var(--rail);
  line-height: 1.15;
}
.pass span {
  display: block;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
  margin-top: 5px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.fineprint {
  border-top: 1px dashed var(--line-strong);
  padding-top: 12px;
  margin-top: 12px;
}
.fineprint p {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
}
.main .fineprint p { color: var(--paper-faint); }
/* 條款印成車票式編號條列：mono 兩位數編號掛在左緣 */
.terms {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: term;
  display: grid;
  gap: 8px;
}
.terms li {
  position: relative;
  padding-left: 24px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--muted);
  counter-increment: term;
}
.terms li::before {
  content: counter(term, decimal-leading-zero);
  position: absolute;
  left: 0;
  top: 2px;
  font: 600 10px var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  color: var(--rail-deep);
}
.terms b { font-weight: 700; color: var(--ink-soft); }
.cover-ticket .main .terms li { color: var(--paper-faint); }
.cover-ticket .main .terms li::before { color: var(--gold); }
.cover-ticket .main .terms b { color: var(--paper-dim); }
.stamp {
  display: inline-block;
  border: 2px solid var(--rail-deep);
  color: var(--rail-deep);
  padding: 7px 9px;
  transform: rotate(-2deg);
  font-size: 12px;
  flex: none;
}
.stamp-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 12px;
  margin-bottom: 10px;
}
/* Hand 角色：每張票至多一句（docs/design-system.md 劑量規則），站務員鉛筆批註。
   flex-basis 讓批註在窄票根自動換行到章下方，避免直排。 */
.annot {
  flex: 1 1 180px;
  min-width: 0;
  font-family: var(--font-hand);
  font-size: 15px;
  line-height: 1.55;
  color: var(--rail-deep);
  transform: rotate(-.6deg);
  margin-top: 2px;
}
.cover-ticket .main .stamp {
  border-color: var(--gold);
  color: var(--gold);
}
/* 票根比票面長時，把條款錨到底邊，殘餘留白落在內容區之間而不是拖尾。 */
.cover-ticket .main {
  display: flex;
  flex-direction: column;
}
.cover-ticket .main .fineprint { margin-top: auto; }
/* Microprint 安全印刷帶：路線/日期/人數/序號的重複微縮字，印滿票面底邊。 */
.microprint {
  margin-top: 16px;
  padding: 6px 0;
  border-top: 1px solid rgba(255,255,255,.16);
  border-bottom: 1px solid rgba(255,255,255,.16);
  font: 600 9px var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--paper-ghost);
  white-space: nowrap;
  overflow: hidden;
  /* 同 .serial：單行微縮字 intrinsic 寬 2000px+，不擋會撐爆外層 grid（375px 封面全空白） */
  width: 0;
  min-width: 100%;
}
.nav {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.nav a,
.mode button {
  background: var(--paper);
  border: 1px solid var(--line-btn);
  padding: 10px 13px;
  cursor: pointer;
}
.mode {
  display: flex;
  background: var(--paper-bright);
  padding: 4px;
}
.mode button {
  border: 0;
  min-width: 92px;
}
.ticket-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 16px;
}
.day-ticket .main {
  background: var(--paper);
  color: var(--ink);
}
.day-ticket .main::before { opacity: .32; }
.day-ticket h1 {
  font-size: clamp(42px, 6.5vw, 78px);
  color: var(--ink);
}
.day-ticket h1.long {
  font-size: clamp(26px, 4vw, 44px);
  line-height: 1.3;
}
.day-ticket h1 span { color: var(--rail); }
.journey {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 12px;
  align-items: center;
  margin: 12px 0 18px;
}
.station,
.mini,
.coupon {
  background: var(--paper-bright);
  border: 1px solid var(--line);
}
.station { padding: 12px; }
.station .label,
.mini .label {
  display: block;
  color: var(--rail-deep);
  font-size: 11px;
}
.station b {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 22px;
}
.arrow {
  font-family: "Archivo", sans-serif;
  font-size: 42px;
  color: var(--rail);
}
.mini-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 14px 0;
}
.mini {
  border-style: dashed;
  padding: 10px;
}
.mini b {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 13px;
}
.world-clock {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 12px 0;
  perspective: 900px;
}
.clock-card {
  position: relative;
  min-width: 0;
  background: var(--board);
  color: var(--paper);
  border: 1px solid var(--board-edge);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.12);
  padding: 9px;
  transform-style: preserve-3d;
}
.clock-card::before,
.clock-card::after {
  content: "";
  position: absolute;
  top: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--board-edge);
  transform: translateY(-50%);
  z-index: 2;
}
.clock-card::before { left: 6px; }
.clock-card::after { right: 6px; }
.clock-label {
  display: block;
  color: var(--gold);
  font-family: "Archivo", sans-serif;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .1em;
  line-height: 1.1;
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clock-sub {
  display: block;
  color: var(--paper-ghost);
  font-size: 10px;
  font-weight: 900;
  line-height: 1.1;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flip-board {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 62px;
  margin: 8px 0 7px;
  background: linear-gradient(var(--board-hi) 0 49%, var(--board-lo) 50% 100%);
  border: 1px solid var(--board-edge);
  overflow: hidden;
  transform-style: preserve-3d;
}
.flip-board::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  background: rgba(255,248,234,.24);
  box-shadow: 0 1px 0 rgba(0,0,0,.75);
}
.flip-time {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: clamp(20px, 3.2vw, 34px);
  font-weight: 700;
  letter-spacing: 0;
  line-height: .9;
  color: var(--paper);
  text-shadow: 0 2px 0 var(--board-lo);
}
.flip-code {
  display: block;
  color: var(--paper-ghost);
  font-family: "Archivo", sans-serif;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.timeboard {
  border-top: 1px dashed var(--line-strong);
  border-bottom: 1px dashed var(--line-strong);
  padding: 12px 0;
  margin: 12px 0;
}
.lane {
  display: grid;
  grid-template-columns: 88px 1fr;
  align-items: center;
  gap: 9px;
  margin: 7px 0;
}
.lane .label {
  font-size: 10px;
  color: var(--muted);
}
.bar {
  position: relative;
  height: 28px;
  background: var(--lane-gradient);
  border: 1px solid var(--line);
  overflow: hidden;
  transform-origin: left center;
}
.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid rgba(155,137,105,.38);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--muted);
  padding-left: 2px;
}
.mark {
  position: absolute;
  top: 5px;
  bottom: 5px;
  background: var(--green);
  min-width: 7px;
  box-shadow: inset 0 0 0 1px rgba(23,23,19,.28);
}
.mark.travel { background: var(--rail); }
.mark.meal { background: var(--gold); }
.mark.rest { background: var(--blue); }
.agenda { margin-top: 12px; }
.coupon {
  display: grid;
  grid-template-columns: 1fr 112px;
  clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
  transform-origin: center top;
}
.coupon-main {
  padding: 11px 13px;
  border-left: 6px solid var(--green);
}
.coupon[data-type=travel] .coupon-main { border-left-color: var(--rail); }
.coupon[data-type=meal] .coupon-main { border-left-color: var(--gold); }
.coupon[data-type=rest] .coupon-main { border-left-color: var(--blue); }
.coupon-time {
  display: grid;
  place-items: center;
  border-left: 1px dashed var(--line-coupon);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 15px;
  text-align: center;
}
.type {
  color: var(--rail-deep);
  font-size: 10px;
}
.coupon strong {
  display: block;
  font-size: 16px;
  margin: 2px 0;
}
.coupon p {
  margin: 4px 0 0;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.42;
}
.tag {
  display: inline-block;
  background: var(--gold);
  color: var(--ink);
  padding: 3px 6px;
  margin-top: 6px;
  font-size: 11px;
  font-weight: 900;
}
.source-strip {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.source-strip a,
.status-strip div {
  font-size: 12px;
  color: var(--blue);
  font-weight: 900;
  border-top: 1px dashed var(--line-coupon);
  padding-top: 7px;
}
.source-strip a:hover { color: var(--rail-deep); }
.status-strip div { color: var(--muted); }
.source-strip,
.status-strip { margin-top: auto; }
.barcode-block { margin-top: 14px; }
.barcode {
  height: 36px;
  background-repeat: repeat-x;
  background-size: auto 100%;
}
.serial {
  font: 600 10px var(--font-mono);
  letter-spacing: .32em;
  color: var(--muted);
  text-transform: uppercase;
  margin-top: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* width:0 + min-width:100%：nowrap 單行不參與 min/max-content 傳播 */
  width: 0;
  min-width: 100%;
}
.hide { display: none; }
/* Spec 1 · 撕票翻頁 — MPA View Transitions（不支援的瀏覽器自動降級成普通跳頁）。
   隱喻：票疊（ticket-stack::before/after）不動，最上面那張被撕走；
   forward = 舊票從撕孔帶撕起、新票從票疊底下浮上（Scale in，非 Pop in）；
   back = 上一張從撕走的方向蓋回來。 */
@view-transition { navigation: auto; }
.ticket { view-transition-name: ticket; }
@media (prefers-reduced-motion: no-preference) {
  /* UA 對 old/new 快照預設 mix-blend-mode: plus-lighter（為交叉淡出設計）；
     自訂動畫兩層都近乎不透明時會加法過曝，必須重設 normal。
     疊序：forward 舊票在上（撕走才蓋得住新票）；back 兩者同 z，DOM 較後的 new 在上。 */
  ::view-transition-old(ticket) {
    animation: ticket-tear-off .38s cubic-bezier(.3, 0, .25, 1) both;
    transform-origin: 18px 60%;
    mix-blend-mode: normal;
    z-index: 2;
  }
  ::view-transition-new(ticket) {
    animation: ticket-settle .42s cubic-bezier(.22, 1, .36, 1) both;
    mix-blend-mode: normal;
  }
  html:active-view-transition-type(back)::view-transition-old(ticket) {
    animation-name: ticket-sink;
  }
  html:active-view-transition-type(back)::view-transition-new(ticket) {
    animation-name: ticket-cover-back;
    z-index: 2;
  }
}
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) { animation-duration: 120ms !important; }
}
@keyframes ticket-tear-off {
  35% { transform: translate(-2%, -3%) rotate(-2.5deg); opacity: 1; }
  100% { transform: translate(-9%, -15%) rotate(-8deg); opacity: 0; }
}
@keyframes ticket-settle {
  from { transform: scale(.985) translateY(8px); }
}
@keyframes ticket-sink {
  to { transform: scale(.985); opacity: 0; }
}
@keyframes ticket-cover-back {
  from { transform: translate(-9%, -15%) rotate(-8deg); opacity: 0; }
}
/* Spec 2 · 蓋章 check-in — 圓形郵戳（rail-deep 單色），時間戳承載資訊。
   紀錄存 localStorage（僅本機，票根有誠實註記）。 */
.coupon { position: relative; }
.coupon-time {
  gap: 6px;
  padding: 8px 6px;
}
.punch {
  padding: 9px 12px;
  font-family: var(--font-display);
  font-weight: 900;
  font-size: 10px;
  letter-spacing: .11em;
  text-transform: uppercase;
  background: var(--paper-bright);
  color: var(--rail-deep);
  border: 1px dashed var(--line-btn);
  cursor: pointer;
}
@media (pointer: coarse) {
  .punch { min-height: 44px; min-width: 44px; }
}
.punch-time {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  letter-spacing: 0;
}
.punch:hover { border-color: var(--rail-deep); }
.punch[aria-pressed="true"] {
  background: var(--rail-deep);
  color: var(--paper-bright);
  border: 1px solid var(--rail-deep);
}
.postmark {
  position: absolute;
  right: 96px;
  top: 50%;
  width: 82px;
  height: 82px;
  margin-top: -41px;
  color: var(--stamp);
  opacity: .86;
  transform: rotate(-8deg);
  mix-blend-mode: multiply;
  pointer-events: none;
  z-index: 1;
}
.postmark text {
  fill: currentColor;
  font-family: var(--font-mono);
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.postmark .pm-head { font-size: 14px; }
.postmark .pm-time { font-size: 17px; }
.postmark .pm-date { font-size: 11px; }
@media (prefers-reduced-motion: no-preference) {
  .postmark { animation: stamp-press .13s cubic-bezier(.2, 0, .2, 1) both; }
}
@keyframes stamp-press {
  from { transform: rotate(-8deg) scale(1.35); opacity: 0; }
}
.postmark.fading { transition: opacity .18s ease-out; opacity: 0; }
.coupon.stamped::after {
  content: "";
  position: absolute;
  left: -1px;
  top: 12px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--paper);
  box-shadow: inset 0 0 0 1px var(--line);
}
.stamp-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}
/* 手機版面只給螢幕：A4 直式可印寬 190mm≈718px 會落進 900px 門檻，
   不鎖 screen 的話列印會拿到單欄票（票根被撕到票面下方）——票券解剖在紙上必須完整。 */
@media screen and (max-width: 900px) {
  .postmark { right: auto; left: 40%; }
}
@media screen and (max-width: 900px) {
  .ticket-grid { grid-template-columns: 1fr; }
  .stub {
    border-left: 0;
    border-top: 1px dashed var(--line-strong);
  }
  .stub::before,
  .stub::after { display: none; }
  .stats,
  .day-passes,
  .mini-grid,
  .world-clock { grid-template-columns: 1fr 1fr; }
  .coupon { grid-template-columns: 1fr; }
  .coupon-time {
    place-items: start;
    border-left: 0;
    border-top: 1px dashed var(--line-coupon);
    padding: 9px 13px;
  }
  .journey { grid-template-columns: 1fr; }
  .arrow { display: none; }
}
@media screen and (max-width: 560px) {
  .page { padding: 10px; }
  .ticket-stack::before,
  .ticket-stack::after { display: none; }
  .main,
  .stub { padding: 20px 18px 20px 28px; }
  h1 { font-size: 42px; }
  .day-ticket h1 { font-size: 38px; }
  .summary { font-size: 14px; }
  .stats,
  .day-passes,
  .mini-grid,
  .world-clock,
  .source-strip { grid-template-columns: 1fr; }
  .ticket-head { display: grid; }
  .nav a,
  .mode button {
    flex: 1;
    text-align: center;
    padding: 12px;
  }
  .lane { grid-template-columns: 1fr; }
  .bar { height: 30px; }
}
/* P1b · 印刷版 —— 判準照舊：「真的車票會這樣印嗎？」
   一票一頁 A4；互動件（nav / mode / punch / 翻牌鐘）不上紙——紙上按不了；
   封面深底改淺印省墨；條碼放大、microprint 保留（安全印刷帶本來就是印的）。
   注意：瀏覽器預設不印背景色，所以深底上的淡字必須換回紙上油墨 tokens，
   否則會變成白紙印白字。 */
@page { size: A4; margin: 10mm; }
@media print {
  body { background: var(--paper-bright); }
  body::before { display: none; }
  .page {
    display: block;
    min-height: auto;
    padding: 0;
  }
  .ticket-stack { width: 100%; }
  .ticket-stack::before,
  .ticket-stack::after { display: none; }
  .ticket {
    box-shadow: none;
    clip-path: none;
    overflow: visible;
    break-after: page;
  }
  /* 撕孔、timeboard 色塊、條碼、路線縱軸承載資訊，不是可省的裝飾——強制出墨
     （.route-line::before 是 background 畫的紅軸，瀏覽器預設不印背景色，
     漏掉它站與站之間的連線就斷了） */
  .ticket::before,
  .bar,
  .mark,
  .barcode,
  .route-line::before {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  /* 互動件不上紙 */
  .nav,
  .mode,
  .punch,
  .world-clock,
  .flip-board,
  .cta { display: none; }
  /* 封面深色票面改淺印：深底專用的 gold／paper-* 淡字全數換回紙上 tokens。
     gold 不上紙（對比鐵律）；h1 span 是 ≥19px 粗體大字，准用 --rail。 */
  .main {
    background: var(--paper-bright);
    color: var(--ink);
  }
  .main::before { display: none; }
  .eyebrow { color: var(--rail-deep); }
  h1 span { color: var(--rail); }
  .summary { color: var(--ink-soft); }
  .route-pills span {
    border-color: var(--line);
    background: none;
  }
  .stat { border-color: var(--line); }
  .stat span { color: var(--muted); }
  .main .fineprint p { color: var(--muted); }
  .cover-ticket .main .terms li { color: var(--muted); }
  .cover-ticket .main .terms li::before { color: var(--rail-deep); }
  .cover-ticket .main .terms b { color: var(--ink-soft); }
  .cover-ticket .main .stamp {
    border-color: var(--rail-deep);
    color: var(--rail-deep);
  }
  .microprint {
    color: var(--muted);
    border-color: var(--line);
  }
  .stub::before,
  .stub::after { background: var(--paper-bright); }
  /* 條碼放大：印出來要能掃 */
  .barcode { height: 52px; }
  .serial { color: var(--ink-soft); }
  /* 分頁時票卡不腰斬 */
  .coupon,
  .stat,
  .pass,
  .station,
  .mini,
  .kv,
  .barcode-block { break-inside: avoid; }
  /* GSAP 進場動畫用 inline style 驅動（autoAlpha → opacity/visibility、.bar 用 clip-path 揭示）。
     動畫落定前列印、CDN 失敗、或 headless 匯出 PDF 都會把隱藏態印進紙裡——
     stylesheet 的 !important 是唯一蓋得過 inline style 的防線。
     clip-path 只還原 .bar：coupon 的撕角 polygon 是票券解剖，不能動。 */
  .ticket,
  .coupon,
  [data-clock-card] {
    opacity: 1 !important;
    visibility: visible !important;
    transform: none !important;
  }
  .bar {
    opacity: 1 !important;
    visibility: visible !important;
    transform: none !important;
    clip-path: none !important;
  }
  /* 螢幕版 min-height 是桌面票面比例；紙上跟著內容走，不然尾頁多出整張空白票紙。 */
  .ticket-grid { min-height: auto; }
  /* flex 直欄（auto-margin 錨底）在分頁 fragmentation 下會被 Chrome 拉伸出大片空洞——
     紙上不需要錨底，改 block 順排；間距用 margin 補回原本的 flex gap（18px）。 */
  .stub { display: block; }
  .stub > * + * { margin-top: 18px; }
  .cover-ticket .main { display: block; }
}
`

// 記念票畫版 CSS — 只在有海報時注入（無海報時輸出逐 byte 不變，回歸鐵律）。
// 只用既有 token／既有 rgba(255,255,255,*) alpha 慣例，禁新 hex。
const posterCss = `
/* 記念票畫版 — 海報是票面上半的印刷畫，機器層（條碼/microprint/route）不動 */
.poster-panel {
  margin: 14px 0 6px;
  border: 1px solid rgba(255,255,255,.18);
  background: var(--board);
}
.poster-panel img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 3 / 2; /* 鎖比例防 CLS；非 3:2 的圖會被裁切置中 */
  object-fit: cover;
}
.poster-cap {
  font: 600 10px/1.6 var(--font-mono);
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--paper-ghost);
  padding: 4px 8px;
  border-top: 1px solid rgba(255,255,255,.12);
}
/* 海報已是城市名 typography，大字 h1 讓位（壓縮不消失——序號/導航語意還在） */
.cover-ticket.has-poster h1 { font-size: clamp(28px, 4.2vw, 44px); }
/* 海報上紙（不在 print 隱藏清單），分頁時不腰斬 */
@media print {
  .poster-panel { break-inside: avoid; }
}
`

const tzShortCode = (timeZone, atIso, language = 'en-GB') => {
  const parts = new Intl.DateTimeFormat(language, { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(atIso))
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone
}

const tzOffsetMinutes = (timeZone, atIso, language = 'en-GB') => {
  const parts = new Intl.DateTimeFormat(language, { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(atIso))
  const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00'
  const match = raw.match(/GMT([+-])(\d{2}):(\d{2})/)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

const cityOf = (timeZone) => (timeZone || 'UTC').split('/').at(-1).replaceAll('_', ' ')

// Spec 1 · 撕票翻頁的共用腳本：
// 1) pageswap/pagereveal 幫 View Transition 標方向（forward/back），
//    並讓翻頁進場接手時跳過 GSAP intro（避免票面動兩次）。
// 2) 行動裝置（coarse pointer）左右滑翻票：拖曳跟手、過閾值放手＝翻頁
//    （View Transition 從拖到的位置接手撕走），沒過＝彈回（可中斷）；
//    到頭沒有下一張時 rubber-band。桌面滑鼠不啟用。
const ticketNavJs = `
(() => {
  const ticket = document.querySelector('.ticket');
  if (!ticket) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const orderOf = (url) => { const m = url.pathname.match(/day-([0-9-]+)\\.html$/); return m ? m[1] : ''; };
  const tagDirection = (viewTransition, fromUrl, toUrl) => {
    try {
      const from = orderOf(new URL(fromUrl, location.href));
      const to = orderOf(new URL(toUrl, location.href));
      viewTransition.types.add(to >= from ? 'forward' : 'back');
    } catch {}
  };
  window.addEventListener('pageswap', (e) => {
    if (e.viewTransition && e.activation) tagDirection(e.viewTransition, location.href, e.activation.entry.url);
  });
  window.__vtIncoming = false;
  window.addEventListener('pagereveal', (e) => {
    if (!e.viewTransition) return;
    window.__vtIncoming = true;
    const fromUrl = e.activation && e.activation.from && e.activation.from.url;
    if (fromUrl) tagDirection(e.viewTransition, fromUrl, location.href);
  });

  // 導航時把目前的 mode 深連結帶去下一張日票（Relaxed/Full 不無聲重設）。
  const withMode = (href) => {
    const mode = new URLSearchParams(location.search).get('mode');
    if (!mode || !/day-/.test(href)) return href;
    const url = new URL(href, location.href);
    url.searchParams.set('mode', mode);
    return url.href;
  };
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link || link.origin !== location.origin) return;
    const carried = withMode(link.getAttribute('href'));
    if (carried !== link.getAttribute('href')) { e.preventDefault(); location.href = carried; }
  });

  if (!window.matchMedia('(pointer: coarse)').matches) return;
  const prevHref = ticket.dataset.prev || '';
  const nextHref = ticket.dataset.next || '';
  if (!prevHref && !nextHref) return;
  ticket.style.touchAction = 'pan-y pinch-zoom';
  let startX = 0, startY = 0, dx = 0, baseX = 0, dragging = false, decided = false, activeId = null;
  let lastX = 0, lastT = 0, velocity = 0;
  const setDrag = (x) => { ticket.style.transform = 'translateX(' + x + 'px) rotate(' + (x / 60) + 'deg)'; };
  const cleanupDrag = () => { ticket.style.userSelect = ''; ticket.style.webkitUserSelect = ''; };
  const settleBack = () => {
    cleanupDrag();
    if (window.gsap && !reduceMotion) gsap.to(ticket, { x: 0, rotation: 0, duration: .28, ease: 'power3.out', clearProps: 'transform,willChange' });
    else { ticket.style.transform = ''; ticket.style.willChange = ''; }
  };
  ticket.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary || dragging) return;
    if (window.gsap) gsap.killTweensOf(ticket);
    baseX = window.gsap ? (Number(gsap.getProperty(ticket, 'x')) || 0) : 0;
    startX = e.clientX; startY = e.clientY; dx = 0; velocity = 0;
    lastX = e.clientX; lastT = e.timeStamp;
    dragging = true; decided = false; activeId = e.pointerId;
  });
  ticket.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== activeId) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < 14 && Math.abs(my) < 14) return;
      if (Math.abs(mx) <= Math.abs(my)) { dragging = false; return; }
      decided = true;
      try { ticket.setPointerCapture(e.pointerId); } catch {}
      ticket.style.willChange = 'transform';
      ticket.style.userSelect = 'none';
      ticket.style.webkitUserSelect = 'none';
    }
    if (e.timeStamp > lastT) {
      velocity = (e.clientX - lastX) / (e.timeStamp - lastT);
      lastX = e.clientX; lastT = e.timeStamp;
    }
    dx = mx;
    const hasTarget = mx < 0 ? nextHref : prevHref;
    setDrag(baseX + (hasTarget ? mx : mx * .3));
  });
  ticket.addEventListener('pointerup', (e) => {
    if (!dragging || e.pointerId !== activeId) return;
    dragging = false;
    if (!decided) return;
    const target = dx < 0 ? nextHref : prevHref;
    const pastDistance = Math.abs(dx) > Math.min(ticket.offsetWidth * .25, 140);
    const flicked = Math.abs(velocity) > .11 && Math.sign(velocity) === Math.sign(dx) && Math.abs(dx) > 24;
    if (target && (pastDistance || flicked)) { cleanupDrag(); location.href = withMode(target); }
    else settleBack();
  });
  ticket.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== activeId) return;
    dragging = false;
    if (decided) settleBack(); else cleanupDrag();
  });
})();
`

// Signature element: a barcode whose bar widths are derived from the trip id —
// every booklet carries a barcode that actually encodes its own serial.
const barcodeStyle = (seed) => {
  let acc = 7
  const stops = []
  let x = 0
  for (let i = 0; i < 40; i++) {
    acc = (acc * 31 + seed.charCodeAt(i % seed.length) + i * 7) % 9973
    const bar = 1 + (acc % 3)
    const gap = 1 + (Math.floor(acc / 7) % 3)
    stops.push(`var(--ink) ${x}px ${x + bar}px`, `transparent ${x + bar}px ${x + bar + gap}px`)
    x += bar + gap
  }
  return `background-image:linear-gradient(90deg,${stops.join(',')});background-size:${x}px 100%`
}

// Pure: no fs, no node: imports. `hasPoster` is passed in (the fs.existsSync
// read that decides it lives in the renderItinerary wrapper in
// render-local.mjs) so this function runs unchanged in a Cloudflare Worker.
// Async because PWA icon generation deflates PNG data via CompressionStream.
export async function buildItineraryFiles(itinerary, { customTokens, customMotifs, hasPoster }) {
  const language = normalizeLanguage(itinerary.language)
  if (language === 'zh-CN') assertLanguageOutput(itinerary, language)
  else assertBritishEnglish(itinerary)
  itinerary.language = language
  const copy = locale(language)
  const tripId = itinerary.trip_id || 'trip_unknown'
  const shortId = tripId.split('_').at(-1).slice(0, 4)
  const dtz = itinerary.destination_timezone || 'UTC'
  const htz = itinerary.home_timezone || 'UTC'
  const days = itinerary.days || []
  const cover = itinerary.cover || {}
  // theme 只讀欄位、不推斷（舊 JSON 一律 default——回歸鐵律）。
  const themeName = THEMES[itinerary.theme] ? itinerary.theme : 'default'
  const registeredMotifs = THEMES[themeName].motifs || {}
  const themeMotifs = {
    ...registeredMotifs,
    ...Object.fromEntries(
      ['stampText', 'eyebrow']
        .filter((key) => typeof customMotifs?.[key] === 'string')
        .map((key) => [key, customMotifs[key]]),
    ),
  }
  // Trust boundary: customTokens values are interpolated UNESCAPED into raw CSS
  // below. Callers MUST already have run them through the customTheme gate
  // (pipeline/customTheme.mjs) or customTokensFrom (pipeline/trip.mjs) — both
  // enforce an allowlisted key set and a strict #rrggbb hex value shape via
  // validateOverrides (pipeline/contrast.mjs). Never pass unvalidated input here.
  const customCss = customTokens && Object.keys(customTokens).length
    ? `\n:root{${Object.entries(customTokens).map(([k, v]) => `--${k}:${v}`).join(';')};}`
    : ''
  const themeOverrideCss = themeCss(themeName) + customCss
  const anchorIso = days[0]?.items?.[0]?.start_utc || new Date().toISOString()

  const offsetDiffHours = (tzOffsetMinutes(dtz, anchorIso, language) - tzOffsetMinutes(htz, anchorIso, language)) / 60
  const offsetLabel = offsetDiffHours === 0
    ? copy.sameTime
    : `${offsetDiffHours > 0 ? '+' : ''}${offsetDiffHours} ${Math.abs(offsetDiffHours) === 1 ? copy.hour : copy.hours}`
  const clockMini = offsetDiffHours === 0 ? copy.sameAsHome : `${offsetDiffHours > 0 ? '+' : ''}${offsetDiffHours}h vs ${copy.home.toLowerCase()}`

  const bases = [...new Set(days.map((d) => d.base).filter(Boolean))]
  const destinationTop = cover.title_top
    || (itinerary.destination || 'Trip').split(':')[0].trim()
  const destinationAccent = cover.title_accent || 'Itinerary'
  // PWA app names (installed handbook), derived from the cover title.
  const { name: appName, short: appShort } = pwaNames(itinerary, { destinationTop, destinationAccent, language })
  const eyebrow = cover.eyebrow || themeMotifs.eyebrow || (language === 'zh-CN' ? '旅行车票 · UTC 预览' : 'Ticket stack · UTC-first preview')
  // stampJs below is a generated script: escape for SVG text first, then emit
  // the escaped value as a JSON JS string literal so it cannot break either.
  const stampTextJs = JSON.stringify(esc(themeMotifs.stampText || copy.stampMark))
  const travellers = cover.travellers ?? itinerary.travellers ?? '—'

  // Calendar dates are formatted in UTC on a noon anchor so the weekday/date
  // never shifts regardless of the destination offset.
  const fmtDateShort = (date) => new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`))
  const dateRange = days.length ? `${fmtDateShort(days[0].date)}-${fmtDateShort(days.at(-1).date)}` : ''
  const stats = cover.stats || [
    { b: language === 'zh-CN' ? `${days.length} 天` : `${days.length} days`, s: dateRange },
    { b: language === 'zh-CN' ? `${bases.length} 个驻地` : `${bases.length} base${bases.length === 1 ? '' : 's'}`, s: bases.join(' · ') },
    { b: offsetLabel, s: `${cityOf(dtz)} vs ${cityOf(htz)}` },
  ]
  const routeStops = cover.route_stops
    || bases.map((base) => {
      const index = days.findIndex((d) => d.base === base)
      return { name: base, label: days[index]?.title || `Day ${index + 1}`, day_index: index }
    })
  const routeLabel = cover.route_label || copy.route
  const routePills = cover.route_pills || bases

  const pageSlug = (day) => `day-${day.date}.html`
  const modeItems = (day, mode = 'relaxed') => day.items.filter((it) => it.variant === 'both' || it.variant === mode)
  const fmtTime = (iso, timeZone = dtz) => new Intl.DateTimeFormat(language, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
  const fmtDay = (date) => new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(`${date}T12:00:00Z`))
  const itemWindow = (day) => {
    const items = modeItems(day)
    if (!items.length) return ''
    return `${fmtTime(items[0].start_utc)}-${fmtTime(items.at(-1).end_utc)}`
  }

  const head = (title, description, _hasHand) => `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(description || itinerary.summary || title)}"><meta name="theme-color" content="#efe0c3"><meta name="content-language" content="${language}"><link rel="manifest" href="manifest.webmanifest"><link rel="icon" type="image/svg+xml" href="icon.svg"><link rel="apple-touch-icon" href="icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="${esc(appShort)}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><style>${css}${themeOverrideCss}${hasPoster ? posterCss : ''}</style><script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js"></script></head><body>`
  const foot = `<script>if('serviceWorker'in navigator){addEventListener('load',function(){navigator.serviceWorker.register('./sw.js').catch(function(){})})}</script></body></html>`
  const page = (title, body, description, hasHand) => `${head(title, description, hasHand)}<main class="page"><div class="ticket-stack">${body}</div></main>${foot}`
  const annot = (note) => note ? `<span class="annot">${esc(note)}</span>` : ''

  const statusLine = (itinerary.agent_statuses || [])
    .map((s) => `${s.agent.replace(' Agent', '')}: ${s.status}`).join(' · ')
  const variantLabel = (value) => language === 'zh-CN'
    ? ({ both: '共同', relaxed: copy.relaxed, full: copy.full }[value] || value)
    : value
  const typeLabel = (value) => language === 'zh-CN'
    ? ({ travel: '交通', sight: '景点', meal: '餐饮', rest: '休息' }[value] || value)
    : value
  const allSources = itinerary.sources || []
  const sourceLinks = (sources) => sources.map((source) => `<a href="${esc(source.url || '#')}">${esc(source.label || source)}</a>`).join('')
  const terms = () => {
    const list = (itinerary.warnings || []).slice(0, 5)
    // role="list"：list-style:none 會讓 Safari/VoiceOver 拿掉清單語意
    return list.length ? `<ol class="terms" role="list">${list.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ol>` : ''
  }
  const barcodeBlock = `<div class="barcode-block" aria-hidden="true"><div class="barcode" style="${barcodeStyle(tripId)}"></div><div class="serial" translate="no">${esc(tripId)}</div></div>`
  const actionTerms = () => {
    const list = itinerary.actions_suggested || []
    const separator = language === 'zh-CN' ? '：' : ': '
    return list.length ? `<ol class="terms" role="list">${list.map((action) => `<li><b>${esc(action.title)}</b>${separator}${esc(action.description)}</li>`).join('')}</ol>` : ''
  }
  const daySources = (day) => {
    const labels = [...new Set(day.items.flatMap((it) => it.sources || []))]
    if (!labels.length) return allSources.slice(0, 2)
    return labels.map((label) => allSources.find((source) => label.includes(source.label.split(' ')[0])) || { label, url: '#' })
  }
  const titlePair = (day) => {
    const parts = day.title.split('→').map((part) => part.trim())
    if (parts.length === 2) return parts
    const words = day.title.split(/\s+/)
    return words.length > 1 ? [words[0], words.slice(1).join(' ')] : [day.title, day.base]
  }
  // 括號補充語不進 display 層（車票不會把括號印成站名大字）——拆成 h1 下的小字註記。
  const stripNote = (text) => {
    const match = String(text ?? '').match(/^(.*?)[（(]([^（()）]+)[）)]\s*$/)
    return match
      ? { main: match[1].trim() || match[2].trim(), note: match[1].trim() ? match[2].trim() : '' }
      : { main: String(text ?? '').trim(), note: '' }
  }
  const originForDay = (day) => {
    const location = modeItems(day)[0]?.location || day.title
    return location.split('→')[0].trim()
  }

  // 摘要拆段：一堵字牆沒有閱讀節奏。先照換行分段，再在「提醒/注意/備註」
  // 轉折處斷開，仍超過 ~140 字的段落從中點最近的句號再拆一次。
  const splitAtMid = (text) => {
    const sentences = text.split(language === 'zh-CN' ? /(?<=。)/ : /(?<=[.!?])\s+/).filter(Boolean)
    if (sentences.length < 2) return [text]
    const mid = text.length / 2
    let acc = 0
    let cut = 1
    let best = Infinity
    sentences.forEach((sentence, i) => {
      acc += sentence.length
      const distance = Math.abs(acc - mid)
      if (i < sentences.length - 1 && distance < best) { best = distance; cut = i + 1 }
    })
    return [sentences.slice(0, cut).join(''), sentences.slice(cut).join('')]
  }
  const summaryParas = (text) => String(text ?? '').trim()
    .split(/\n+/)
    .flatMap((para) => para.split(language === 'zh-CN' ? /(?<=[。！？])(?=(?:提醒|警告|注意)[:：])/u : /(?<=[.!?])(?=\s+(?:Reminder|Warning|Note)[:：])/i))
    .flatMap((para) => (para.length > 140 ? splitAtMid(para) : [para]))
    .map((para) => para.trim())
    .filter(Boolean)
  const summaryHtml = `<div class="summary">${summaryParas(itinerary.summary).map((para) => `<p>${esc(para)}</p>`).join('')}</div>`

  // Spec 2 · 蓋章：localStorage 持久化（key 綁 trip_id），蓋章時間即紀錄。
  const stampJs = `
(() => {
  const KEY = 'tt-stamps:' + ${JSON.stringify(tripId)};
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {} } catch { return {} } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {} };
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (iso) => { const d = new Date(iso); return { hm: pad(d.getHours()) + ':' + pad(d.getMinutes()), md: pad(d.getMonth() + 1) + '-' + pad(d.getDate()) } };
  const svg = (iso) => { const t = fmt(iso); return '<svg class="postmark" viewBox="0 0 120 120" aria-hidden="true">'
    + '<circle cx="60" cy="60" r="54" fill="none" stroke="currentColor" stroke-width="3"/>'
    + '<circle cx="60" cy="60" r="44" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<text class="pm-head" x="60" y="48" text-anchor="middle">' + ${stampTextJs} + '</text>'
    + '<text class="pm-time" x="60" y="68" text-anchor="middle">' + t.hm + '</text>'
    + '<text class="pm-date" x="60" y="84" text-anchor="middle">' + t.md + '</text></svg>'; };
  // 計數只算「目前模式可見」的章，跟 Stops 的口徑一致；setMode 切換時會重算。
  const refreshCount = () => {
    const el = document.querySelector('[data-stamp-count]');
    if (el) el.textContent = document.querySelectorAll('.coupon.stamped:not(.hide)').length;
  };
  window.__refreshStampCount = refreshCount;
  const applyStamp = (coupon, iso, animate) => {
    coupon.classList.add('stamped');
    coupon.insertAdjacentHTML('beforeend', svg(iso));
    if (!animate) { const m = coupon.querySelector('.postmark'); if (m) m.style.animation = 'none'; }
    const b = coupon.querySelector('.punch');
    b.setAttribute('aria-pressed', 'true');
    // 時刻是機器資料 → Data 角色（mono + tabular-nums）；hm 只含數字與冒號，安全
    b.innerHTML = ${JSON.stringify(copy.stampedButton)} + ' <span class="punch-time">' + fmt(iso).hm + '</span>';
  };
  const removeStamp = (coupon) => {
    coupon.classList.remove('stamped');
    const m = coupon.querySelector('.postmark');
    if (m) { m.classList.add('fading'); setTimeout(() => m.remove(), 200); }
    const b = coupon.querySelector('.punch');
    b.setAttribute('aria-pressed', 'false');
    b.textContent = ${JSON.stringify(copy.stamp)};
  };
  const stamps = load();
  document.querySelectorAll('.coupon[data-item-id]').forEach((coupon) => {
    const id = coupon.dataset.itemId;
    if (stamps[id]) applyStamp(coupon, stamps[id], false);
    coupon.querySelector('.punch').addEventListener('click', () => {
      const s = load();
      if (s[id]) { delete s[id]; removeStamp(coupon); }
      else { s[id] = new Date().toISOString(); applyStamp(coupon, s[id], true); }
      save(s);
      refreshCount();
    });
  });
  refreshCount();
})();
`

  const coverNote = itinerary.cover?.handwritten_note || itinerary.handwritten_note
  const coverStub = () => `
<aside class="stub">
  <div class="stub-title label">${esc(routeLabel)}</div>
  <div class="route-line">${routeStops.map((stop, index) => {
    if (!days.length) return `<span class="stop">${esc(stop.name)}<small>${esc(stop.label ?? '')}</small></span>`
    const dayIndex = Math.min(stop.day_index ?? index, days.length - 1)
    return `<a class="stop" href="${pageSlug(days[Math.max(dayIndex, 0)])}">${esc(stop.name)}<small>${esc(stop.label ?? '')}</small></a>`
  }).join('')}</div>
  <div class="kv"><span>${copy.travellers}</span><b>${esc(travellers)}</b><span>${copy.tripId}</span><b>${esc(shortId)}</b><span>${copy.status}</span><b>${esc(itinerary.status || 'draft')}</b></div>
  ${days.length ? `<a class="cta" href="${pageSlug(days[0])}">${esc(copy.startDay)}</a>` : ''}
  ${annot(coverNote)}
  <div class="fineprint">${terms()}</div>
  <div class="source-strip">${sourceLinks(allSources.slice(0, 6))}</div>
  <div class="status-strip"><div>${esc(statusLine)}</div></div>
  ${barcodeBlock}
</aside>`

  const homeHtml = page(`${destinationTop} ${destinationAccent}`, `
<section class="ticket cover-ticket${hasPoster ? ' has-poster' : ''}"${days.length ? ` data-next="${pageSlug(days[0])}"` : ''}>
  <div class="ticket-grid">
    <div class="main">
      <div class="eyebrow">${esc(eyebrow)}</div>${hasPoster ? `
      <figure class="poster-panel"><img src="poster.png" alt="${esc(destinationTop)} ${esc(copy.posterAlt)}" width="1536" height="1024"><figcaption class="poster-cap" aria-hidden="true" translate="no">${esc(copy.keepsake)} · ${esc(tripId)}</figcaption></figure>` : ''}
      <h1>${esc(destinationTop)}<br><span>${esc(destinationAccent)}</span></h1>
      <div class="route-pills">${routePills.map((pill) => `<span>${esc(pill)}</span>`).join('')}</div>
      ${summaryHtml}
      <div class="stats">${stats.map((stat) => `<div class="stat"><b>${esc(stat.b)}</b><span>${esc(stat.s)}</span></div>`).join('')}</div>
      <div class="day-passes">${days.map((day, index) => `<a class="pass" href="${pageSlug(day)}"><span>${language === 'zh-CN' ? `${copy.day}${index + 1}` : `${copy.day} ${index + 1}`}</span><b>${esc(fmtDay(day.date))}</b><span>${esc(day.title)} · ${esc(itemWindow(day))}</span></a>`).join('')}</div>
      <div class="fineprint"><span class="stamp">${esc(copy.planningPreview)}</span>${actionTerms()}</div>
      <div class="microprint" aria-hidden="true" translate="no">${esc(Array(4).fill(`${(itinerary.destination || 'trip').replace(/[,，].*$/, '')} · ${days[0]?.date ?? ''} → ${days.at(-1)?.date ?? ''} · ${travellers} · ${tripId}`).join('  ///  '))}</div>
    </div>
    ${coverStub()}
  </div>
</section>
<script>${ticketNavJs}</script>`, undefined, Boolean(coverNote))

  const ticks = () => [6, 9, 12, 15, 18, 21].map((hour) => `<span class="tick" style="left:${(hour / 24) * 100}%">${String(hour).padStart(2, '0')}</span>`).join('')
  const zonedMinutes = (iso, timeZone) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat(language, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]))
    return Number(parts.hour || 0) * 60 + Number(parts.minute || 0)
  }
  const mark = (it, timeZone = dtz) => {
    const start = new Date(it.start_utc)
    const end = new Date(it.end_utc)
    const left = (zonedMinutes(start, timeZone) / 1440) * 100
    const right = (zonedMinutes(end, timeZone) / 1440) * 100
    return `<span class="mark ${esc(it.type)}" data-variant="${esc(it.variant)}" style="left:${left}%;width:${Math.max(1.5, right - left)}%"></span>`
  }
  const timeboard = (day) => {
    const lanes = [[dtz, copy.destination], [htz, copy.homeTimezone], ['UTC', 'UTC'], [htz, copy.bodyClock]]
    // aria-hidden: the agenda coupons below carry the same schedule as text.
    return `<div class="timeboard" aria-hidden="true">${lanes.map(([tz, label]) => `<div class="lane"><span class="label">${label}</span><div class="bar">${ticks()}${day.items.map((it) => mark(it, tz)).join('')}</div></div>`).join('')}</div>`
  }
  const clockBoard = (day) => {
    // schema 只保證 items 是陣列、不保證非空：空日就用當天正午當鐘面定錨，
    // 否則 new Date(undefined) → Intl.format 丟 RangeError，整個 render 陣亡。
    const start = modeItems(day)[0]?.start_utc || day.items[0]?.start_utc || `${day.date}T12:00:00Z`
    const cards = [
      { tz: dtz, label: copy.destination, sub: `${cityOf(dtz)} ${copy.destinationTime}`, code: tzShortCode(dtz, start, language) },
      { tz: htz, label: copy.home, sub: `${cityOf(htz)} ${copy.destinationTime}`, code: tzShortCode(htz, start, language) },
      { tz: 'UTC', label: 'UTC', sub: copy.bookingAnchor, code: 'UTC' },
      { tz: htz, label: copy.bodyClock, sub: copy.feels, code: tzShortCode(htz, start, language) },
    ]
    return `<div class="world-clock" aria-label="World clock rail board">${cards.map((card) => `
    <div class="clock-card" data-clock-card>
      <span class="clock-label">${esc(card.label)}</span>
      <span class="clock-sub">${esc(card.sub)}</span>
      <div class="flip-board" data-flip>
        <span class="flip-time">${esc(fmtTime(start, card.tz))}</span>
      </div>
      <span class="flip-code">${esc(card.code)}</span>
    </div>`).join('')}</div>`
  }
  // 蓋章用的穩定 item 指紋（items 沒有 id，用內容雜湊）。
  const itemId = (it) => {
    const seed = `${it.start_utc}|${it.title}`
    let acc = 5381
    for (let i = 0; i < seed.length; i++) acc = ((acc * 33) ^ seed.charCodeAt(i)) >>> 0
    return acc.toString(36)
  }
  const coupon = (it) => `
<article class="coupon" data-type="${esc(it.type)}" data-variant="${esc(it.variant)}" data-item-id="${itemId(it)}">
  <div class="coupon-main"><div class="type">${esc(typeLabel(it.type))} · ${esc(variantLabel(it.variant))}</div><strong>${esc(it.title)}</strong><p>${esc(it.location)}</p><p>${esc(it.notes)}</p>${it.transport_minutes ? `<span class="tag">${it.transport_minutes} ${esc(copy.transfer)}</span>` : ''}</div>
      <div class="coupon-time"><span>${fmtTime(it.start_utc)}<br>${fmtTime(it.end_utc)}</span><button class="punch" type="button" aria-pressed="false" aria-label="${esc(copy.stampAria)}: ${esc(it.title)}">${esc(copy.stamp)}</button></div>
</article>`
  const dayHtml = (day, index) => {
    const [titleFrom, titleTo] = titlePair(day)
    const fromPart = stripNote(titleFrom)
    const toPart = stripNote(titleTo)
    const h1Note = [fromPart.note, toPart.note].filter(Boolean).join('；')
    const from = originForDay(day)
    const previous = days[index - 1]
    const next = days[index + 1]
    return page(`${day.title} ticket`, `
<section class="ticket day-ticket" data-prev="${previous ? pageSlug(previous) : 'index.html'}"${next ? ` data-next="${pageSlug(next)}"` : ''}>
  <div class="ticket-grid">
    <div class="main">
      <div class="ticket-head">
      <div class="nav"><a href="index.html">${esc(copy.cover)}</a>${previous ? `<a href="${pageSlug(previous)}">${esc(copy.previous)}</a>` : ''}${next ? `<a href="${pageSlug(next)}">${esc(copy.next)}</a>` : ''}</div>
        <div class="mode" role="group" aria-label="${esc(copy.itineraryVersion)}"><button type="button" data-mode="relaxed" class="active" aria-pressed="true">${esc(copy.relaxed)}</button><button type="button" data-mode="full" aria-pressed="false">${esc(copy.full)}</button></div>
      </div>
      <div class="eyebrow">${language === 'zh-CN' ? `${copy.day}${index + 1}` : `${copy.day} ${index + 1}`} ${esc(copy.ticket)} · ${esc(day.date)}</div>
      <h1${(fromPart.main + toPart.main).length > 16 ? ' class="long"' : ''}>${esc(fromPart.main)}<br><span>${esc(toPart.main)}</span></h1>${h1Note ? `<p class="h1-note">${esc(h1Note)}</p>` : ''}
      <div class="journey"><div class="station"><span class="label">${esc(copy.from)}</span><b>${esc(from)}</b></div><div class="arrow">→</div><div class="station"><span class="label">${esc(copy.base)}</span><b>${esc(day.base)}</b></div></div>
      <div class="mini-grid"><div class="mini"><span class="label">${esc(copy.date)}</span><b>${esc(fmtDay(day.date))}</b></div><div class="mini"><span class="label">${esc(copy.window)}</span><b>${esc(itemWindow(day))}</b></div><div class="mini"><span class="label">${esc(copy.clock)}</span><b>${esc(clockMini)}</b></div><div class="mini"><span class="label">${esc(copy.mode)}</span><b>${esc(copy.relaxed)} / ${esc(copy.full)}</b></div></div>
      ${clockBoard(day)}
      ${timeboard(day)}
      <div class="agenda">${day.items.map(coupon).join('')}</div>
    </div>
    <aside class="stub">
      <div class="stub-title label">${esc(copy.ticketConditions)}</div>
      <div class="kv"><span>${esc(copy.date)}</span><b>${esc(fmtDay(day.date))}</b><span>${esc(copy.base)}</span><b>${esc(day.base)}</b><span>${esc(copy.stops)}</span><b>${modeItems(day).length}</b><span>${esc(copy.stamped)}</span><b data-stamp-count aria-live="polite">0</b><span>${esc(copy.trip)}</span><b>${esc(shortId)}</b></div>
      <p class="stamp-note">${esc(copy.stampNote)}</p>
      <div class="fineprint"><div class="stamp-row"><span class="stamp">${esc(copy.verify)}</span>${annot(day.handwritten_note)}</div>${terms()}</div>
      <div class="source-strip">${sourceLinks(daySources(day))}</div>
      <div class="status-strip"><div>${esc(statusLine)}</div></div>
      ${barcodeBlock}
    </aside>
  </div>
</section>
<script>${ticketNavJs}</script>
<script>${stampJs}</script>
<script>
const buttons=[...document.querySelectorAll('[data-mode]')];
const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function animateTicketIntro(){
  if(!window.gsap||reduceMotion)return;
  gsap.set('[data-clock-card],.coupon',{transformPerspective:900});
  // 一段進場、~1.2s 內落定；泳道用 clip-path 由左揭示（容器 scaleX 會把 tick 數字壓扁）
  const tl=gsap.timeline({defaults:{duration:.5,ease:'power3.out'}});
  tl.from('.ticket',{autoAlpha:0,y:18,rotationX:5,transformOrigin:'50% 0%'})
    .from('[data-clock-card]',{autoAlpha:0,y:22,rotationX:-74,transformOrigin:'50% 100%',stagger:.06,ease:'back.out(1.45)'},'-=.28')
    .fromTo('.bar',{clipPath:'inset(0 100% 0 0)',autoAlpha:0},{clipPath:'inset(0 0% 0 0)',autoAlpha:1,stagger:.04},'-=.22')
    .from('.coupon:not(.hide)',{autoAlpha:0,y:14,rotationX:-14,stagger:.035},'-=.18');
  // 列印雙保險：intro 進行中按 Cmd+P 就把動畫推到落定（@media print 的 !important 是第一道防線）。
  window.addEventListener('beforeprint',()=>tl.progress(1),{once:true});
}
// mode 切換只動真正變動的內容（新出現的票卡）；翻牌鐘數值沒變就不翻——
// 翻牌的語義是「數值更新了」，拿來演沒發生的事違反誠實原則。可中斷（kill+overwrite）。
let modeTl=null;
function animateModeSwitch(newlyShown){
  if(!window.gsap||reduceMotion||!newlyShown.length)return;
  if(modeTl)modeTl.kill();
  modeTl=gsap.fromTo(newlyShown,{autoAlpha:0,y:10},{autoAlpha:1,y:0,duration:.25,stagger:.03,ease:'power2.out',overwrite:'auto',clearProps:'transform'});
}
// 列印雙保險（同 intro）：mode 切換 tween 進行中列印也要先落定。
window.addEventListener('beforeprint',()=>{if(modeTl)modeTl.progress(1)});
function setMode(mode, animate=true){
  buttons.forEach(button=>{
    const on=button.dataset.mode===mode;
    button.classList.toggle('active',on);
    button.setAttribute('aria-pressed',String(on));
  });
  const newlyShown=[];
  document.querySelectorAll('[data-variant]').forEach(el=>{
    const show=el.dataset.variant==='both'||el.dataset.variant===mode;
    if(show&&el.classList.contains('hide')&&el.classList.contains('coupon'))newlyShown.push(el);
    el.classList.toggle('hide',!show);
  });
  if(window.__refreshStampCount)window.__refreshStampCount();
  if(animate)animateModeSwitch(newlyShown);
}
buttons.forEach(button=>button.addEventListener('click',()=>{
  setMode(button.dataset.mode);
  const url=new URL(location);
  url.searchParams.set('mode',button.dataset.mode);
  history.replaceState(null,'',url);
}));
setMode(new URLSearchParams(location.search).get('mode')==='full'?'full':'relaxed',false);
// 撕票 View Transition 有接手時跳過 GSAP intro（pagereveal 在首次渲染前發出）。
requestAnimationFrame(()=>{ if(!window.__vtIncoming) animateTicketIntro(); });
</script>`, `${language === 'zh-CN' ? `${copy.day}${index + 1}` : `${copy.day} ${index + 1}`} · ${day.date} · ${day.title}`, Boolean(day.handwritten_note))
  }

  const pages = ['index.html', ...days.map(pageSlug)]
  const files = new Map([
    ['index.html', homeHtml],
    ...days.map((day, index) => [pageSlug(day), dayHtml(day, index)]),
  ])
  // PWA: manifest + service worker + icons, so the handbook installs to the
  // home screen and opens offline. Self-contained per dir (dist root + wallet).
  const pwaFiles = await buildPwaAssetFiles({ name: appName, short: appShort, description: itinerary.summary || appName, language }, pages, hasPoster ? ['poster.png'] : [])
  for (const [name, body] of pwaFiles) files.set(name, body)

  return { tripId, pages, files }
}
