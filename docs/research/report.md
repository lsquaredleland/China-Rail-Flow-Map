# Chengdu–Chongqing Nonstop Routing — Research Report

**Status:** complete (2026-10-22). The findings are the ground truth for the corridor-routing fix (`docs/PIPELINE.md` §4) and the G2450 adjudication (`docs/MANUAL_OVERRIDES.md`).

Research date: 2026-10-22 (timetable date checked on 12306: 2026-10-23). All sources Chinese-language unless noted. "Verified live" = read in the research browser on the live site; "index" = read via web-index fetch/search extract.

## Summary

**Every nonstop (一站直达) Chengdu–Chongqing train in the current timetable uses route (A), the 成渝高速铁路 (Chengyu HSR). No nonstop service via the northern route (B) was found.** The northern route (today properly 遂成铁路 + 遂渝铁路, i.e. the 成遂渝铁路 / 宁蓉铁路成渝段北线） is worked exclusively by stopping D-class trains (plus a few C-class and sleeper-D and conventional Z/T/K trains) that reach only 重庆北 on that leg, take 1h53 at the very fastest, and in every sampled case make at least one intermediate stop (at 遂宁， 潼南， 合川， 大英东 or 淮口南）. Nonstop running exists only on the HSR, where CR400AF Fuxing trains branded "双城bus" cover 成都东–沙坪坝 in 1h02 with zero intermediate stops (verified live on 12306 for G8609, 2026-10-23). Routing is determined by the service's line plan (which corridor the train is pathed on), which correlates with — but is not strictly caused by — its Chongqing terminal: northern-route trains can only enter 重庆北， while HSR trains can reach 重庆西， 重庆北， 沙坪坝 (and onward to 重庆东/江北机场）. Destination beyond Chongqing matters indirectly: eastbound 沪蓉 (Hurong) through trains to Shanghai/Wuhan are pathed north because the northern route *is* the 宁蓉铁路 main line toward 渝利线， whereas 渝万/渝厦-bound G trains use the HSR into 重庆北/重庆东.

Separately (follow-up question): the conventional no-prefix pair **5611/5612** is **not** a Chengdu–Chongqing train at all in its current form. It is the last surviving passenger pair on the old conventional 成渝铁路， running **内江 (Neijiang) ↔ 江津 (Jiangjin)** only — 219 km, ~6 hours, 22 intermediate stops. It serves neither Chengdu nor any central Chongqing station.

## Findings

### 1. Do any nonstop Chengdu–Chongqing trains run via the northern route (B)?

**No — all nonstop services use route (A).** Evidence:

- **Live 12306 check (verified live, 2026-10-22, for travel date 2026-10-23), 成都东 → 重庆北 city-pair query** (https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc — full-day list of ~150 trains, extract in `notes/12306-live-20261023.md`). The day's fastest trains are all G-class on HSR timings: G8609 09:25–10:27 沙坪坝 **1h02**, G8611 10:40–11:42 沙坪坝 1h02, G8617 1h03, G8673 1h03, G8637 20:22–21:28 重庆西 1h06, G8631 1h08. The fastest train of northern pattern (D-class into 重庆北） is D954 at **1h53** — no northern-pathed train is anywhere near nonstop-HSR timing, and none is below 1h53.
- **G8609 stop list opened live on 12306 (verified live): exactly two stations — 01 成都东 dep 09:25, 02 沙坪坝 arr 10:27 — zero intermediate stops.** This is a true 一站直达 on the Chengyu HSR. (Its sibling 1h02/1h03 trains G8611/G8617/G8673 run the same 成都东–沙坪坝 HSR corridor; Wikipedia 成渝高速铁路 notes the 62-minute 一站直达 trains introduced with CR400AF on 2020-12-24 are branded "双城bus".)
- **Every sampled northern-route train has ≥1 intermediate stop** (stop lists from 12306-based mirrors, data updated 2026-09-11): D3058 stops 遂宁、潼南、合川； D635/D638 stops 遂宁 (skips 潼南/合川）; D354 stops 遂宁、潼南； D362 stops only 淮口南； D5102 stops 大英东、合川. Sources: crecc.com train pages (https://www.crecc.com/huoche/d3058.html, https://www.crecc.com/huoche/d635.html, https://www.crecc.com/huoche/d362.html), ip138 (https://qq.ip138.com/train/d354.htm), gaotie.net D5102 pages — index, read 2026-10-22.
- A practical route signature visible in the 12306 list: northern D trains to 重庆北 are priced ¥85–113 second class, HSR G trains to their first Chongqing station ¥125–175. No train combines a northern fare/time profile with a nonstop pattern.

Caveat: this is "none found in the full-day 12306 list plus sampled stop lists", not a machine-exhaustive proof over every train's stop list (see Could not verify).

### 2. What distinguishes northern-route services in practice?

From the 2026-10-23 12306 full-day list (verified live) and mirror stop lists (index):

- **Class:** almost entirely **D-class** （动车）: the 沪蓉 long-distance family (D351–354, D635–638, D951–954, D2205–2208, D3055–3058, per Chinese Wikipedia 沪蓉动车组列车） and local 成渝 D5xxx/D6xxx trains, plus a few C-class (C78, C3402), sleeper D trains (D50 to 北京西， D981/D985, D967/D977-type to 贵阳 direction via 重庆西 — see §3) and conventional Z/T/K trains (Z588, T8802/T8804, K1258, K504) that also use the northern corridor. No G-class train uses the northern route between Chengdu and Chongqing.
- **Chongqing station: 重庆北 only** for the pure northern services (the route physically enters the Chongqing hub from the north via 北碚/渭沱 into 重庆北）. They never serve 重庆西 or 沙坪坝 on this leg.
- **Stops:** at least one intermediate stop in every sampled case — most commonly 遂宁 (D3058, D635, D354), but not universally: D362's only stop is 淮口南 (it skips 遂宁/潼南/合川 entirely and still takes exactly 2h00), D2208 reportedly stops only at 潼南， D5102 at 大英东+合川. So the accurate statement is "northern trains always stop at least once, usually at 遂宁， sometimes only at a smaller station" — **not** "always at 遂宁".
- **Runtimes (2026-10-23, 成都东→重庆北）:** fastest D954 1h53; D5128 and D2208 1h54; a dense band at 1h58–2h20 (D620 2h00, D362 2h00, D2264 2h01, D368 2h02, D2260 2h03 …); slowest D632/D633 2h45, D50 2h41. Typical ≈ 2h00–2h20. Conventional trains take 2h48 (Z588) to 3h42 (T8802/K1258).
- **Fares:** ¥85–113 second class (vs ¥125–175 on the HSR) — the northern route is the budget option.

### 3. Edge cases

- **沪蓉 through trains （渝利线 direction):** Chengdu→Shanghai/Wuhan D trains (D3058, D635/D638, D354, D362…) are pathed via the northern route because 成遂渝 is the 成渝 section of 宁蓉铁路 (Shanghai–Wuhan–Chongqing–Chengdu corridor); after 重庆北 they continue via 渝利线 to 涪陵北/恩施/宜昌/汉口/上海. Their Chengdu–Chongqing leg is **stopping, never nonstop** — the northern routing is chosen for network/corridor reasons, exactly the "long-distance through train" case the mission asked about, but the leg is not nonstop.
- **渝万高铁 direction （万州/云阳）:** G8685 （成都东 09:18 → 重庆北 10:59, 1h41, ¥158 — HSR fare/time signature, verified live in the 12306 list) continues beyond 重庆北 toward 云阳 on the 渝万城际铁路. Its Chengdu–Chongqing leg is on route (A). G trains to 重庆东 (G2321, G2445, G2417, G2451, G3763…) likewise reach Chongqing via the HSR first （重庆西/重庆北） and continue to 重庆东.
- **渝贵线 direction:** overnight D967/D977-type trains （成都东 → 重庆西 08:52→10:22 in the list, ¥121, sleeper D toward 贵阳北） pass 重庆西 — their exact Chengdu–Chongqing pathing was not traced stop-by-stop (flagged below).
- **Ring/loop services （成渝环线）:** the 12306 day list contains anomalous G trains consistent with ring routings — G8711 成都东 10:00 → 重庆西 12:48 (2h48, ¥206) and G8763 成都南 13:25 → 重庆西 19:53 (**6h28, ¥418**, i.e. the long way round via the southern 成贵/渝贵 loop). Their full stop lists were not traced, so which physical segments each uses is flagged as unverified. Ring trains by construction use * both* corridors over the full loop, so "which route" is not well-defined for them; neither is a nonstop Chengdu–Chongqing service.
- **Terminal vs destination as the determinant:** the Chongqing terminal is a *consequence* of the pathing, not the cause. Route (B) can only deliver 重庆北； route (A) delivers 重庆西/重庆北/沙坪坝 and onward 重庆东/江北机场 (e.g. G8651/G8625/G3763 continue to 江北机场）. The real determinant is the train's corridor assignment: 宁蓉/沪蓉 east–west through services → north; 成渝 HSR locals and south/west-bound G services → HSR. Note 重庆北 is served by *both* routes, so "arrives 重庆北" alone does not identify the route — class, time and fare do.
- **Under construction, not current service:** 成渝中线高铁 (292 km, 350 km/h, ~50 min) is still being built (Sina Finance, 2026-10-18, https://finance.sina.cn/2026-10-18/detail-inivshcf7728094.d.html — index). It does not affect the current answer.

### 4. Line facts and fastest times

| | (A) 成渝高速铁路 | (B) northern route （遂成铁路 + 遂渝铁路） |
|---|---|---|
| Length | 307 km (infobox) / 308.2 km (body: Sichuan 185.5 + Chongqing 122.7) — sources differ, see note | 成遂渝铁路 quoted as 274 km total; another Wikipedia passage gives ~312 km operating mileage 成都东–重庆北 (likely incl. 兰渝 重庆北–渭沱 section) — sources differ |
| Speed | 350 km/h max operating speed; opened 2015-12-26 | 200 km/h-class: 遂成铁路 200 km/h target (opened 2009-07-07); 遂渝铁路 128 km, design 200 km/h (opened 2006, 2nd track 2013) but 渭沱–遂宁南 segment limited to 160 km/h per 宁蓉铁路 article |
| Intermediate stations | 简阳南、资阳北、资中北、内江北、隆昌北、荣昌北、大足南、永川东、璧山， then 沙坪坝/重庆， 重庆西 (via 重庆西联络线）, 重庆北 (via 井口/井西联络线） | 大英东、遂宁、潼南、合川 (+ smaller: 淮口南 etc.), into 重庆北 only |
| Fastest scheduled 成都东→Chongqing (2026-10-23, 12306 live) | **1h02 nonstop** to 沙坪坝 (G8609/G8611); 1h06 to 重庆西 (G8637); fastest to 重庆北 via HSR ≈1h17 (G8625) | **1h53 with stops** to 重庆北 (D954); no nonstop timing exists |
| Typical | 1h15–1h40 stopping G | 2h00–2h20 D |
| 2nd-class fare to first Chongqing station | ¥125–175 | ¥85–113 |

Naming note: the mission's "(B) 达成线 + 遂渝线" reflects older usage. The Chengdu–Suining leg used by these trains is now **遂成铁路** (built as the 达成铁路遂成段扩能改造， opened 2009); today's 达成线 proper diverges at 遂宁 toward 达州 and is not part of the Chengdu–Chongqing path. Sources: Chinese Wikipedia 遂成铁路/遂渝铁路/成遂渝铁路/宁蓉铁路 entries (index, read 2026-10-22).

### 5. Follow-up: the conventional train pair 5611/5612

Source: Chinese Wikipedia "5611/5612次列车" (https://zh.wikipedia.org/wiki/5611/5612%E6%AC%A1%E5%88%97%E8%BD%A6 — index, read 2026-10-22; page crawled early Sep 2026), corroborated by CQNEWS/华龙网 and a Trip.com travel piece. Full note: `notes/train-5611-5612.md`.

- **What it is:** a 普通旅客快车 (conventional passenger express, **no letter prefix**), Chengdu Bureau Group, Chongqing passenger depot, running since July 1952. It is famous as a 公益"慢火车" (public-welfare slow train) and is **the only passenger train pair left on the old conventional 成渝铁路**.
- **Actual route/endpoints — NOT Chengdu–Chongqing:** it runs entirely on the old 成渝铁路 between **内江 (Neijiang) and 江津 (Jiangjin)**, 219 km. It does not reach Chengdu at all, and its Chongqing-side terminus 江津 is a suburban district station, not a central Chongqing station. So of the mission's two guesses, it *is* on the old 成渝线 via 永川， but it is only the eastern stub of that line, not a Chengdu–Chongqing service.
- **Pattern/runtime:** 22 intermediate stops （椑木镇、双凤驿、迎祥街、隆昌、李市镇、安富镇、广顺场、荣昌、峰高铺、大足、长河碥、双石桥、永川、临江场、柏林、茨坝、朱杨溪、平等、白沙、金刚沱、油溪、古家沱） — it stops virtually everywhere. 5611: 内江 10:30 → 江津 16:56 (6h26); 5612: 江津 11:40 → 内江 17:34 (5h54). 25G coaches behind HXD1C/HXD3C electric locos. (The Wikipedia infobox's departure/arrival rows attach the two numbers the other way round; the article body, its runtime row and the timetable arithmetic agree with the assignment given here, as does the older Trip.com piece from the 重庆南 era.)
- **Endpoint history (progressive truncation for the 成渝铁路 upgrading works):** 重庆站 until 2022-06-19 → 重庆南站 from 2022-06-20 → 江津站 from 2024-06-14 → temporarily 古家沱站 2025-07-09 – 2026-09-02 while 江津站 was suspended (then CR Chengdu's shortest scheduled train).
- **Still operating in late 2026?** Yes, on the evidence available: the Wikipedia article as crawled in early Sep 2026 (after the 江津 suspension ended on 2026-09-02) still lists 5611/5612 as the current numbers on the 内江↔江津 section. Flagged: no post-Sep-2026 news item or 12306 listing was found (the train historically is not sold through 12306 online — station windows/on-board only, per the Trip.com piece), so day-to-day operation in Oct 2026 is index-evidenced, not live-verified.

## Could not verify

- **No machine-readable exhaustive stop list** for all ~150 daily Chengdu–Chongqing trains was obtainable. The "no nonstop via (B)" conclusion rests on the full-day 12306 list (times/fares/classes, verified live) plus individually sampled stop lists for representative northern trains (D3058, D635, D354, D362, D5102, D2208). The individual stop lists of the two fastest northern trains, D954 (1h53) and D5128 (1h54), were not captured; a nonstop northern timing is in any case incompatible with the route's 160 km/h 渭沱–遂宁南 segment and ~312 km operating distance.
- **Ring trains G8711 and G8763:** full stop lists not traced; their exact segment-by-segment routing is unverified (only their anomalous times/fares in the live 12306 list).
- **D967/D977-type sleeper D trains via 重庆西 toward 贵阳**: Chengdu–Chongqing pathing not traced stop-by-stop.
- **Conflicting line figures in sources (reported, not resolved):** 成渝高铁 length 307 vs 308.2 km; 成遂渝 length 274 km vs ~312 km operating mileage; 遂渝铁路 current limit stated as 160 km/h in one passage vs 200 km/h in another (Japanese Wikipedia: design 200 / operating 160).
- **5611/5612:** direction-number assignment in the Wikipedia infobox contradicts the same article's body (resolved by arithmetic + corroboration, as noted); late-2026 operation is index-evidenced only, not confirmed on 12306.
- G8501's stopping pattern varies by date (stopping on 2026-10-23); individual G-train patterns other than G8609 were not all opened.

## Sources

1. **12306 official left-ticket query** — https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc — **verified live 2026-10-22**, full-day 成都东→重庆北 list for 2026-10-23; G8609 stop list opened live (成都东 09:25 → 沙坪坝 10:27, no intermediate stops). Extract: `notes/12306-live-20261023.md`.
2. **Chinese Wikipedia, 成渝高速铁路** — https://zh.wikipedia.org/wiki/%E6%88%90%E6%B8%9D%E9%AB%98%E9%80%9F%E9%93%81%E8%B7%AF — index, read 2026-10-22. Line length/speed/stations, 重庆西/重庆北 routings, CR400AF "双城bus" 62-minute nonstops.
3. **Chinese Wikipedia, 遂渝铁路 / 遂成铁路 / 成遂渝铁路 / 宁蓉铁路 / 沪蓉动车组列车** entries — index, read 2026-10-22. Northern-route line facts, segment speed limits, Hurong D-train families.
4. **crecc.com （铁路网） train pages** (12306-based mirror, data updated 2026-09-11) — https://www.crecc.com/huoche/d3058.html , https://www.crecc.com/huoche/d635.html , https://www.crecc.com/huoche/d362.html — index, read 2026-10-22. Stop lists for D3058, D635/D638, D362.
5. **ip138 train timetable** — https://qq.ip138.com/train/d354.htm — index, read 2026-10-22. D354 stop list.
6. **Trip.com Chengdu East → Chongqing North route page** — verified live 2026-10-22. ~150 trains/day, shortest 1h02.
7. **TopChinaTravel Chengdu–Chongqing schedule page** — index, crawled 2026-10-22. Corroborating G 1h02 / D ~1h53+ pattern.
8. **Chinese Wikipedia, 5611/5612次列车** — https://zh.wikipedia.org/wiki/5611/5612%E6%AC%A1%E5%88%97%E8%BD%A6 — index, read 2026-10-22 (crawled early Sep 2026). §5 in full; note `notes/train-5611-5612.md`.
9. **CQNEWS （华龙网）**, "Goodbye, the slow train of Chongqingnan Railway Station" — https://news.cqnews.net/1/detail/1252283195106107392/web/content_1252283195106107392.htm — index, read 2026-10-22. 5611/5612 as 重庆南–内江； closure reason.
10. **Trip.com travel piece**, "Slow Train Journey 5612 Times Searching for Old Chongqing" — https://ca.trip.com/moments/detail/chongqing-158-123035935/ — index, read 2026-10-22. 重庆南-era times; no online ticket sales.
11. **Sina Finance （手机新浪网）**, 2026-10-18 — https://finance.sina.cn/2026-10-18/detail-inivshcf7728094.d.html — index. 成渝中线高铁 still under construction (292 km, 350 km/h).
