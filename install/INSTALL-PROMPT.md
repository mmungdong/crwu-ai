# 安装提示词（粘到收件人的 DSH 对话里）

> 用法：把下面代码块里的全部内容复制，粘贴到**收件人自己**的 DSH 会话里发给 agent。
> 先把仓库拉到本地（或让 agent 自己拉），再把 `<REPO>` 换成真实路径。

```text
请在这个 DSH 里安装「中瑞世联工作台」插件（动态 Cordis 插件，不是 npm 包）。

仓库在 <REPO>（本机绝对路径；若是 URL 请先 clone 到本地并把路径替换进来）。

严格按以下步骤执行，不要跳步、不要凭经验改写代码：

1. 先完整读这两份源码（它们是逐字源码，含中文与全角符号，不要重新排版）：
   - <REPO>/legacy/host.js
   - <REPO>/legacy/client.js
   读之前先跑 <REPO>/install/verify.sh，确认两份文件的 sha256 与 legacy/REV 记录一致、且
   node --check 通过。不一致就停下来告诉我，不要自己修。

2. 用一次 cordis_define 把**两半一起**定义：
   - code.host   = legacy/host.js 的完整内容
   - code.client = legacy/client.js 的完整内容
   - 若是首次安装：plugin.kind = "new"，idPrefix 用 "crwu"
   - 若已存在 crwu-1：plugin.kind = "existing"，pluginId = "crwu-1"
   两半必须同时发。只发 host 半会让浏览器端停留在旧 run 上，之后每次 host.call 都会返回
   stale-run 并被面板静默吞掉（表现为「面板什么都不显示」）。

3. 用 cordis_run 激活：
   - 首次：mode = "run"
   - 已有 currentPackageId：mode = "update"
   需要授权时等我确认。

4. 激活完成后告诉我 pluginId / packageId / pluginRunId。然后：
   - 在**顶层会话**里打开一次工作台运行卡片（或点会话头的「登记为子会话父级」）完成审核父级登记。
     注意：审核只允许挂在顶层会话下；在子代理会话里登记会被拒绝，这是设计如此。
   - 打开面板：先看「环境自检」。未就绪就点「复制提示词」，把安装清单交给 agent 装完
     crwu / dws / ossutil / iFinD 密钥 / 氚云 + 钉钉登录，再点「重新自检」。

5. 回报：env 页里每一项的真实状态（通过/未通过 + 实际版本）、工作空间选到了哪个目录、
   审核父级会话 id 是什么。任何一项没通过都如实说明，不要跳过或假装成功。

注意：
- 不要把这个插件写成 npm 包或文件式插件，DSH 的动态插件只能在会话里定义并激活。
- 不要新建第二个 plugin：同一个工作台重复安装会得到两个面板。
- 不要在源码里加版本头/注释头，保持与 legacy/REV 记录逐字一致。
```

## 更新到新版本

把 `legacy/` 换成新版本后，重复上面第 1、2（`kind: "existing"`，`pluginId: "crwu-1"`）、3（`mode: "update"`）步。
Package 是不可变的：新版本是一个新 Package，旧版本仍可回滚（`mode: "run"` 切回旧 packageId）。

## 卸载

让 agent 调 `cordis_undefine` 并传 `pluginId: "crwu-1"`。DSH 进程重启本身也会让它消失。
