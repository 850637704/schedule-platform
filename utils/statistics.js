// 课时统计工具：教师周/月课时统计
const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 节次标签 -> 时段类型：早自习 / 白课 / 晚自习
function periodType(periodLabel) {
  const s = String(periodLabel || '');
  if (/早/.test(s)) return 'morning';      // 早自习
  if (/晚/.test(s)) return 'evening';     // 晚自习
  return 'day';                            // 白课（1-8）
}

// 教师课时统计
// 周课时 = 教师在本周排的课节数（按不同星期+节次去重）
// 分别统计 早自习 / 白课(1-8) / 晚自习(晚1-晚4)
function teacherStatistics(entries) {
  const teacherMap = new Map(); // teacher -> Set("weekday|period")
  const teacherClasses = new Map();
  const teacherSubjects = new Map();
  const teacherSlotsByType = new Map(); // teacher -> {morning:Set, day:Set, evening:Set}
  for (const e of entries) {
    if (!e.teacher) continue;
    const key = `${e.weekday}|${e.period}`;
    const ptype = periodType(e.periodLabel);
    if (!teacherMap.has(e.teacher)) {
      teacherMap.set(e.teacher, new Set());
      teacherClasses.set(e.teacher, new Set());
      teacherSubjects.set(e.teacher, new Set());
      teacherSlotsByType.set(e.teacher, { morning: new Set(), day: new Set(), evening: new Set() });
    }
    teacherMap.get(e.teacher).add(key);
    teacherSlotsByType.get(e.teacher)[ptype].add(key);
    if (e.class) teacherClasses.get(e.teacher).add(e.class);
    if (e.subject) teacherSubjects.get(e.teacher).add(e.subject);
  }
  const result = [];
  for (const [teacher, slots] of teacherMap) {
    const byType = teacherSlotsByType.get(teacher);
    const weeklyHours = slots.size;
    result.push({
      teacher,
      weeklyHours,
      monthlyHours: weeklyHours * 4,
      morningHours: byType.morning.size,    // 早自习节数
      dayHours: byType.day.size,            // 白课(1-8)节数
      eveningHours: byType.evening.size,    // 晚自习节数
      classCount: teacherClasses.get(teacher).size,
      subjectCount: teacherSubjects.get(teacher).size,
      classes: [...teacherClasses.get(teacher)].sort(),
      subjects: [...teacherSubjects.get(teacher)].sort(),
      // 每日分布
      dailyDistribution: getDailyDistribution(entries, teacher)
    });
  }
  result.sort((a, b) => b.weeklyHours - a.weeklyHours);
  return result;
}

// 某教师每日课时分布
function getDailyDistribution(entries, teacher) {
  const dist = {};
  for (let wd = 1; wd <= 7; wd++) dist[wd] = 0;
  for (const e of entries) {
    if (e.teacher === teacher) dist[e.weekday] = (dist[e.weekday] || 0) + 1;
  }
  return dist;
}

// 班级课时统计
// 分别统计 早自习 / 白课(1-8) / 晚自习(晚1-晚4)
function classStatistics(entries) {
  const classMap = new Map();
  const classSlotsByType = new Map();
  for (const e of entries) {
    if (!e.class) continue;
    const key = `${e.weekday}|${e.period}`;
    const ptype = periodType(e.periodLabel);
    if (!classMap.has(e.class)) {
      classMap.set(e.class, new Set());
      classSlotsByType.set(e.class, { morning: new Set(), day: new Set(), evening: new Set() });
    }
    classMap.get(e.class).add(key);
    classSlotsByType.get(e.class)[ptype].add(key);
  }
  const result = [];
  for (const [cls, slots] of classMap) {
    const byType = classSlotsByType.get(cls);
    result.push({
      class: cls,
      weeklyHours: slots.size,
      morningHours: byType.morning.size,
      dayHours: byType.day.size,
      eveningHours: byType.evening.size
    });
  }
  result.sort((a, b) => b.weeklyHours - a.weeklyHours);
  return result;
}

module.exports = { teacherStatistics, classStatistics, WEEKDAY_NAMES };
