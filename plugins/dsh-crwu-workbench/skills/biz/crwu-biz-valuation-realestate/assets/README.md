# assets/ · 静态资源

这里只放**不参与计算**的静态资源：报告用的 logo、字体文件、图标。模板与结构契约不放这里
（模板在 `template/`，JSON 结构在 `schemas/`）。

规则：

- 只放**可再分发**的资源，并注明来源与许可；来源不明的图片与字体不进仓。
- 资源文件名用小写连字符（`crwu-logo.png`），不要用中文名 —— 它们在 HTML 报告里要拼进路径。
- 当前没有任何资源被生产脚本读取：`build_report.py` 只渲染 `template/valuation-report.html`
  并内联案例目录里的截图，不从 `assets/` 取文件。放入资源前先确认真的有人读它。

`logo/` / `fonts/` / `icons/` 三个空占位目录已移除：第一期报告用系统字体与纯文字标题，
不引入任何二进制资源。放入资源时先建目录并同时更新本文件说明来源。

## `browser-sites.json` · 站点连接配置

它是 **CLI 的 `browser` 命令族**经 `--sites` 直接吃的**顶层数组**（`id` / `label` / `loginUrl` /
`protectedUrl` / `authCookie` / `authDomains`），只描述"怎么连、怎么判断登录"，**不是业务规范**：
业务上的来源优先级、案例有效性、替代来源条件都在业务知识库的 03 案例选取里。

> DSH 会话里**不要**自己拼命令行：浏览器能力经插件 Host 与结构化 Tool 使用，
> 这个文件只是它们共同读的那份连接配置。

首期只登记**链家**一个站点：

- 站点身份（域名、受保护页、登录状态）必须由各自的 `status` 子命令分别验证 ——
  不能因为同属一家公司就假定一次登录其它站点都通。
- `authCookie` / `authDomains` 只取**仓库里已有记录**的那一组（`lianjia_token` / `.lianjia.com`，
  来自 2026-10-13 浏览器抓取能力工作里写的实测 fixture）。**没有实测记录的来源不写进这个文件** ——
  编一个 cookie 名的后果是登录状态检查永远返回 `unauthenticated`，而员工会一直以为自己没登录。
- 房天下与安居客暂时**不在**这里：仓库里没有它们的 `authCookie` / `authDomains` 实测记录。
  补齐它们必须先有一次真机核对，而不是照着域名猜。
- 站点清单里**没有**"已验证"字段：哪个来源的解析与登录真正通过过真机验收，由 Host 的来源注册表
  单独标注（那是运行期事实，不是一个静态文件能声明的）。

### `loginUrl` 必须是**站点自己发布的那个链接**（2026-10-14 真机实测）

`loginUrl` 是员工在可见窗口里看到并操作的那一页，而链家的登录页是 **passport 服务**：
它靠 URL 上的 `service` 参数识别"是哪个站点在请求登录"。少了它，页面只回一句

```text
Error 指定的服务未被授权，不能认证。
```

并且**一个登录控件都不渲染** —— 员工看到的就是这句话，无从下手。

所以这一条的第一版（直接写裸 passport 地址 `https://clogin.lianjia.com/login`）是错的，现在改成
站点首页自己发布的链接形状：

```text
https://clogin.lianjia.com/login?service=<URL编码的 https://www.lianjia.com/user/checklogin?redirect=<URL编码的 protectedUrl>>
```

三条维护规则：

1. **不要照域名猜**：裸 `login.<域名>` 这类地址（如 `https://login.lianjia.com/`）是 404 的
   JSON 接口。正确的链接可以从站点首页（`https://www.lianjia.com/`）的 HTML 里直接读到（找 `clogin.*` 的
   `<a href>`），改版后就再读一次。
2. **`service.redirect` 必须等于本站的 `protectedUrl`**：登录成功后要回到**本站的受保护页**，
   两处指向不同城市/域名时员工登录完会落到别的站点。有一条守卫钉这件事（
   `tests/unit/host/host-valuation-browser-client.test.mjs`「随包登录入口带着站点要求的 service」）。
3. **换城市时两处一起改**：`protectedUrl` 与 `loginUrl` 里的 `redirect=` 是同一条事实的两份写法。
   若 passport 改了参数契约，退路是把 `loginUrl` 指向站点首页（让站点自己生成登录链接），
   代价是员工要多点一次「登录」。
