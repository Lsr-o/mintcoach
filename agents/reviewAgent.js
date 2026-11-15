/**
 * ============================================================================
 * agents/reviewAgent.js —— 复盘分析 Agent（内置规则，不依赖外部 API）
 * ----------------------------------------------------------------------------
 * 职责：
 *   读取一段时间内的打卡记录与当前训练计划，统计出勤、汇总训练感受，
 *   生成一段文字复盘，并给出明日训练强度调整建议。
 *
 * 输入：
 *   @param {Array|Object} checkins 打卡记录列表（也兼容单条对象）
 *     每条记录支持中英文字段：
 *       { date | 日期, completed | 是否完成, feeling | 感受自评, rpe?, note? }
 *     feeling 取值：'easy' | 'ok' | 'tired' 或 '轻松' | '合适' | '太累'
 *     没有 feeling 时按 RPE 推断：≤5 轻松、6-8 合适、≥9 太累
 *   @param {TrainingPlan} [plan] 当前训练计划（读取 weeklyPlan 中的训练日数量）
 *
 * 输出：
 *   @returns {Object}
 *   {
 *     date, weekRange,
 *     completion: { completedDays, plannedDays, rate, totalRecords },
 *     feelings: { easy, ok, tired, unknown, total },
 *     consecutive: { feeling, label, days },
 *     score, report, advice, highlights, issues,
 *     nextDay: { intensity, setsDelta, repsDelta, volumeDelta, reason, note },
 *     meta, _meta
 *   }
 *
 * 明日强度规则：
 *   连续 ≥2 天「太累」→ 降低组数/次数（decrease）
 *   连续 ≥2 天「轻松」→ 增加组数/次数（increase）
 *   其余情况看整体占比，「合适」为主或数据不足 → 保持（keep）
 *
 * 对外函数：
 *   generateReview(checkins, plan) —— 纯规则核心实现（同步）
 *   reviewAgent(payload, options)  —— 既有注册入口，返回 Promise，契约不变
 * ============================================================================
 */
