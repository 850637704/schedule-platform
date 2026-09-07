const { parseWorkbook } = require('../utils/parser');
const result = parseWorkbook('/Users/xiaokai/Desktop/高中总课表20260830.xlsx');
console.log('周次:', result.weeks);
console.log('工作表信息:', JSON.stringify(result.sheets, null, 2));
console.log('总记录数:', result.entries.length);
// 抽样
console.log('\n=== 前 8 条 ===');
result.entries.slice(0, 8).forEach(e => console.log(`${e.weekType} ${e.class} 周${e.weekday} ${e.periodLabel}(${e.period}) ${e.subject} / ${e.teacher}`));
// 班级、教师统计
const classes = [...new Set(result.entries.map(e => e.class))].sort();
const teachers = [...new Set(result.entries.map(e => e.teacher).filter(Boolean))].sort();
console.log('\n班级数:', classes.length, classes);
console.log('教师数:', teachers.length, teachers.slice(0, 20));
// 检查某教师某周
const zhou = result.entries.filter(e => e.teacher === '周晓明' && e.weekType === '单周');
console.log('\n周晓明(单周)课时:', zhou.length);
zhou.slice(0, 6).forEach(e => console.log(`  周${e.weekday} ${e.periodLabel} ${e.subject} ${e.class}`));
