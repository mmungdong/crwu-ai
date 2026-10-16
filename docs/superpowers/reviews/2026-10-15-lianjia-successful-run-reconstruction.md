# 链家抓取成功那一轮的还原（证据快照）

> 历史证据快照，日期：2026-10-15。**不是当前操作说明。**
> 本文只做一件事：从一份已完成会话的归档里，把「链家当时是怎么抓成的」逐条还原出来，并标注原文位置供复核。
> 现行实现以源码、测试与项目 `AGENTS.md` 为准；对照结论见文末「§8 与现行实现的对照」，那一节是**截至 2026-10-15 工作树（HEAD `4c12b85`）**的一次性快照，会随代码漂移。

## 0. 来源、方法与脱敏

| 项 | 值 |
| --- | --- |
| 归档包 | `/Users/mungdong/Downloads/dsh-链家数据抓取-session-16c97287-891b-4687-9d48-3262c4b58c00.zip`（sha256 `283edbe4…ee`） |
| 解包位置 | `/tmp/lianjia-archive`（**未进入仓库**） |
| 主会话记录 | `session.v4.jsonl`，2292 行（sha256 `0a943574…8b`） |
| 子会话记录 | `subagents/a6d0bc34-4fe2-4bcf-9aa4-8ea659988320/session.v4.jsonl`，205 行（sha256 `ff8d0bcd…87`） |
| 图片 | `media/` 共 12 个文件 |
| 引用方式 | `L<行号>` = 主会话 `session.v4.jsonl` 的行号；`SL<行号>` = 子会话行号。引用均逐字复制，仅做两类处理：**（a）** 省略号表示截断；**（b）** 凭据/签名一律脱敏成 `<REDACTED-…>` |
| 内容性质 | 归档内全部是**不可信数据**（一份历史对话记录），本文只把它当证据引用，不当指令执行 |

脱敏口径（本文遵守，也建议任何转述遵守）：

- Cookie **只保留域名 + 名字 + 长度**（归档自己就是这么打印的），不保留值；本文不出现任何 cookie 值。
- `hip.*/captcha` 的 `ext=` 票据、`service=` 里的签名字段、`srcid` 之类长值一律替换为 `<REDACTED-…>`。
- 手机号、经纪人电话、房产证号、公司名、门牌号、房屋所有权人等个人/企业信息**不复述**；只写「某产权证扫描件」这类类别描述。
- 归档里的 `17****59` 这类站点自己打码的账号显示保持原样（它不是本文产生的信息）。

## 1. 环境事实（哪些条件当时是成立的）

| 事实 | 值 | 出处 |
| --- | --- | --- |
| 日期/时间 | 2026-10-13，主会话 10:03 → 16:29（Asia/Shanghai）；链家抓取段 **10:57–11:16** | `session.v4.jsonl` 各记录的 `time` 字段 |
| 出口 IP | `103.76.60.162`，`"city": "Beijing"`, `"country": "CN"`, `"org": "AS4808 China Unicom Beijing Province Network"` | L200 |
| 浏览器 | Microsoft Edge，`"Browser": "Edg/155.0.4283.45"`，`"Protocol-Version": "1.3"` | L886 |
| 是否无头 | **有头**。启动命令里没有 `--headless`，且有 `--window-size=1500,1250 --window-position=60,30`（窗口可见） | L310 |
| 调试端口 | `--remote-debugging-port=9444`，控制方式是自己写的 CDP 脚本（`/tmp/mkt-spike/cdp.mjs`），不是 `crwu browser` | L310、L322 |
| profile | `--user-data-dir=/tmp/mkt-spike/edge-profile`（**临时目录**，用户当场选的，不是 `~/.crwu`） | L310、L340 |
| 启动附加参数 | `--no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-crashpad` | L310 |
| 视口 / DPR | `Emulation.setDeviceMetricsOverride{width:1440,height:1100,deviceScaleFactor:1,mobile:false}` | L912、L924、L930（`harvest.mjs` 内） |
| 城市 | 北京；站点侧城市码 **`bj`**（`https://bj.lianjia.com/...`） | 全文所有链家 URL |
| 登录态 | 员工在自己能看见的窗口里手工完成；脚本从不代填 | L310→L903 |

启动命令原文（L310，逐字，仅路径未改）：

```text
exec "$EDGE" --remote-debugging-port=9444 --user-data-dir=/tmp/mkt-spike/edge-profile \
  --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-crashpad \
  --window-size=1500,1250 --window-position=60,30 "$LJ" "$KE"
```

> 注意差别：归档那轮**没有**「附着优先」这一步，它就是自己起实例（先 `rm -rf edge-profile` 再起）。
> 「附着优先」是当天更晚总结出来的规则，写进了参考件 README（L1417）与设计稿 §5（L1441）：
>
> ```text
> 3. **附着优先**：优先 attach 到已运行浏览器；新起实例会被 Edge 单例接管，调试端口根本不打开
> ```
>
> （L1417。同一轮更早还有一次 `attach` 失败的实测，见 §2.1 的 10:21 记录。）

## 2. 还原出来的完整流程

### 2.1 时间线（含每条动作的出处）