(function (global) {
  'use strict';

  const App = (global.FitnessApp = global.FitnessApp || {});

  /** 感受中文名 */
  const FEELING_LABELS = {
    easy: '轻松',
    ok: '合适',
    tired: '太累',
    unknown: '未填写'
  };

  /** 感受别名 → 内部 key */
  const FEELING_ALIAS = {
    easy: 'easy',
    light: 'easy',
    轻松: 'easy',
    ok: 'ok',
    moderate: 'ok',
    normal: 'ok',
    合适: 'ok',
    适中: 'ok',
    tired: 'tired',
    hard: 'tired',
    exhausted: 'tired',
    太累: 'tired',
    很累: 'tired',
    疲劳: 'tired'
  };

  /* ==========================================================================
   * 一、基础工具
   * ========================================================================== */

  function pad(num) {
    return String(num).padStart(2, '0');
  }

  function formatDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** 解析日期：支持 Date、时间戳、YYYY-MM-DD、YYYY/MM/DD 及普通日期字符串 */
  function parseDate(value) {
    if (!value) return null;

    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return null;
      return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }

    if (typeof value === 'number') {
      const fromNumber = new Date(value);
      if (Number.isNaN(fromNumber.getTime())) return null;
      return new Date(fromNumber.getFullYear(), fromNumber.getMonth(), fromNumber.getDate());
    }

    const text = String(value).trim();
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  /** 按顺序读取字段，兼容中英文写法；都没有时返回 null */
  function readField(raw, keys) {
    for (let i = 0; i < keys.length; i += 1) {
      const value = raw[keys[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  /* ==========================================================================
   * 二、打卡记录归一化
   * ========================================================================== */

  /** 是否完成：支持布尔、中文/英文文本、完成率 */
  function resolveCompleted(item) {
    const direct = readField(item, ['completed', '是否完成', '完成', 'done']);
    if (typeof direct === 'boolean') return direct;
    if (typeof direct === 'string') {
      if (/^(是|完成|true|yes|1)$/i.test(direct.trim())) return true;
      if (/^(否|未完成|false|no|0)$/i.test(direct.trim())) return false;
    }

    const rateRaw = readField(item, ['completionRate', '完成率']);
    if (rateRaw !== null) {
      const rate = Number(rateRaw);
      if (Number.isFinite(rate)) return rate >= 0.5;
    }

    return false;
  }

  /** 感受归一化：优先用自评，缺失时按 RPE 推断 */
  function resolveFeeling(value, rpe) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (text && FEELING_ALIAS[text]) return FEELING_ALIAS[text];
    if (text && FEELING_ALIAS[text.toLowerCase()]) return FEELING_ALIAS[text.toLowerCase()];
    if (rpe !== null) return rpe <= 5 ? 'easy' : rpe >= 9 ? 'tired' : 'ok';
    return 'unknown';
  }

  /** 把任意输入转成标准化记录数组 */
  function normalizeCheckins(input) {
    const list = Array.isArray(input)
      ? input
      : input && typeof input === 'object'
        ? [input]
        : [];

    return list
      .filter(function (item) {
        return item && typeof item === 'object';
      })
      .map(function (item, index) {
        const dateObj = parseDate(readField(item, ['date', '日期', '打卡日期']));

        const rpeRaw = readField(item, ['rpe', 'RPE', '强度']);
        let rpe = null;
        if (rpeRaw !== null) {
          const num = Number(rpeRaw);
          if (Number.isFinite(num)) rpe = App.clampNumber(num, 1, 10, 6);
        }

        // 今日体重（手动输入，选填）
        const weightRaw = readField(item, ['bodyWeight', '体重', '今日体重']);
        let bodyWeight = null;
        if (weightRaw !== null) {
          const weight = Number(weightRaw);
          if (Number.isFinite(weight) && weight > 0) {
            bodyWeight = Math.round(weight * 10) / 10;
          }
        }

        return {
          index: index,
          dateObj: dateObj,
          dateKey: dateObj ? formatDate(dateObj) : 'record-' + index,
          completed: resolveCompleted(item),
          feeling: resolveFeeling(readField(item, ['feeling', '感受', '感受自评', 'selfRating']), rpe),
          rpe: rpe,
          bodyWeight: bodyWeight,
          note: String(readField(item, ['note', '备注']) || '').trim()
        };
      });
  }

  /** 本周范围：最近 7 天（含今天），避免跨周记录干扰统计 */
  function buildWeekRange() {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
    return { start: start, end: end };
  }

  /* ==========================================================================
   * 三、统计与规则判断
   * ========================================================================== */

  /** 计划训练天数：优先生成计划里的训练日数量 */
  function resolvePlannedDays(plan) {
    if (plan && Array.isArray(plan.weeklyPlan) && plan.weeklyPlan.length) {
      return plan.weeklyPlan.filter(function (day) {
        return !day.isRest;
      }).length;
    }
    if (plan && Number.isFinite(Number(plan.daysPerWeek))) {
      return Number(plan.daysPerWeek);
    }
    return 0;
  }

  /** 最近连续相同的感受（按日期升序，从最后一天往前数） */
  function detectConsecutive(records) {
    const dated = records
      .filter(function (record) {
        return record.dateObj;
      })
      .sort(function (a, b) {
        return a.dateObj - b.dateObj;
      });

    if (!dated.length) return { feeling: null, days: 0 };

    const last = dated[dated.length - 1];
    if (!last.feeling || last.feeling === 'unknown') return { feeling: null, days: 0 };

    let days = 1;
    for (let i = dated.length - 2; i >= 0; i -= 1) {
      if (dated[i].feeling === last.feeling) days += 1;
      else break;
    }
    return { feeling: last.feeling, days: days };
  }

  /** 评分：完成度占 70 分，训练感受占 30 分 */
  function calcScore(rate, feelings, totalRecords) {
    if (!totalRecords) return 0;

    const completionScore = rate === null ? 40 : rate * 70;
    const feelingTotal = feelings.easy + feelings.ok + feelings.tired;
    let feelingScore = 21;

    if (feelingTotal > 0) {
      const average =
        (feelings.easy * 100 + feelings.ok * 85 + feelings.tired * 55) / feelingTotal;
      feelingScore = (average / 100) * 30;
    }

    return Math.round(Math.min(100, Math.max(0, completionScore + feelingScore)));
  }

  /** 明日强度建议 */
  function buildNextDay(consecutive, feelings, rate) {
    const feelingTotal = feelings.easy + feelings.ok + feelings.tired;

    // 连续太累：优先降低组数与次数
    if (consecutive.feeling === 'tired' && consecutive.days >= 2) {
      return {
        intensity: 'decrease',
        setsDelta: -1,
        repsDelta: -2,
        volumeDelta: -10,
        reason: `最近连续 ${consecutive.days} 天自评「太累」，恢复可能不足。`,
        note: '每个动作减少 1 组、次数减少 2 次，优先保证动作质量；如果仍然疲劳，改为主动恢复。'
      };
    }

    // 连续轻松：增加训练量
    if (consecutive.feeling === 'easy' && consecutive.days >= 2) {
      return {
        intensity: 'increase',
        setsDelta: 1,
        repsDelta: 2,
        volumeDelta: 5,
        reason: `最近连续 ${consecutive.days} 天自评「轻松」，身体适应良好。`,
        note: '每个动作增加 1 组，或次数增加 2 次；注意动作质量与关节感受。'
      };
    }

    // 没有连续信号时，用本周整体占比兜底
    if (feelingTotal >= 2 && feelings.tired / feelingTotal >= 0.6) {
      return {
        intensity: 'decrease',
        setsDelta: -1,
        repsDelta: -2,
        volumeDelta: -10,
        reason: `本周 ${feelings.tired}/${feelingTotal} 天自评「太累」，整体疲劳偏高。`,
        note: '每个动作减少 1 组、次数减少 2 次，先把恢复补回来。'
      };
    }

    if (
      feelingTotal >= 2 &&
      feelings.easy / feelingTotal >= 0.6 &&
      (rate === null || rate >= 0.8)
    ) {
      return {
        intensity: 'increase',
        setsDelta: 1,
        repsDelta: 2,
        volumeDelta: 5,
        reason: '本周多数训练感觉轻松，且出勤稳定，可以适度加量。',
        note: '每个动作增加 1 组，或次数增加 2 次，观察下一次训练感受。'
      };
    }

    return {
      intensity: 'keep',
      setsDelta: 0,
      repsDelta: 0,
      volumeDelta: 0,
      reason: '本周训练感受以「合适」为主，强度与恢复基本匹配。',
      note: '按当前计划继续执行，组数和次数保持不变。'
    };
  }

  /** 亮点 */
  function buildHighlights(rate, feelings, consecutive) {
    const highlights = [];

    if (rate !== null && rate >= 0.8) highlights.push('出勤稳定，本周完成度较高。');
    if (feelings.easy >= 2) highlights.push('多次训练感觉轻松，说明身体适应不错。');
    if (consecutive.feeling === 'ok' && consecutive.days >= 2) {
      highlights.push('近期感受稳定在「合适」，强度与恢复匹配。');
    }
    if (feelings.ok >= 2 && !highlights.length) {
      highlights.push('训练感受以「合适」为主，节奏把控得不错。');
    }
    if (!highlights.length) {
      highlights.push('完成了本周打卡记录，保持记录本身就是进步。');
    }

    return highlights;
  }

  /** 待改进 */
  function buildIssues(rate, feelings, consecutive) {
    const issues = [];

    if (rate !== null && rate < 0.6) issues.push('完成度偏低，检查训练安排是否过密。');
    if (consecutive.feeling === 'tired' && consecutive.days >= 2) {
      issues.push('连续自评「太累」，存在恢复不足风险。');
    }
    if (feelings.tired >= 2 && !(consecutive.feeling === 'tired' && consecutive.days >= 2)) {
      issues.push('本周多次感觉太累，建议降低训练量。');
    }
    if (!issues.length) issues.push('暂未发现明显问题，继续保持。');

    return issues;
  }

  /** 文字复盘：总结表现 + 鼓励 + 明日建议 */
  function buildReport(ctx) {
    const parts = [];

    if (ctx.plannedDays > 0) {
      parts.push(
        `本周计划训练 ${ctx.plannedDays} 天，实际完成 ${ctx.completedDays} 天，` +
          `完成度 ${Math.round((ctx.rate || 0) * 100)}%。`
      );
    } else if (ctx.completedDays > 0) {
      parts.push(
        `本周共记录 ${ctx.completedDays} 天训练；当前没有关联训练计划，完成度无法对比。`
      );
    } else {
      parts.push('本周暂无有效打卡记录，建议先从每周 2~3 次训练开始建立节奏。');
    }

    if (ctx.feelingTotal > 0) {
      parts.push(
        `训练感受方面：轻松 ${ctx.feelings.easy} 天、合适 ${ctx.feelings.ok} 天、` +
          `太累 ${ctx.feelings.tired} 天。`
      );
    }

    if (ctx.consecutive.days >= 2 && ctx.consecutive.feeling) {
      parts.push(
        `最近连续 ${ctx.consecutive.days} 天自评「${FEELING_LABELS[ctx.consecutive.feeling]}」。`
      );
    }

    if (ctx.rate !== null && ctx.rate >= 0.8) {
      parts.push('出勤稳定，训练习惯正在形成。');
    } else if (ctx.rate !== null && ctx.rate >= 0.5) {
      parts.push('完成度中等，保持规律比单次练狠更重要。');
    } else if (ctx.rate !== null) {
      parts.push('本周完成度偏低，先把目标定小一点，优先保证出勤。');
    }

    if (ctx.score >= 75) {
      parts.push('整体状态不错，继续按当前节奏推进。');
    } else if (ctx.score >= 60) {
      parts.push('有进步也有波动，坚持记录和规律训练就会看到变化。');
    } else {
      parts.push('别急着加量，稳定打卡和充足恢复是这周最重要的目标。');
    }

    parts.push(`明日建议：${ctx.nextDay.note}`);

    return parts.join('');
  }

  /* ==========================================================================
   * 四、对外函数
   * ========================================================================== */

  /**
   * 生成复盘报告（核心实现，纯规则、同步返回）。
   *
   * @param {Array|Object} checkins 打卡记录列表
   * @param {TrainingPlan} [plan] 当前训练计划
   * @returns {Object} 复盘报告
   */
  /** 里程碑：累计打卡达到这些次数时点亮徽章 */
  const MILESTONES = [
    { count: 7, title: '七日小火苗', emoji: '🔥' },
    { count: 21, title: '习惯养成者', emoji: '🌱' },
    { count: 50, title: '半百打卡王', emoji: '🏅' }
  ];

  /**
   * 本周统计：训练天数、总组数、最常见动作、高频易错动作、每日训练量。
   * 全部来自本地数据（打卡 + 训练会话 + 姿势纠正统计），纯规则、无外部依赖。
   */
  function buildWeekStats(records, options) {
    const sessions = Array.isArray(options.sessions) ? options.sessions : [];
    const correctionStats = options.correctionStats && typeof options.correctionStats === 'object'
      ? options.correctionStats
      : {};
    const weekRange = buildWeekRange();
    const startKey = formatDate(weekRange.start);
    const endKey = formatDate(weekRange.end);

    const weekSessions = sessions.filter(function (session) {
      return session && session.date && session.date >= startKey && session.date <= endKey;
    });

    const exerciseCounter = {};
    let totalSets = 0;

    weekSessions.forEach(function (session) {
      (session.exercises || []).forEach(function (item) {
        if (!item || item.skipped) return;

        const name = String(item.name || '').trim();
        if (!name) return;

        exerciseCounter[name] = (exerciseCounter[name] || 0) + 1;
        totalSets += Number(item.completedSets) || 0;
      });
    });

    const topExercise = Object.keys(exerciseCounter).sort(function (a, b) {
      return exerciseCounter[b] - exerciseCounter[a];
    })[0] || '';

    const topIssue = Object.keys(correctionStats).sort(function (a, b) {
      return correctionStats[b] - correctionStats[a];
    })[0] || '';

    // 本周七天每天的训练量（组数），用于柱状图
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    const dailyVolume = [];

    for (let i = 0; i < 7; i += 1) {
      const date = new Date(weekRange.start.getTime());
      date.setDate(date.getDate() + i);
      const key = formatDate(date);

      let volume = 0;
      weekSessions.forEach(function (session) {
        if (session.date !== key) return;
        (session.exercises || []).forEach(function (item) {
          if (item && !item.skipped) volume += Number(item.completedSets) || 0;
        });
      });

      // 没有会话明细但有完成打卡的日子，至少给 1 个单位，柱子不会全空
      const checked = records.some(function (record) {
        return record.completed && record.dateKey === key;
      });
      if (!volume && checked) volume = 1;

      dailyVolume.push({ label: labels[i], date: key, value: volume });
    }

    const maxVolume = dailyVolume.reduce(function (max, item) {
      return Math.max(max, item.value);
    }, 0);

    return {
      trainedDays: records.filter(function (record) { return record.completed; }).length,
      totalSessions: weekSessions.length,
      totalSets: totalSets,
      topExercise: topExercise,
      topIssue: topIssue,
      topIssueCount: topIssue ? correctionStats[topIssue] : 0,
      dailyVolume: dailyVolume,
      maxVolume: maxVolume
    };
  }

  /** 有温度的话术：按连续感受 / 全勤 / 评分给出鼓励 */
  function buildEncouragement(consecutive, completedDays, plannedDays, score) {
    if (consecutive.feeling === 'tired' && consecutive.days >= 2) {
      return '休息也是训练的一部分，身体变强需要留白 🌙';
    }
    if (consecutive.feeling === 'easy' && consecutive.days >= 2) {
      return '状态在上升期，明天可以加一点点强度 📈';
    }
    if (plannedDays > 0 && completedDays >= plannedDays) {
      return '自律是最高级的自由，本周全勤完成 ✨';
    }
    if (score >= 85) return '稳定输出的一周，保持这个节奏就很棒 🌟';
    if (score >= 70) return '有付出就有积累，下一步把恢复也安排好 🌿';
    return '别急，先把节奏找回来，慢慢来比较快 💪';
  }

  /** 里程碑成就：累计打卡 7 / 21 / 50 次 */
  function buildAchievements(totalCheckins) {
    const total = Math.max(0, Number(totalCheckins) || 0);

    return MILESTONES.map(function (item) {
      return {
        count: item.count,
        title: item.title,
        emoji: item.emoji,
        earned: total >= item.count,
        progress: Math.min(1, total / item.count)
      };
    });
  }

  function generateReview(checkins, plan, options) {
    const allRecords = normalizeCheckins(checkins);
    const weekRange = buildWeekRange();

    // 只统计最近 7 天；没有日期的记录无法判断周期，保留参与统计
    const records = allRecords.filter(function (record) {
      if (!record.dateObj) return true;
      return record.dateObj >= weekRange.start && record.dateObj <= weekRange.end;
    });

    const completedKeys = new Set();
    const feelings = { easy: 0, ok: 0, tired: 0, unknown: 0 };

    records.forEach(function (record) {
      if (record.completed) completedKeys.add(record.dateKey);
      feelings[record.feeling] += 1;
    });

    const completedDays = completedKeys.size;
    const plannedDays = resolvePlannedDays(plan);
    const rate = plannedDays > 0 ? Math.min(1, completedDays / plannedDays) : null;
    const feelingTotal = feelings.easy + feelings.ok + feelings.tired;

    // 最近一次带体重的记录，用于复盘展示
    const weightRecords = records
      .filter(function (record) {
        return typeof record.bodyWeight === 'number';
      })
      .sort(function (a, b) {
        return (a.dateObj ? a.dateObj.getTime() : 0) - (b.dateObj ? b.dateObj.getTime() : 0);
      });
    const latestWeight = weightRecords.length
      ? weightRecords[weightRecords.length - 1].bodyWeight
      : null;

    const consecutive = detectConsecutive(records);
    const nextDay = buildNextDay(consecutive, feelings, rate);
    const score = calcScore(rate, feelings, records.length);

    const optionsSafe = options || {};
    const stats = buildWeekStats(records, optionsSafe);
    const encouragement = buildEncouragement(consecutive, completedDays, plannedDays, score);
    const achievements = buildAchievements(optionsSafe.totalCheckins);

    const report = buildReport({
      plannedDays: plannedDays,
      completedDays: completedDays,
      rate: rate,
      feelings: feelings,
      feelingTotal: feelingTotal,
      consecutive: consecutive,
      nextDay: nextDay,
      score: score
    });

    return {
      date: formatDate(new Date()),
      weekRange: {
        start: formatDate(weekRange.start),
        end: formatDate(weekRange.end)
      },
      completion: {
        completedDays: completedDays,
        plannedDays: plannedDays,
        rate: rate,
        totalRecords: records.length
      },
      feelings: {
        easy: feelings.easy,
        ok: feelings.ok,
        tired: feelings.tired,
        unknown: feelings.unknown,
        total: feelingTotal
      },
      consecutive: {
        feeling: consecutive.feeling,
        label: consecutive.feeling ? FEELING_LABELS[consecutive.feeling] : '无',
        days: consecutive.days
      },
      score: score,
      report: report,
      // advice 与 report 内容一致，兼容旧页面字段
      advice: report,
      highlights: buildHighlights(rate, feelings, consecutive),
      issues: buildIssues(rate, feelings, consecutive),
      nextDay: nextDay,
      stats: stats,
      encouragement: encouragement,
      achievements: achievements,
      meta: {
        totalRecords: allRecords.length,
        usedRecords: records.length,
        plannedDays: plannedDays,
        completedDays: completedDays,
        usedPlan: Boolean(plan && Array.isArray(plan.weeklyPlan)),
        latestWeight: latestWeight,
        ruleBased: true
      },
      _meta: App.createMeta('reviewAgent', {
        placeholder: false,
        ruleBased: true
      })
    };
  }

  /**
   * 既有注册入口（契约不变）：
   *   支持 payload.checkins（记录列表）与旧版 payload.checkin（单条记录）。
   *
   * @param {Object} payload { checkins?, checkin?, plan? }
   * @param {Object} [options] 预留参数
   * @returns {Promise<Object>}
   */
  async function reviewAgent(payload = {}, options = {}) {
    const checkins = payload.checkins
      ? payload.checkins
      : payload.checkin
        ? [payload.checkin]
        : [];
    return generateReview(checkins, payload.plan || null, options);
  }

  /** 暴露核心实现，方便单测与直接调用 */
  reviewAgent.generateReview = generateReview;
  App.generateReview = generateReview;
  App.reviewAgent = reviewAgent;
})(window);