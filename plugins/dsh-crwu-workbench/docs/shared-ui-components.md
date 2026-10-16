# 共享 UI 组件（dsh-crwu-workbench）

入口：`src/client/ui/components/index.ts`。所有页面控件从这一份导入；每个控件只有一份实现，
业务模块只保留布局、命中区与测试锚点，不再复制外观。样式所有者：`src/client/ui/styles/`
（`button.ts` / `field.ts` / `select.ts` / `date-picker.ts` / `popover.ts` / `dialog.ts` /
`drawer.ts` / `card.ts`）；token 只声明在 `src/client/styles/tokens.ts`。

## 契约

### Button / IconButton

- `variant`: `primary | secondary | soft | text | danger`（默认 `primary`）；`size`: `sm | md`。
- `loading`: 渲染叠加 spinner 并锁点击，**保持标签宽度**（标签仍在 DOM / 读屏树里）。
- `disabled`: 锁点击；`describedBy`: 关联禁用原因；`onClick`: `React.MouseEventHandler`。
- `buttonRef`: `React.Ref<HTMLButtonElement>`（对象 ref 或回调 ref 都行）。
- 标准 HTML / `data-*` / `aria-*` / 事件属性透传；默认 `type="button"`。
- `IconButton`: 必须有 `label`（同时作 `aria-label` 与 `title` 默认值），其余同上。
  它是方形且**不随拥挤的 flex 行压缩**（`flex: 0 0 auto`），子 SVG 也 `flex: none` —— 图形保持
  自身宽高比（DeepSeek 标记是 23.16:17.04，18px 宽时高 13.24），不要为了塞进窄列改 viewBox。

### TextInput / TextArea

- 受控：`value` + `onChange(value)`；TextInput 才有 `clearable`（只清值、不自动发请求），
  TextArea 没有 clearable。
- `readOnly` / `disabled` / `invalid` / `required`；`id` / `describedBy` / `labelId`
  （`labelId` 只转成 `aria-labelledby`，不会漏成 DOM 属性）。
- `inputRef` 拿到真实 `input` / `textarea`；`controlClassName` 只加在控件本体（页面锚点），
  `className` 加在外层 wrapper；TextInput 另有 `startAdornment` / `endAdornment`。
  有装饰时 wrapper 带 `data-start-adorned` / `data-end-adorned`（标记只在外层，不会漏到 input）；
  起点装饰内缩 12px、图标到文字 8px，且 input 左内距归零（不把 12px + gap 叠成 18px）；
  无装饰输入保持 12px 文字内距。
- TextArea 另有 `rows` / `autoGrow` / `maxRows` / `countLabel`；`onCompositionStart` /
  `onCompositionEnd` 等 composition 事件原样透传（IME 期间不应用上限由调用方决定）。

### FormField

- `children` 是 **render 函数**：`(field) => ReactNode`，`field = { id, labelId, describedBy,
  invalid, required }`；调用方用这些值构建任意共享控件。
- `label` / `required` / `hint` / `error` / `id`；错误渲染在 `${id}-error` 并进入 describedBy。
- 页面锚点用 `dataAttributes`（根）、`hintData` / `errorData`（提示 / 错误元素）。

### Select

- `value` / `options`（`{ value, label, hint?, badge?, disabled? }`）/ `onChange(value)` /
  `placeholder` / `required` / `invalid` / `disabled`。
- `id` 给真实 combobox（`label htmlFor` 能聚焦它）；`labelId` / `describedBy` 关联标签与说明；
  浮层 / 选项 id 由实例前缀生成，**同名实例也不撞 id**。
- `dataAttributes` / `optionAttributes` 提供页面数据钩子（如估值 `data-valuation-*`）。
- 键盘：Enter/Space 打开、方向键 / Home/End 移动、Enter/Space 提交、Escape 关闭并保留原值、
  Tab 关闭不拦截、字符快速定位；`aria-hidden` + `data-crwu-exiting` 只属于退出中的浮层。

### DatePicker

- `value` / `onChange(iso)` / `onValidityChange(valid)` / `min` / `max` / `disabled` / `readOnly` /
  `id` / `describedBy`。
- 校验对 blur / 手动输入 / Enter / Space / 日选择 / 今天统一生效；越界或非法草稿**保留在输入框**
  并给定位错误、**绝不回传 onChange**；空值合法；`onValidityChange(false)` 时调用方应禁用主操作。
- 点开后在**真实 DOM**里聚焦已选日或范围内最近的可用日；月 / 年视图可切换且不会丢一个 day tab stop；
  Escape 只关日历并 stopPropagation；提交 / Escape 恢复触发按钮焦点。
- 弹层宽 288px（`desiredWidth`）并在可用区域内夹取；`min` / `max` 也限制「今天」按钮。

### Popover / usePopover

- `usePopover` 提供测量后的 fixed 定位、containing-block 校准（用**同一 DOM epoch** 的 inline
  `left/top` 与自身 rect 求差并覆盖，不累加）、滚动 / resize / 关闭监听与退出 inert。
- `place()` 依赖 `anchorRef` / `triggerRef`、`listRef`、`contentHeightRef`、`desiredWidth`、
  `insideSelector`、`onRequestClose(reason)`；reason 为
  `outside | escape | tab | focus-leave | owner`，调用方据此决定是否恢复焦点。
- 纯几何在 `popover-model.ts`（Select / DatePicker 共用，不要另写一份）。

## 主题

- token 所有者只有 `src/client/styles/tokens.ts`；深浅两份靠
  `body[data-ds-dark-theme] [data-crwu-scope="workbench"]` 覆盖同名 token，**不用**
  `prefers-color-scheme`。
- 普通交互用 `--crwu-interactive*`；`--crwu-control` / `--crwu-control-text` 是其别名。
  品牌红 `--crwu-brand` 只留给品牌标记与风险语义。

## 浏览器验收（隔离、可重复）

```bash
node install/ui-browser-check.mjs \
  --react-root <node_modules with react + react-dom> \
  --playwright <node_modules with playwright-core> \
  --browser <browser executable> \
  --out <new output directory>
```

`--out` 必须是**尚不存在**的新目录（`mkdir(recursive:false)`；已存在即明确报错，脚本绝不删除
调用方给的任意路径）。`tests/browser/*-fixture.tsx` 用真实源码组件 + 假端口渲染；外部
React/ReactDOM/Playwright 只用于测试，**不进产物与依赖图**。fixture 不访问账号、凭据、真实文件
或 provider；失败或页面报错时脚本非零退出，不做静默跳过。真实 profile 的 live 验收仍由
supervisor / 用户在独立 profile 上运行。
