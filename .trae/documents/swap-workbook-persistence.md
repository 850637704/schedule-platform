# 调课记录持久化到课表工作簿 - 实现计划

## Context

当前调课功能仅在 JSON 数据层面交换课程条目（subject/teacher），上传的 Excel 工作簿不受影响。用户需要：
1. 调课提交时同步修改 Excel 工作簿中对应工作表的单元格
2. 在"7调课记录"工作表中追加调课记录
3. 上传课表时解析已有调课记录并展示在调课界面底部

## 涉及文件

| 文件 | 操作 |
|------|------|
| `utils/workbookWriter.js` | **新建** - Excel 工作簿读写工具 |
| `utils/parser.js` | 修改 - 添加调课记录解析 |
| `server.js` | 修改 - upload 返回调课记录，swap/execute 同步修改 Excel |
| `public/index.html` | 修改 - 调课界面添加记录展示区 |
| `public/js/app.js` | 修改 - 加载和展示调课记录 |
| `public/css/style.css` | 修改 - 调课记录列表样式 |

## 实现步骤

### 1. 新建 `utils/workbookWriter.js`

使用 ExcelJS（已有依赖）操作工作簿。

**核心函数：**

```javascript
// 判断年级：使用 new Date() 获取当前日期，动态计算年级
// 例：2026年9月13日 → currentYear=2026
//   班级代号"24xx" → 入学2024 → 2026-2024+1=3 → 高三（只改对应周）
//   班级代号"25xx" → 入学2025 → 2026-2025+1=2 → 高二（单双周都改）
//   班级代号"26xx" → 入学2026 → 2026-2026+1=1 → 高一（单双周都改）
function getGradeLevel(classCode) {
  const match = String(classCode).match(/^(\d{2})/);
  if (!match) return null;
  const enrollYear = 2000 + Number(match[1]);
  const currentYear = new Date().getFullYear();
  return currentYear - enrollYear + 1; // 1=高一, 2=高二, 3=高三
}

// 在工作簿中查找班级行和星期列，定位单元格
function findCellPosition(worksheet, className, weekday, periodLabel)

// 修改工作簿：交换两个单元格的科目值
async function modifyWorkbookOnSwap(templatePath, source, target, weekType)

// 在"7调课记录"工作表中追加一条记录
async function appendSwapRecord(templatePath, record)

// 读取"7调课记录"工作表中已有记录，返回最大序号
async function getSwapRecords(templatePath)
```

**modifyWorkbookOnSwap 逻辑：**
1. 用 ExcelJS 打开 `uploads/template.xlsx`
2. 判断年级（classCode 前两位 → 当前年份 - 入学年份 + 1）
   - 高三（grade==3）：只修改当前 weekType 对应的工作表
   - 高一/高二（grade!=3）：同时修改单周和双周工作表
3. 在目标工作表中定位班级行（A 列匹配班级名）和星期列（Row 2 匹配星期 + Row 3 匹配节次标签）
4. 交换两个单元格的科目值
5. 保存文件

**appendSwapRecord 逻辑：**
1. 打开工作簿，找到"7调课记录"工作表（如不存在则创建）
2. 查找已有数据的最后一行，获取最大序号
3. 在下一行写入：序号(max+1)、单双周、调出(班级/节次/科目/教师)、调入(班级/节次/科目/教师)、变动日期
4. 保存文件

**节次格式**：`${WEEKDAY_NAMES[weekday]}${periodLabel}`（如"周一第2节"）
**日期格式**：`YYYY-MM-DD-HH:mm:ss`

### 2. 修改 `utils/parser.js`

添加 `parseSwapRecordSheet(sheet)` 函数：
- 用 `XLSX.utils.sheet_to_json(sheet, { header: 1 })` 读取
- 跳过前 2 行表头，从第 3 行开始解析
- 每行解析：序号、单双周、调出(班级/节次/科目/教师)、调入(班级/节次/科目/教师)、变动日期
- 返回 records 数组

在 `parseSchoolFormat(wb)` 中调用：
- 查找名为含"调课记录"的工作表
- 解析后返回 `swapRecords` 字段

### 3. 修改 `server.js`

**`/api/upload` 路由：**
- 解析结果中包含 `swapRecords`
- 返回给前端

**`/api/swap/execute` 路由：**
- 执行 JSON 数据交换后（已有逻辑）
- 调用 `modifyWorkbookOnSwap(TEMPLATE_FILE, source, target, weekType)` 修改 Excel
- 调用 `appendSwapRecord(TEMPLATE_FILE, record)` 追加调课记录
- record 包含：weekType、source(class/period/subject/teacher)、target(class/period/subject/teacher)、timestamp

**新增 `GET /api/swap/records` 路由：**
- 从 TEMPLATE_FILE 读取调课记录并返回

### 4. 修改 `public/index.html`

在 `#view-swap` 的 `.swap-legend` 之后添加：

```html
<div id="swap-records-section" class="swap-records-section">
  <h3>调课记录</h3>
  <div id="swap-records-list" class="swap-records-list"></div>
</div>
```

### 5. 修改 `public/js/app.js`

- `loadSwapView()` 中加载调课记录
- `executeSwapAction()` 成功后刷新调课记录
- 新增 `loadSwapRecords()` 函数：调用 `GET /api/swap/records`，渲染为列表
- 展示格式：`2401班：单周周一第2节语文（姚绍兰）与单周周二第5节化学（杨良英）互换2026-09-10-15:09:56`

### 6. 修改 `public/css/style.css`

添加 `.swap-records-section` 和 `.swap-records-list` 样式。

## 注意事项

- 年级判断使用 `new Date().getFullYear()` 获取当前年份，结合班级代号前两位（入学年份）计算：`grade = currentYear - enrollYear + 1`，grade==3 为高三
- 若工作簿无"7调课记录"工作表，自动创建（格式参考 server.js 模板生成代码 L630-L649）
- 撤销操作仅恢复 JSON 数据，不回滚 Excel 工作簿（用户未要求）
- 工作簿不存在时（未上传过）跳过 Excel 修改，不影响 JSON 层调课

## 验证方式

1. 启动服务：`node server.js`
2. 上传含"7调课记录"工作表的课表 Excel
3. 进入调课界面，确认底部显示已有调课记录
4. 执行一次调课，检查：
   - Excel 工作簿中对应工作表的单元格已交换
   - "7调课记录"工作表新增一行记录，序号递增
   - 调课界面底部列表刷新，显示新记录
5. 重新上传同一文件，确认调课记录被正确解析展示
