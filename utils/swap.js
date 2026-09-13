// 课表对调（调课）核心算法
// 同班课程对调：交换两节课的 subject 和 teacher 字段（class/weekday/period 不变）

const { MEETING_SUBJECT_MAP } = require('./parser');

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周天'];

// 单双周关联科目映射：信息(单周)<->心理(双周)，美术(单周)<->音乐(双周)
const PAIRED_SUBJECTS = {
  '信息': '心理', '心理': '信息',
  '美术': '音乐', '音乐': '美术'
};

/**
 * 根据节次序号或标签判断课程时段类型
 * 早自习 / 白课(第1-8节) / 晚自习(晚1-4节)
 */
function getPeriodType(period, periodLabel) {
  const label = (periodLabel || '').trim();
  if (label.includes('早')) return 'morning';
  if (label.includes('晚')) return 'evening';
  // 无标签时按序号推断：1-8 为白课，9+ 为晚自习
  if (period >= 1 && period <= 8) return 'day';
  return 'evening';
}

/**
 * 构建「教师 -> 必须参加的会议名列表」映射
 * 基于 teacherMap 和 MEETING_SUBJECT_MAP
 */
function buildTeacherMeetings(teacherMap) {
  const teacherMeetings = {}; // teacherName -> Set(meetingName)
  if (!teacherMap) return teacherMeetings;

  // 先构建 subject -> Set(teacherName) 和 _班主任 -> Set(teacherName)
  const subjectTeachers = {}; // subjectKey -> Set(teacherName)
  for (const [code, info] of Object.entries(teacherMap)) {
    for (const [key, val] of Object.entries(info)) {
      if (!val) continue;
      if (!subjectTeachers[key]) subjectTeachers[key] = new Set();
      subjectTeachers[key].add(val);
    }
  }

  // 再根据 MEETING_SUBJECT_MAP 反向构建 teacher -> meetingNames
  for (const [meetingName, subjects] of Object.entries(MEETING_SUBJECT_MAP)) {
    for (const subj of subjects) {
      const teachers = subjectTeachers[subj];
      if (!teachers) continue;
      for (const t of teachers) {
        if (!teacherMeetings[t]) teacherMeetings[t] = new Set();
        teacherMeetings[t].add(meetingName);
      }
    }
  }
  return teacherMeetings;
}

/**
 * 检查教师在指定时段是否有必须参加的会议
 * @param {string} teacherName - 教师名
 * @param {number} weekday - 星期
 * @param {string} periodLabel - 节次标签
 * @param {Array} meetings - 会议列表 [{ name, weekday, periodLabel }]
 * @param {Object} teacherMeetings - teacher -> Set(meetingName) 映射
 * @returns {string|null} 会议名，如无冲突返回 null
 */
function checkTeacherMeeting(teacherName, weekday, periodLabel, meetings, teacherMeetings) {
  if (!meetings || !meetings.length || !teacherMeetings) return null;
  const myMeetings = teacherMeetings[teacherName];
  if (!myMeetings || !myMeetings.size) return null;
  for (const m of meetings) {
    if (m.weekday === weekday && m.periodLabel === periodLabel && myMeetings.has(m.name)) {
      return m.name;
    }
  }
  return null;
}

/**
 * 计算可对调候选课程
 * @param {Array} entries - 该周次的所有课表条目
 * @param {Object} source - 源课程 { class, weekday, period, weekType }
 * @param {string} weekType - 周次类型
 * @param {Array} meetings - 会议列表
 * @param {Object} teacherMap - 教师映射
 * @param {Array} allEntries - 全量课表条目（含所有周次，用于检查关联科目对周教师冲突）
 * @returns {Object} { source, candidates }
 */