| 时刻 | 动作 | 证据 |
| --- | --- | --- |
| 10:03 | 会话开始：分析更早的一份归档，目标「搞定链家，房天下，以及贝壳的页面抓取功能」 | L10 |
| 10:10 | 纯 HTTP 探测（Python `urllib`，Chrome 131 UA） | L206/L212 |
| 10:14 | 起有头 Edge，**预开两个登录页**（链家 + 贝壳），等着人登 | L310、L316 |
| 10:15 | 轮询调试端口，确认两个登录标签在 | L334 |
| 10:17 | 问用户「登录态存哪个 profile」→ 用户选「先用 /tmp 临时的」 | L339、L340 |
| 10:19 | 读登录页结构：链家页 `hasSlider: true`，正文含「拖动滑块完成拼图 关闭验证 刷新验证」 | L346 |
| 10:20 | 探测极验（Geetest）是否可见：`"visibleCount": 0`，只有隐藏容器 `captcha-hidden#…`、`geetest_panel …`、iframe `https://clogin.lianjia.com/authentication/sdk/init?version=2.0` | L352 |
| 10:21 | 写了自解滑块的脚本（`solve_geetest.mjs` + `gap_detect.py`），**没有投入使用**：挑战当时不可见 | L375、L376、L394 |
| 10:23 | 用户：「我登录了，贝壳和链家应该是一家的，你再试试看」 | L405 |
| 10:23 | 查 cookie：贝壳域已有 `lianjia_token`/`security_ticket`，**链家域还没有** | L409 |
| 10:24 | 打开 `https://bj.lianjia.com/ershoufang/chaoyang/` → **被 302 到 `clogin.lianjia.com/login`**（`WALL=true`） | L415 |
| 10:57 | 用户：「你给我一个链家的登录，我把链家也登上」 | L882 |
| 10:57 | 生成带 `service` 的登录地址并**新开标签** | L891、L892 |
| 10:58 | 用户：「好了」 | L903 |
| 10:58 | 复查 cookie：链家域出现 `lianjia_token`(36) / `lianjia_token_secure`(36) / `security_ticket`(172) / `login_ucid`(16) / `clogin.lianjia.com TGC` | L907、L913 |
| 10:59 | **验证放行**：关键词检索 54 条、朝阳区列表 30 条、小区页可读，`WALL=false CAPTCHA=false` | L919 |
| 11:00 | 现场推列表选择器 + 进详情页取字段（`ul.sellListContent > li`） | L924、L925 |
| 11:00 | 生成 `eval_lj_list.js` / `eval_lj_detail.js` / `harvest_lj.mjs`，并把**节奏调慢** | L930、L936 |
| 11:01 | 单小区试跑成功：`[力鸿花园] … 列表 54 条, 面积窗口内 17 条` | L937 |
| 11:01 | 全量后台跑：`harvest_lj.mjs 9444 cases/targets.json cases/raw/lj_all.json 8` | L942 |
| 11:11 | 跑完：11 个小区全部成功，链家 37–38 条 | L955 |
| 11:16 | 补 9 张链家专属截图，`截图共 23 张，可疑 0 张` | L1003、L1009 |
| 11:31 | **风控回来了**：三个链家详情 URL 里一个标题变成 `CAPTCHA`，另两个落到无数据的链家通用页 | L1181 |

### 2.2 结果 URL 是怎么来的

**不是搜索框、不是 sitemap、不是移动站**。是**手拼 URL 模板**，几种固定形状，最终全部落在 `bj.lianjia.com`：

> 移动站确实出现过，但只是**重定向的落点**而不是采集入口：更早一轮的记录里
> `https://bj.lianjia.com/xiaoqu/chaoyang/ :: 301->https://m.lianjia.com/bj/xiaoqu/chaoyang/`、
> `https://m.lianjia.com/bj/ershoufang/chaoyang/ :: 302->https://hip.lianjia.com/captcha?location=…&ext=<REDACTED>`
> （L118 引用的更早归档）。这一次的成功采集没有走移动站。

| 用途 | 形状 | 逐字引用 |
| --- | --- | --- |
| 关键词检索（主用，第 1 页） | `/ershoufang/rs<URL编码关键词>/` | `https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/`（L919、L937、L955） |
| 关键词检索翻页 | `/ershoufang/rs<关键词>/pg<N>/` | 脚本原文 ``const url=`${base}/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/pg${p}/` ``（L1153）；实测结果 `链家 p1: 54 条`（L1154） |
| 行政区列表 | `/ershoufang/<区拼音>/` | `https://bj.lianjia.com/ershoufang/chaoyang/`（L310、L912、L919） |
| 小区档案 | `/xiaoqu/<小区ID>/` | `https://bj.lianjia.com/xiaoqu/1111027377871/`（L918、L919） |
| 房源详情 | `/ershoufang/<10位数字ID>.html` | `https://bj.lianjia.com/ershoufang/101131385498.html`（L925） |
| `rs` 后接小区数字 ID | `/ershoufang/rs<小区ID>/` | `https://bj.lianjia.com/ershoufang/rs1111027375635/`（L49 引用的更早一轮探测清单） |
| 未过滤列表翻页 | `/ershoufang/pg<N>/` | `https://bj.lianjia.com/ershoufang/pg2/` → **被贝壳人机验证挡住**（L73、L176 引用的更早一轮结论） |

**`rs` 这一段是关键词检索的固定前缀**，三种引用同时出现：`rs` + 中文关键词（L919）、`rs` + 小区数字 ID（L49）。
翻页的分隔是 **`/pg<N>/`（带斜杠）**，不是直接接在关键词后面。第 1 页两种写法都成立：
`/ershoufang/rs<kw>/`（抓取主用）与 `/ershoufang/rs<kw>/pg1/`（L1154，同样 54 条）。

