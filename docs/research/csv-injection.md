# CSV 导出的公式注入边界（r32-R4）

日期：2026-10-29。对象：`src-tauri/src/activity.rs` 的 `to_csv`（活动记录导出），
唯一调用方是 `activity_cmd::export_activity`。

## 1. 威胁

RFC 4180 的引号只解决分隔符/换行，不解决“电子表格把单元格当公式”。Excel 与
LibreOffice 会执行以 `=`、`+`、`-`、`@`、制表符或回车开头的单元格；即使该单元格在
CSV 里被引号包住也一样。活动记录里的 `detail`、`before`/`after`、别名或启动命令
都是用户文本，因此一份导出的 CSV 可以在打开时变成公式执行面。

## 2. 审计结果

- 全仓只有活动记录导出生成 CSV；Markdown/JSON 导出不是公式上下文，未改。
- 活动记录的字符串字段：`id/tag/action/detail/slug/source/path/target/before/after`；
  `ts` 保持裸整数，便于排序。
- 修复前只做 RFC 4180 引号与双引号转义，**没有**中和公式前缀。

## 3. 修复

`to_csv::field` 在加引号前检查第一个字符；命中 `= + - @ \t \r` 时先插入一个单引号
（OWASP CSV Injection 的既有缓解），再按 RFC 4180 加引号、双写内部引号。BOM 与
`\r\n` 行尾不变。只检查第一个字符：`ok =cmd` 这种值不是公式单元格。

## 4. 验证

```powershell
cd src-tauri
cargo test --lib csv_neutralises_formula_prefixes_before_quoting
cargo test --lib csv_quotes_commas_quotes_and_newlines
```

两组测试通过（2026-10-29）。断言覆盖六种前缀、普通值不受影响、原有逗号/引号/换行
行为不变。

## 5. 边界与未验证

- 没有在本机 Excel/LibreOffice 中实际打开导出文件（未安装/未做 GUI 验证）；结论是
  按 OWASP 规则与生成文本断言，不是“已在 Excel 中观察为文本”。
- 单引号前缀在某些查看器里会显示为字面字符；这是用可读性换公式安全的已知代价。
- 只覆盖活动记录 CSV；未来若新增 CSV 导出，必须复用同一字段函数或重复本测试。

## 6. 来源

- OWASP — CSV Injection：<https://owasp.org/www-community/attacks/CSV_Injection>
- RFC 4180（CSV 引号/行尾）：<https://www.rfc-editor.org/rfc/rfc4180>