function computeSwapCandidates(entries, source, weekType, meetings, teacherMap, allEntries) {
  // 找到源课程条目
  const sourceEntry = entries.find(e =>
    e.class === source.class &&
    e.weekday === source.weekday &&
    e.period === source.period &&
    (e.weekType || '通用') === weekType
  );
  if (!sourceEntry) return { source: null, candidates: [], error: '未找到源课程' };

  // 同班级的所有课程（必须有教师才能对调）
  const sameClassEntries = entries.filter(e =>
    e.class === sourceEntry.class &&
    (e.weekType || '通用') === weekType &&
    e.teacher
  );

  const teacherMeetings = buildTeacherMeetings(teacherMap);

  const candidates = [];
  for (const target of sameClassEntries) {
    // 跳过源课程自身
    if (target.weekday === sourceEntry.weekday && target.period === sourceEntry.period) continue;

    const result = checkSwappable(entries, sourceEntry, target, weekType, meetings, teacherMeetings, allEntries || entries);
    candidates.push({
      class: target.class,
      teacher: target.teacher,
      subject: target.subject,
      weekday: target.weekday,
      period: target.period,
      periodLabel: target.periodLabel,
      swappable: result.swappable,
      rejectReason: result.reason
    });
  }
  return { source: sourceEntry, candidates };
}

/**
 * 检查两节课是否可对调
 * 条件：时段类型相同 + 源教师在目标时段空闲 + 目标教师在源时段空闲 + 双方无会议冲突
 * 高一/高二：如果涉及关联科目（信息/心理、美术/音乐），还需检查对周关联教师的冲突
 */
function checkSwappable(entries, source, target, weekType, meetings, teacherMeetings, allEntries) {
  // 0. 课程时段类型必须相同（早自习/白课/晚自习 不可互调）
  const sourceType = getPeriodType(source.period, source.periodLabel);
  const targetType = getPeriodType(target.period, target.periodLabel);
  if (sourceType !== targetType) {
    const typeNames = { morning: '早自习', day: '白课', evening: '晚自习' };
    return {
      swappable: false,
      reason: `${typeNames[sourceType]}只能与${typeNames[sourceType]}对调，目标为${typeNames[targetType]}`
    };
  }

  // 1. 源教师在目标时段是否有其他课（排除源课程自身）
  const sourceTeacherBusy = entries.some(e =>
    e.teacher === source.teacher &&
    e.weekday === target.weekday &&
    e.period === target.period &&
    (e.weekType || '通用') === weekType &&
    !(e.weekday === source.weekday && e.period === source.period && e.class === source.class)
  );
  if (sourceTeacherBusy) {
    return {
      swappable: false,
      reason: `教师「${source.teacher}」在${WEEKDAY_NAMES[target.weekday]}${target.periodLabel || '第' + target.period + '节'}已有其他课程`
    };
  }

  // 2. 目标教师在源时段是否有其他课（排除目标课程自身）
  const targetTeacherBusy = entries.some(e =>
    e.teacher === target.teacher &&
    e.weekday === source.weekday &&
    e.period === source.period &&
    (e.weekType || '通用') === weekType &&
    !(e.weekday === target.weekday && e.period === target.period && e.class === target.class)
  );
  if (targetTeacherBusy) {
    return {
      swappable: false,
      reason: `教师「${target.teacher}」在${WEEKDAY_NAMES[source.weekday]}${source.periodLabel || '第' + source.period + '节'}已有其他课程`
    };
  }

  // 3. 源教师在目标时段是否有必须参加的会议
  const sourceMeeting = checkTeacherMeeting(source.teacher, target.weekday, target.periodLabel, meetings, teacherMeetings);
  if (sourceMeeting) {
    return {
      swappable: false,
      reason: `教师「${source.teacher}」在${WEEKDAY_NAMES[target.weekday]}${target.periodLabel || '第' + target.period + '节'}有「${sourceMeeting}」，不可调课`
    };
  }

  // 4. 目标教师在源时段是否有必须参加的会议
  const targetMeeting = checkTeacherMeeting(target.teacher, source.weekday, source.periodLabel, meetings, teacherMeetings);
  if (targetMeeting) {
    return {
      swappable: false,
      reason: `教师「${target.teacher}」在${WEEKDAY_NAMES[source.weekday]}${source.periodLabel || '第' + source.period + '节'}有「${targetMeeting}」，不可调课`
    };
  }

  // 5. 高一/高二：对周教师冲突检查
  // 高一/高二调课时，对周也会发生同样的交换，需确保对周涉及的教师都没有冲突
  if (allEntries && weekType !== '通用') {
    const otherWeekType = weekType === '单周' ? '双周' : '单周';

    // 对周源位置的教师（调课后要移到对周目标位置）
    const srcInOtherWeek = allEntries.find(e =>
      e.class === source.class &&
      e.weekday === source.weekday &&
      e.period === source.period &&
      (e.weekType || '通用') === otherWeekType
    );
    if (srcInOtherWeek && srcInOtherWeek.teacher) {
      const srcOtherBusy = allEntries.some(e =>
        e.teacher === srcInOtherWeek.teacher &&
        e.weekday === target.weekday &&
        e.period === target.period &&
        (e.weekType || '通用') === otherWeekType &&
        !(e.weekday === source.weekday && e.period === source.period && e.class === source.class)
      );
      if (srcOtherBusy) {
        const paired = PAIRED_SUBJECTS[source.subject];
        const label = paired ? `（${source.subject}↔${paired}）` : '';
        return {
          swappable: false,
          reason: `教师「${srcInOtherWeek.teacher}」${label}在${WEEKDAY_NAMES[target.weekday]}${target.periodLabel || '第' + target.period + '节'}（${otherWeekType}）已有其他课程`
        };
      }
    }

    // 对周目标位置的教师（调课后要移到对周源位置）
    const tgtInOtherWeek = allEntries.find(e =>
      e.class === target.class &&
      e.weekday === target.weekday &&
      e.period === target.period &&
      (e.weekType || '通用') === otherWeekType
    );
    if (tgtInOtherWeek && tgtInOtherWeek.teacher) {
      const tgtOtherBusy = allEntries.some(e =>
        e.teacher === tgtInOtherWeek.teacher &&
        e.weekday === source.weekday &&
        e.period === source.period &&
        (e.weekType || '通用') === otherWeekType &&
        !(e.weekday === target.weekday && e.period === target.period && e.class === target.class)
      );
      if (tgtOtherBusy) {
        const paired = PAIRED_SUBJECTS[target.subject];
        const label = paired ? `（${target.subject}↔${paired}）` : '';
        return {
          swappable: false,
          reason: `教师「${tgtInOtherWeek.teacher}」${label}在${WEEKDAY_NAMES[source.weekday]}${source.periodLabel || '第' + source.period + '节'}（${otherWeekType}）已有其他课程`
        };
      }
    }
  }

  return { swappable: true, reason: null };
}