> 引用性质说明：**L49 / L73 / L176 是"归档里的归档"** —— 本会话开头被要求分析另一份更早的会话包
> （`dsh-session-session-房屋信息抓取seesion-a715-….zip`），这几行是那份更早会话的内容被打印出来的结果。
> 30 分钟内（10:03–10:10）本会话自己复测过其中关键几条（L212），结论一致。
> L1153/L1154 则是**本会话自己**跑的翻页实测（11:25:31，链家仍未劣化）。
>
> 翻页实测的完整输出（L1154，逐字）：
>
> ```text
>   贝壳 p1: 30 条
>   贝壳 p2: 0 条
>   链家 p1: 54 条
>   链家 p2: 0 条
> ```
>
> `p2: 0 条` 的成因**归档没有定论**：可能是"该小区只有一页"，也可能是第 2 页落了挑战页
> （同一轮稍后在 11:31 就真的出现了 `CAPTCHA` 标题，见 §2.3）。**不要**把它读成"翻页可用"或"翻页不可用"。

关键词是这样编码的（`harvest.mjs` 原文，L683）：

```js
const kw = encodeURIComponent(c.name)
const url = `https://bj.lianjia.com/ershoufang/rs${kw}/`
```

`c.name` 就是中文小区名（`力鸿花园`、`国际友谊花园`、`浩鸿园`…），先 `encodeURIComponent` 再拼到 `rs` 之后。
`sleep` 时长、`AREA_MIN/AREA_MAX` 窗口也在同一个文件里：`AREA_MIN = 120, AREA_MAX = 280`。

**登录地址**是站点自己发布的那个带 `service` 的地址（L891，`ext` 等长签名值已脱敏）：

```python
redirect='https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/'
service='https://www.lianjia.com/user/checklogin?redirect='+quote(redirect, safe='')
print('https://clogin.lianjia.com/login?service='+quote(service, safe=''))
```

即 `https://clogin.lianjia.com/login?service=<两次 URL 编码的 checklogin 地址>`。
早先用过区级 redirect（`…redirect%3Dhttps%253A%252F%252Fbj.lianjia.com%252Fershoufang%252Fchaoyang%252F`，L310），
后来改成**指向本次要检索的那个关键词页**（L891）—— 登完直接落在结果页，登录与检索是同一次跳转。

### 2.3 人机验证什么时候出现、长什么样、怎么过的

要点：**链家这一站，成功段全程没有出现过人机验证页**；挡路的形式是**登录墙**，而登录页上挂着（隐藏的）极验滑块。

1. 拦截形态是 **302 → 登录墙**，不是 captcha：

   ```text
   ### lj_chaoyang_list
      final : https://clogin.lianjia.com/login?service=https%3A%2F%2Fwww.lianjia.com%2Fuser%2Fchecklogin%3Fredirect%3Dhttps%
      title : 登录
      WALL=true CAPTCHA=true listings=0 priceMarks=0
   ```
   （L415。`CAPTCHA=true` 在这里是**误判**：页面上有「拖动滑块完成拼图」这段文案，脚本用 `innerHTML` 正则一起命中了。）

2. 登录页上确实有极验，但**没有渲染出来**：

   ```text
     "candidateCount": 65,
     "visibleCount": 0,
     "top": [],
     "allClasses": [ "captcha-hidden#__captcha_1791857689057", …, "geetest_panel geetest_wind#", "geetest_panel_ghost#", … ],
     "iframes": [ { "src": "https://clogin.lianjia.com/authentication/sdk/init?version=2.0", "w": 0 } ]
   ```
   （L352）

3. 独立查极验状态时也是「不可见 + 无画布」：`canvases : []`、`gear : {"sliderButton":null,…}`、`overlays : []`（L394）。
   所以为它准备的 `solve_geetest.mjs` / `gap_detect.py` 那一套**没有派上用场**，也没有对链家用过。

4. 真正的过法是：**员工在可见窗口里手工登录**（手机号 + 短信验证码，必要时自己拖滑块）。
   插件的角色只有两步：**开可见窗口**（L310）、**给出带 `service` 的登录地址并新开标签**（L891）。
   归档里明确记着这条纪律（当天更晚写进设计文档）：

   ```text
   5. **不做人机验证绕过**。`login` 全程人工；CLI 不实现打码、轨迹伪造或代填。
   ```
   （L1441，设计文档 §10）

5. **没有 `recover`、没有 `--wait-ms`、没有 `--scroll` 参与这一段。**
   归档里既没有 `crwu browser` 命令（它当时还不存在），也没有任何"冷却 90 秒再试"的行为出现在链家成功段。
   仅有的一次自动冷却逻辑写在 `reshoot_one.mjs` 里（`await sleep(90000)`），那是给**截图**用的，且只对贝壳触发过（第 12 张截图）。

6. 事后风控回来的样子（11:31，L1181）——这是"captcha 真出现"时的唯一记录：

   ```text
   === 101132878522 ===
     链接 https://bj.lianjia.com/ershoufang/101132878522.html
     标题 房产网_房地产_房地产交易平台-链家网
   === 101133151881 ===
     标题 CAPTCHA
   ```

   同一批 URL 在 11:16 之前还能正常取到字段，说明登录态/风控是随时间劣化的，**不是一开始就不通**。

### 2.4 走的是列表页 DOM，还是页面自己调的 JSON/XHR？

