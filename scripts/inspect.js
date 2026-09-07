// 检查工作簿结构
const XLSX = require('xlsx');
const path = '/Users/xiaokai/Desktop/高中总课表20260830.xlsx';
const wb = XLSX.readFile(path);
console.log('=== 工作表列表 ===');
console.log(wb.SheetNames);
console.log('');

wb.SheetNames.forEach(name => {
  const sheet = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  console.log(`\n========== 工作表: ${name} ==========`);
  console.log(`行数: ${rows.length}`);
  // 显示前 12 行，了解表头与数据结构
  const limit = Math.min(12, rows.length);
  for (let i = 0; i < limit; i++) {
    console.log(`行${i}: ${JSON.stringify(rows[i])}`);
  }
  if (rows.length > 12) console.log(`... 共 ${rows.length} 行`);
});