/**
 * 执行对调：交换两节课的 subject 和 teacher
 */
function executeSwap(entries, source, target, weekType, meetings, teacherMap) {
  const sIdx = entries.findIndex(e =>
    e.class === source.class &&
    e.weekday === source.weekday &&
    e.period === source.period &&
    (e.weekType || '通用') === weekType
  );
  const tIdx = entries.findIndex(e =>
    e.class === target.class &&
    e.weekday === target.weekday &&
    e.period === target.period &&
    (e.weekType || '通用') === weekType
  );
  if (sIdx < 0) throw new Error('源课程不存在');
  if (tIdx < 0) throw new Error('目标课程不存在');

  // 最终校验（传入全量 entries 用于关联科目对周教师冲突检查）
  const teacherMeetings = buildTeacherMeetings(teacherMap);
  const check = checkSwappable(entries, entries[sIdx], entries[tIdx], weekType, meetings, teacherMeetings, entries);
  if (!check.swappable) throw new Error('对调校验失败：' + check.reason);

  // 交换 subject 和 teacher（class/weekday/period 不变）
  const tmpSubject = entries[sIdx].subject;
  const tmpTeacher = entries[sIdx].teacher;
  entries[sIdx].subject = entries[tIdx].subject;
  entries[sIdx].teacher = entries[tIdx].teacher;
  entries[tIdx].subject = tmpSubject;
  entries[tIdx].teacher = tmpTeacher;

  return entries;
}

/**
 * 获取教师在指定周次的所有课表条目
 */
function getTeacherEntries(entries, teacherName, weekType) {
  return entries.filter(e =>
    e.teacher === teacherName &&
    (e.weekType || '通用') === weekType
  );
}

/**
 * 获取全局节次标签
 */
function getPeriodLabels(entries) {
  const periodLabels = {};
  for (const e of entries) {
    if (e.periodLabel && !(e.period in periodLabels)) {
      periodLabels[e.period] = e.periodLabel;
    }
  }
  return periodLabels;
}

module.exports = {
  computeSwapCandidates,
  checkSwappable,
  executeSwap,
  getTeacherEntries,
  getPeriodLabels,
  getPeriodType,
  buildTeacherMeetings,
  checkTeacherMeeting,
  WEEKDAY_NAMES
};