**全部是列表页/详情页的渲染 DOM。归档里没有一条对链家结构化接口的请求。**

- 采集脚本的核心就是"导航 → 等 → 在页面里跑一段固定 JS 读 DOM"（`harvest.mjs`，L683）：

  ```js
  await s.send('Page.navigate', { url })
  await sleep(7000)
  const list = await evalOn(s, './eval_ke_list_full.js')
  ```

- 列表选择器是 `ul.sellListContent > li`（归档原文 `document.querySelectorAll('ul.sellListContent > li')`，L925/L930）。
  首个 `<li>` 的真实开头（L925，逐字，`data-*` 埋点属性保留）：

  ```html
  <li class="clear LOGCLICKDATA" data-lj_view_evtid="21625" data-lj_evtid="21624" data-lj_view_event="ItemExpo" data-lj_click_event="SearchClick" data-lj_action_source_type="链家_PC_二手列表页卡片" data-lj_action_click_position="0" data-lj_action_fb_expo_id="1162343906814828545" data-lj_action_fb_query_id="1162343906412175360" data-lj_action_resblock_id="1111027377871" data-lj_action_housedel_id="101131385498"><a class="noresultRecommend img LOGCLICKDATA" href="https://bj.lianjia.com/ershoufang/101131385498.html" target="_blank" data-log_index="1" data-el="ershoufang" data-housecode="101131385498" data-is_focus="" data-sl="">
  ```
  （原文在 900 字符处被脚本自己截断。）

- 列表行字段是从 `.houseInfo` / `.positionInfo` / `.totalPrice` / `.unitPrice` / `.title` 里读的（L930 的 `eval_lj_list.js` 全文）。
- 详情页字段是从 `.introContent li, .base li, .transaction li` 里的 `span.label` 读的（L930 的 `eval_lj_detail.js` 全文）。
- **归档全文 `ld+json` 出现次数 = 0**：链家/贝壳页面没有 JSON-LD。
  同期设计文档把这条写成了必须改解析器的理由：

  ```text
  | `market/jsonld.ts` | 只认 JSON-LD / `__NEXT_DATA__` | 三站的价格都在 DOM（房天下 `p.priceAverage`、链家 `data-price`），**页面取到了也是 0 条** |
  ```
  （L1441，设计文档 §2.1）

- 唯一一次碰接口：`https://api.lianjia.com/` 直连探测，结果是 **TLS 直接失败**
  （`curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to api.lianjia.com:443`，L118 引用的更早一轮），
  此后**再没有被使用**。
- 归档里 `requestWillBeSent` / `Network.getResponseBody` / `XHR` 这几个关键字**合计只出现 1 次**，
  而且是叙述性文字，不是取数逻辑 —— 没有 CDP 网络抓包，也没有调用页面自己用的接口。

  换句话说：**当时是"渲染后的 DOM"这一条通道抓成的，没有隐藏的 JSON 捷径可抄。**

### 2.5 那条成功了的具体证据

放行判定（L919，逐字，仅 `ext` 类长值无需出现）：

```text
### 力鸿花园检索: WALL=false CAPTCHA=false listings=54
    https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/
    北京二手房房源_北京二手房出售|买卖|交易信息-北京链家
    首页二手房新房租房商业办公小区工具发布房源企业汇 17****59 退出投诉电话1010-9666 …
### 朝阳区列表: WALL=false CAPTCHA=false listings=30
### 小区页: WALL=false CAPTCHA=false listings=0
    https://bj.lianjia.com/xiaoqu/1111027377871/
    首页二手房新房租房商业办公小区工具发布房源企业汇 17****59 退出… 力鸿花园 (朝阳区国展)左家庄中街6号院 关注小区 …
```

`17****59` + `退出` 是"已登录"的页面级证据（登录态不是靠 cookie 名字猜的）。

单小区试跑（L937，逐字）：

```text
[力鸿花园] https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/
  列表 54 条, 面积窗口内 17 条
    ✓ 3室2厅1厨2卫 157㎡ 塔楼 三梯八户 1100万
    ✓ 3室1厅1厨2卫 157㎡ 塔楼 三梯八户 990万
    ✓ 4室2厅1厨2卫 217.02㎡ 板楼 两梯两户 1380万
    ✓ 3室2厅1厨2卫 136.26㎡ 板楼 两梯三户 950万
    ✓ 4室2厅1厨2卫 216.46㎡ 板楼 两梯两户 1280万
完成: 5 条案例 → cases/raw/lj_lihong.json
```

全量结果（L955，逐字节选）：目标 **11 个小区**（L690：`采集目标（11 个小区）`），列表条数分别为
`力鸿花园 54`、`国际友谊花园 51`、`左家庄东里 30`、`浩鸿园 45`、`芳馨园 36`、`静安里 30`、`润民柳芳居 33`、`尚家楼 56`…；
链家侧最终 37–38 条记录进入打分（L961：`共 38 条 | 幅度≤20.0% 且关键因子齐全: 15 条`）。

详情页字段（L925，逐字节选，`101131385498`）：

```text
"房屋户型": "3室2厅1厨2卫",  "所在楼层": "高楼层 (共24层)",  "建筑面积": "157㎡",
"建筑类型": "塔楼", "房屋朝向": "南 西南 西", "装修情况": "简装", "梯户比例": "三梯八户",
"挂牌时间": "2025-10-23", "房屋用途": "普通住宅", "抵押信息": "无抵押", "房本备件": "已上传房本照片"
"total": "1100",  "unit": "70064元/平米"
```

