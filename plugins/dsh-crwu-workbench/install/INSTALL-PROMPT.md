# 安装提示词（粘到收件人的 DSH 对话里）

> 用法：把下面代码块里的全部内容复制，粘贴到**收件人自己**的 DSH 会话里发给 agent。
> 这是「装插件」的提示词；装完插件后，面板会用另一份提示词引导完成**登录与密钥**
> （氚云 / 钉钉登录 + iFinD 密钥）。`crwu` / `dws` / `ossutil` **随插件自带**，不需要安装，
> 也不需要任何 PATH 配置。

```text
请在这台机器的 DSH 里安装「中瑞世联工作台」插件（DSH 包插件，按 npm 分发）。

先确认 dsh CLI 可用，然后装进要用的 profile（下面以 web 为例；装了插件的 profile 必须重启）：

  dsh --version
  dsh plugin --profile web add dsh-crwu-workbench

如果这台机器连不上公共 npm，改用下面任一条（这两条会拉源码、走 prepare 构建，
pnpm ≥ 10 需要 allowBuilds 授权，请如实报告授权情况，不要绕过）：

  dsh plugin --profile web add <本仓 tarball 路径>
  dsh plugin --profile web add github:<owner>/<repo>

装完必须重启该 profile，插件才会加载。重启后：

1. 打开侧栏的「中瑞世联工作台」。
2. 如果页面只有「环境自检」一个标签，说明**登录或密钥**还没配齐：点那一页的「复制提示词」，
   **按它说的在面板里操作**（④ 登录与凭据授权 里点「氚云登录」/「钉钉登录」，⑤ OSS 交付配置 里填
   AK，⑥ 外部数据 里配 iFinD 密钥）。
   注意：`crwu` / `dws` / `ossutil` **随插件自带**，**不要**下载、安装或复制它们，
   也不要把插件的 `bin/<平台>/` 目录加到 PATH —— 插件自己用包内绝对路径启动它们。
3. 要发起审核，先在**顶层会话**的会话头点「登记为子会话父级」——审核只允许挂在顶层会话下。

几条必须遵守的：

1. **不要凭经验发明安装方式**：装法就是上面的 `dsh plugin --profile <p> add`。
2. **不要试探连通性**：连不上 npm 就直接停下来告诉我，不要反复重试或换源。
3. **密钥、令牌一律不要回显**到对话或日志里。
4. **不要手工 npm publish**：本仓发布走 tag，见 README 第五节。
5. 若这台机器的受限沙箱模式没有可用后端（macOS 上 `sandbox-exec` 无法套娃），
   插件发出的 shell 调用会被 DSH 按契约拒绝（报 sandbox mode ... no sandbox backend is usable）。
   这时按 DSH 的提示把模式切到 danger-full-access（DSH_PERMISSION_MODE=danger-full-access，
   或改 profile 里 dsh-sandbox-policy 的 mode），并告诉我你改了什么。
6. 每一项都要实际验证：dsh plugin 装完能列出该依赖、重启后侧栏真的出现工作台入口，
   面板「环境自检」里 ② 插件内置组件 3/3、③ DSH 脚本运行时、④ 登录与凭据授权、⑤ OSS 交付配置
   都显示已就绪。
   请把「实际执行的命令 + 真实输出」逐项回报；跳过或失败的项也要说明原因。
7. **不要去找 `crwu` / `dws` / `ossutil` 的路径**：不要 `which` / `find`、不要改 PATH、
   不要往 `~/bin` 放副本、也不要让收件人改 shell 配置 —— 插件用包内绝对路径启动它们。
```