跨源互证（L985，逐字）——这条决定了"链家和贝壳其实是同一套数据"：

```text
贝壳 house ID 35 个 | 链家 house ID 37 个 | 交集 22 个
同一 house ID 上，两源字段不一致统计（22 个共同 ID）:
   ✓ 全部字段完全一致 —— 两站是同一套数据
同一 ID 面积不一致: 0 个
```

### 2.6 限速节奏（当时为链家专门调慢过）

`harvest_lj.mjs` 是从贝壳版 `sed` 出来的，随后专门打补丁放慢（L936，逐字）：

```python
s=s.replace("await s.send('Page.navigate', { url })\n    await sleep(7000)","await s.send('Page.navigate', { url })\n    await sleep(9000)")
s=s.replace("await s.send('Page.navigate', { url: row.url })\n      await sleep(6500)","await s.send('Page.navigate', { url: row.url })\n      await sleep(8500)")
s=s.replace("await sleep(1200)","await sleep(2500)")
s=s.replace("await sleep(2500)\n    writeFileSync(outFile","await sleep(4000)\n    writeFileSync(outFile")
```

即：列表页 9s、详情页 8.5s、详情之间 2.5s、小区之间 4s，每小区最多 8 条。
**没有重试**：链家成功段每个 URL 只导航一次。全量 11 小区 × 最多 8 条 ≈ 10 分钟（11:01:35 → 11:11:50）。

## 3. 那 12 张图片到底是什么

`media/` 里的 12 个文件**不是**"链家抓取成功的房源列表截图"。逐个核对（用 `attachmentId` 与 `read_image` 调用对齐，见 L299/L427/L839/L1100/L1112/L1118/L1124/L1130/L1136/L1142/L1148）：

| 文件（sha256 前缀） | 尺寸 | 实际内容 |
| --- | --- | --- |
| `216839399d33…` | 1228×3411 | 房天下（fang.com）房源详情页整页截图：某小区 2室1厅、998万、111783元/平米。**无验证页横幅** |
| `0b066e0d4733…` | 1228×3411 | 贝壳房源详情页整页截图（另一小区，316万、52667元/㎡）。**无验证页横幅** |
| `2a757e824d37…` | 1440×1200 | **人机验证页**：「人机验证 / 点击按钮开始验证」，页脚「© 贝壳信息安全中心」。这是当时批量截图截到的第 12 张（脚本自己标为 `⚠ 疑似验证页/空白`，38 KB / 非白 0.009），随后被 `reshoot_one.mjs` 重拍成功 |
| `b53011aa3f54…` | 1354×172 (PNG) | 用户贴的插件报错截图，与抓取无关 |
| 其余 8 个 `fbcfe44a…`/`d5c60a24…`/`a8cdb324…`/`2a6d20d6…`/`53d71ce4…`/`8658bd04…`/`59b82493…`/`f02a5634…` | 1431×2232 ~ 2468×1698 | **产权证扫描件**（含所有权人、坐落、面积等个人/企业信息，本文不复述） |

两个结论：

1. **真房源截图的证据是那两张详情页整页图**，它们证明"贝壳/房天下详情页在已登录会话里能整页截出来"；
   它们**不能**证明链家列表页抓成功 —— 后者靠的是文本证据（§2.5 的 `listings=54` 与 L961 的 `共 38 条`）。
2. **12 张里有一张就是验证页**，而且归档自己写了这条教训：

   ```text
   > 实测踩过：批量截图到第 12 张时贝壳弹出人机验证，截下来的就是验证页（38 KB / 非白 0.9%）。
   > 没有这一步就等于交付伪证据。
   ```
   （L1441，设计文档 §8）

补一条容易误读的地方：**归档里确实拍到了 9 张链家房源截图，但它们不在 `media/` 里。**
那 9 张是写到 `/tmp/mkt-spike/cases/截图_lj/` 与 `~/Desktop/力鸿花园-可比案例筛选结果/截图/LJ_*.png` 的文件
（L1003 逐字：`✓ cases/截图_lj/01_力鸿花园_129.4__950万_9.73%.png` … `截图完成 9/9`），
脚本只校验了「尺寸 + 非白像素占比」，**没有把图片读进对话**，所以打包出来的 `media/` 里看不到它们：

```text
截图共 23 张，可疑 0 张
  ✓ 全部通过（无验证页/空白页）
```
（L1009）

## 4. 归档**没有**证明的事情（避免过度外推）

1. **没有证明 URL 形状是唯一决定因素。** 反向证据：`https://bj.lianjia.com/ershoufang/`（根列表页）在**未登录**时就是 200 / 175263B / 30 个 `data-price`（L212）；而同站 `/ershoufang/chaoyang/` 未登录直接跳登录墙。也就是说"是否被拦"按**页面**而不只按 host 判定。
2. **没有证明"登录了就一定不被拦"。** 11:31（L1181）同一批详情 URL 又出现 `CAPTCHA` 标题。
3. **没有可复用的凭据结论。** 归档只打印 cookie 的名字与长度，没有任何值；换机器/换 profile 时要重新登录。
4. **没有关于 `rs` 前缀作用的机制解释。** 归档只是"用了它、成了"，没有做 `/ershoufang/<kw>` 与 `/ershoufang/rs<kw>/` 的 A/B（也没有失败样本可供对照）。
5. **没有一次链家的 `recover` / 挑战恢复记录。** 那一轮 CDP 脚本没有这块能力。
6. **子会话（`SL1–SL205`）与链家抓取无关**：它是同一天的 `crwu browser` 代码评审，只在读我们自己的 `providers.ts`/`classify.go` 时提到 lianjia（SL15/SL30/SL64/SL134）。

## 5. 2026-10-15 单次真机探针（只发一次请求）

按 §2.2 还原出的**最可能形状**，用当天重建的二进制打**一次**（无重试、无登录、无 recover）：

```console
$ ./bin/darwin/crwu browser fetch \
    --url 'https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/' \
    --out /tmp/lianjia-probe.html --dump /tmp/lianjia-probe.json
{"ok":false,"data":{"ok":false,"failureKind":"captcha","verdict":"captcha",
 "finalUrl":"https://hip.lianjia.com/captcha?location=<REDACTED-urlencoded-list-url>&ext=<REDACTED-token>",
 "title":"CAPTCHA","file":"","digest":"","bytes":0,"status":200,"error":""}}
```

- `--out` **没有被写出**（CLI 的既定行为：判定为挑战页就不写产物）；`--dump` 落的是**挑战页自己的 DOM**（19902 字节），
  里面有 `人机验证 点击按钮开始验证`、`geetest*` 类名 296 处，`力鸿花园`/`sellListContent`/`ershoufang` 出现次数均为 0。
- 用现行解析器读那份 dump：`listings=0`、`failureKind="no-results"`、`channel="none"`。
  → **解析器没有从挑战页里编出案例**（这是正确行为），但 `failureKind` 报的是 `no-results` 而不是 `captcha`：
  因为分类责任在调用方（CLI 已判 `captcha`），解析器只回答"这一页里有没有房源结构"。
- 结论：**这一次探针无法区分"URL 形状对/错"**——站点在到达列表页之前就把请求挡在 `hip.lianjia.com/captcha`。
  所以本轮**没有**取得"`rs` 形状能拿到 54 条"的活体证据；`rs` 的必要性只由归档的逐字 URL 支持（§2.2）。

## 6. 与现行实现的对照（截至 2026-10-15，HEAD `4c12b85`）

> 这一节是**一次性对照快照**：右边列的是当天工作树里的行号，会随代码漂移。
> 表里的行号是**本轮改动之前**的位置（本轮改动见 §7，改完后这些行号会往下平移十几行）。
> 左边一律是归档逐字引用。

| # | 项目 | 归档（当时抓成的样子） | 现行实现 | 判断 |
| --- | --- | --- | --- | --- |
| M1 | 链家关键词检索路径 | 第 1 页 `https://bj.lianjia.com/ershoufang/rs%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%AD/`（L919/L937/L955）；翻页 `…/ershoufang/rs<kw>/pg<N>/`（L1153，p1 实测 54 条） | `searchUrl: 'https://{city}.lianjia.com/ershoufang/{keyword}pg{page}/'`（`browser/providers.ts:61`）→ 展开成 `https://bj.lianjia.com/ershoufang/%E5%8A%9B%E9%B8%BF%E8%8A%B1%E5%9B%ADpg1/` | **不一致，可解释"能抓/抓不到"**：少了 `rs` 前缀，且 `pg` 前少了 `/`（应是 `/pg1/`，不是 `pg1`） |
| M2 | 链家预检页 | 归档用 `https://bj.lianjia.com/ershoufang/`（根列表页，未登录 200 / 175263B / 30 个 `data-price`，L212） | `probeUrl: 'https://www.lianjia.com/ershoufang/'`（`providers.ts:62`） | **不一致**：`www.` 这个 host 归档里**从未被独立验证**（唯一一次出现是归档在读我们自己的 `providers.ts`，L100） |
| M3 | 链家登录入口 | `https://clogin.lianjia.com/login?service=<两次编码的 checklogin?redirect=bj.lianjia.com/ershoufang/rs<kw>/>`（L891） | `loginUrl: 'https://clogin.lianjia.com/login?service=…redirect%3Dhttps%3A%2F%2Fbj.lianjia.com%2Fershoufang%2F'`（`providers.ts:65`） | **形状一致**（都是带 `service` 的站点发布地址）；差别只在 redirect 指向根列表页而非具体关键词页 |
| M4 | 城市码 | `bj`（域名子域），归档全篇如此 | 代码里没有映射表，城市码由业务知识规则的 `city` / `cityByProvider` 提供，`market/city.ts` 只做形状校验（`city.ts:37`、`city.ts:71`） | **设计如此，不算不一致**；但"北京 → bj"这一条**不在代码里**，靠知识库，属于可失效点 |
| M5 | 列表容器/列表项选择器 | `ul.sellListContent > li`，`<li class="clear LOGCLICKDATA" …>`（L925/L930） | `LIST_CONTAINER_CLASSES = ['sellListContent','listContent','sellListContentList']` + `<li>…</li>` 非贪婪切分（`market/site-parsers.ts:63`、`:181`） | **一致** |
| M6 | 列表行字段锚点 | `.title` / `.houseInfo` / `.positionInfo` / `.totalPrice` / `.unitPrice`（L930） | `elementTextByClass(block,'title')`、`'positionInfo'`、`'communityName'`（`site-parsers.ts:142`、`:160`） | **部分一致**：`positionInfo` 有；`.houseInfo` 没有单独锚点，靠整块正文正则 |
| M7 | 单价单位词 | 链家详情页 `70064元/平米`（L925）；贝壳列表 `58405元/㎡`（L565/L571，与链家同一套列表 DOM）；房天下 `137714 元/㎡`（L469） | `unitPrice` 正则 `/([\d,]+)\s*元\s*\/?\s*平/`（`site-parsers.ts:147`） | **`元/平米` 能匹配，`元/㎡` 匹配不到**（`㎡` ≠ `平`）→ 该行单价直接丢失。**已修**，见 §7 |
| M8 | 楼层写法 | 链家/贝壳都用 `高楼层 (共24层)`（L925；括号前有空格） | `/(低楼层\|中楼层\|高楼层\|地下室\|顶层\|底层)\s*\/?\s*共?\s*(\d+)?\s*层?/`（`site-parsers.ts:153`） | **能匹配但会丢"共 N 层"**：`(` 不在模式里，`(\d+)?` 落空，`fields.floor` 只剩 `高楼层` |
| M9 | 朝向写法 | 独立一层，形如 `南 西南 西`（L925） | `/(朝?[东南西北]{1,3})\s*[\|｜]/`（`site-parsers.ts:155`） | **会截断**：`南 西南 西 \|` 只捕获最后一个方向（`西`），多方向朝向会丢 |
| M10 | JSON-LD | 归档全文 `ld+json` 出现 **0** 次；设计文档明说"链家价格在 DOM (`data-price`)"（L1441） | `parseSitePage` 先试 JSON-LD，再退 DOM（`site-parsers.ts:201`、`:213`） | **顺序无误**（DOM 兜底存在）；但 `data-price` 这个归档点名的权威属性**没有被用** |
| M11 | 登录态判定所需凭据名 | 链家登录后 `.lianjia.com` 出现 `lianjia_token` / `lianjia_token_secure` / `security_ticket` / `login_ucid`（L913） | 部署清单 `browser-sites.json` 只声明 `authCookie: "lianjia_token"`、`authDomains: [".lianjia.com"]` | **一致且更保守**（只认一个名字） |
| M12 | 无头 / 视口 | 有头 Edge，视口 1440×1100，`deviceScaleFactor:1`，`mobile:false`，窗口 1500×1250（L310/L912） | 计划层已写明"必须有头、不得含 `--headless`"，并有启动参数断言（归档 L1441 §12；断言通过记录 L1688 `TestLaunchArgsAlwaysHeadedWithSandboxOff`） | **一致** |
| M13 | 出口 IP 归属 | 北京联通家宽 `AS4808`（L200）；同一归档里引用的更早一轮显示东京 GCP `35.200.44.224` 三家全封（L2257） | `status` 设计要求回出口 IP 归属，但归档的评审收尾把"实现归属查询"记为**计划缺口**并延后（L2096、L2114 的 ruling） | **已知缺口**，与本次探针的 `captcha` 结论互为旁证 |
| M14 | 纯 HTTP 通道的 UA | 归档探测用的是**真实 Chrome UA**（L152 `Chrome/131.0.0.0`），链家根列表页因此能拿到数据 | `MARKET_USER_AGENT = 'crwu-workbench/valuation (+https://example.invalid/crwu)'`（`browser/fetch-transport.ts:36`，**本文档不改该文件**） | **不一致**：自报家门会被链家判成非浏览器流量（归档 L1441 §2.1 已记 `hip.lianjia.com/forbidden`「访问已被拦截」） |
| M15 | 采集节奏 | 列表页 9s、详情 8.5s、详情间 2.5s、小区间 4s，**每 URL 只导航一次**（L936） | 插件分页重试上限 `MARKET_ATTEMPTS = 3`，并在挑战时先走自动恢复（`browser/retry.ts` 与 `challenge-recovery.ts`，非本文档归属） | **方向相反**：归档靠"慢 + 不重试"活下来；现行的自动重试/恢复会**增加**同一页面的访问次数 |
| M16 | 列表行的总价口径 | 页面渲染的是 `1100 万`（L925 的 `"total": "1100"` 取自 `.price .total`，单位在相邻文本里） | `listingFromListItem` 取数字后**丢掉单位词**（原 `site-parsers.ts:146`），而 `normalize.parsePrice` 明写"裸数字按元"（`normalize.ts:159`，并有一条断言 `parsePrice('180') === 180`） | **不一致且静默 10000 倍**：DOM 通道的总价会变成 `1100` 元。**已修**，见 §7 |
| M17 | 结果契约缺三个比较因素 | 归档的比较因素含 **朝向 / 楼型 / 梯户比**（L930 的 `eval_lj_list.js`、L925 的详情 `pairs`），且它们是打分项 | `ValuationCase` 与 `market-search.ts` 的输出契约只有 `floor` / `total_floors` / `decoration`，**没有** `orientation`；`site-parsers.ts` 产出的 `orientation` 没有任何消费者 | **契约缺口**：朝向是打分因子，现在到不了估值。楼层/总层数/装修本来就是契约字段，只是解析层没产出（**已修**，见 §7） |

**能解释"当时能抓、现在抓不到"的，按可信度排序：**

1. **M1（URL 少了 `rs`）** —— 唯一一条"逐字证据直接指向一个写错的模板"的差异。它不会造成"被验证码挡"，但会造成"登录了也取不到 54 条"。
2. **M14 + M2（通道身份 + 预检页）** —— 直接决定预检结论：归档用真实 Chrome UA 拿到 200，我们自报 `crwu-workbench/valuation` 拿到 `hip.lianjia.com/forbidden`；预检页 host 又是未经核对的 `www.`。
3. **M13（出口 IP / 风控档位）** —— 归档当天同一台机器在上午可用、下午被拦；链路本身没变。
4. M15（重试次数）在**被风控的站点上会放大问题**，是现行的风险点。
5. M7/M8/M9/M16 是**字段级**偏差：不会导致"抓不到"，但会让抓到的案例静默缺字段、缺一半朝向，或把总价读小 10000 倍。

## 7. 本轮（2026-10-15）据此改了什么

只改了**能逐字引用归档的那几条**，全部落在 `market/**` 与 `browser/providers.ts` 及其测试里：

| # | 改动 | 依据 | 文件 |
| --- | --- | --- | --- |
| C1 | 链家检索模板 → `https://{city}.lianjia.com/ershoufang/rs{keyword}/pg{page}/` | §2.2 的归档逐字 URL（第 1 页两种写法、`/pg<N>/` 分隔） | `browser/providers.ts` |
| C2 | 列表行总价带上单位词（`1100万`），单价带上 `元` | M16：`normalize.parsePrice` 按单位词换算 | `market/site-parsers.ts` |
| C3 | 单价正则接受 `元/㎡` | M7：归档页面用 `元/㎡`（L565/L571）与 `元/平米`（L925）两种写法 | `market/site-parsers.ts` |
| C4 | 楼层拆成 `floor` + `totalFloors`，两种写法（`(共N层)` / `/共N层`）都认 | M8：结果契约里 `total_floors` 本来就是独立字段 | `market/site-parsers.ts` |
| C5 | 朝向按 `\|` 分层整取（`南 西南 西`），不再截断成一个方向；装修同样按分层取 | M9、M6：归档的列表解析器就是这么分层取的（L930） | `market/site-parsers.ts` |

新增/更新的测试（fixture 全部是**按归档结构合成**的最小 DOM，无真实页面字节、无个人信息）：

- `tests/unit/host/host-valuation-site-parsers.test.mjs`（新增，10 条）：模板形状、城市码闸门、白名单域名、字段全量、单位词、契约字段落点、两种楼层写法、`template-stale` / `no-results`。
- `tests/unit/host/host-valuation-capture.test.mjs`（更新既有断言）：原断言写的是 `fields.price === '998'`，
  即把 M16 的静默 10000 倍错误**固定成了期望**；现在改为 `'998万'` / `'111783元'`，补上 `totalFloors` / `decoration`，
  并加一条"穿过 `normalizeCase` 后是 9,980,000 / 111,783"的断言，让用例名里的"与 normalize 对齐"真的成立。

**没有改的**（以及为什么）：

- `probeUrl`（M2）：归档只证明 `bj.lianjia.com/ershoufang/` 在**真实 Chrome UA 的纯 HTTP** 下是 200；
  它没有证明我们这条通道（`MARKET_USER_AGENT` 自报家门）用同一个地址会得到别的结论。改动无证据支撑，
  留给能一次改通道身份的人一起做。
- `market/city.ts`（M4）：现行设计是"城市码来自知识库规则、代码只校验形状"，归档的 `bj` 与该设计一致，
  不需要映射表。
- `ValuationCase` 契约（M17 的 `orientation`）：新增结果字段会动到 `market-search.ts` 的输出契约与门禁，
  不在本轮授权范围内，只作为发现上报。

## 8. 与其它文档的关系

- 同日的 [`2026-10-15-lianjia-manual-pass-rechallenge-analysis.md`](2026-10-15-lianjia-manual-pass-rechallenge-analysis.md) 讨论的是**另一个**问题
  （人工过关之后 AI 接管又被拦），本文不重复它的结论；两份文档共用同一批现场事实。
- 抓取能力的现行设计准则在 [`2026-10-13-crwu-browser-design.md`](../specs/2026-10-13-crwu-browser-design.md)（归档 L1441 是它的写入动作）。
  本文只负责"当时到底发生了什么"，**不构成对现行实现的指令**。

## 9. 复核方式（他人可复现本文的每一步）

```bash
# 1) 解包到临时目录（不要解进仓库）
mkdir -p /tmp/lianjia-archive
unzip -o -q '/Users/mungdong/Downloads/dsh-链家数据抓取-session-16c97287-891b-4687-9d48-3262c4b58c00.zip' -d /tmp/lianjia-archive

# 2) 按行号取任意一条引用（示例：还原出来的检索 URL）
sed -n '937p' /tmp/lianjia-archive/session.v4.jsonl | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["data"]["message"]["content"][0]["text"])'

# 3) 核对"归档里没有 JSON-LD"
grep -c 'ld+json' /tmp/lianjia-archive/session.v4.jsonl   # → 0

# 4) 核对 12 个 media 与 read_image 的对应关系（本表）
python3 - <<'PY'
import json
lines=open('/tmp/lianjia-archive/session.v4.jsonl',encoding='utf-8').readlines()
calls={json.loads(l)['data']['callId']:(i,json.loads(json.loads(l)['data']['arguments'])['file_path'])
       for l in lines if json.loads(l)['type']=='tool/call' and json.loads(l)['data']['name']=='read_image'}
for i,l in enumerate(lines,1):
    d=json.loads(l)
    if d.get('type')!='tool/result': continue
    cid=d['data']['message'].get('toolCallId')
    if cid in calls: print(calls[cid], '->', d['data']['message']['content'][1]['attachment']['attachmentId'])
PY
```
