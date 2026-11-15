/**
 * ============================================================================
 * agents/contract.js —— Agent 接口契约层（不含任何业务逻辑）
 * ----------------------------------------------------------------------------
 * 为什么单独抽出这一层：
 *   6 个 Agent 会分多次填充实现。如果各自定义入参出参，总控 Agent 的调度
 *   会随任意子 Agent 的改动而崩。这里把「用户档案」和「各 Agent 的返回结构」
 *   只定义一次，所有 Agent 都依赖这份契约。
 *
 * 加载顺序：必须最先加载，其余 Agent 与 main.js 都依赖 window.FitnessApp。
 * 全局命名空间：window.FitnessApp
 * ============================================================================
 *
 * 【数据结构契约】后续填充实现时请勿随意改字段名，只允许新增可选字段。
 *
 * @typedef {Object} UserProfile 所有 Agent 的统一输入基底
 * @property {'lose_fat'|'build_muscle'|'body_shape'|'endurance'|'health'} goal 训练目标
 * @property {'male'|'female'} gender 性别
 * @property {number} age 年龄（12~90）
 * @property {number} height 身高 cm（120~230）
 * @property {number} weight 体重 kg（30~250）
 * @property {number} daysPerWeek 每周可训练天数（1~7）
 * @property {string[]} equipment 可用器械 key，见 Equipment
 * @property {string[]} injuries 伤病 / 身体限制
 * @property {'beginner'|'intermediate'|'advanced'} experience 训练经验
 * @property {string} note 其他补充说明
 *
 * @typedef {Object} ExerciseItem
 * @property {string} name 动作名称
 * @property {number} sets 组数
 * @property {string} reps 次数或时长，如 "8-10"、"40 秒"
 * @property {number} restSec 组间休息（秒）
 * @property {string} target 目标肌群
 * @property {string} [note] 动作备注（伤病规避等）
 *
 * @typedef {Object} TrainingDay
 * @property {number} dayIndex 1=周一 … 7=周日
 * @property {boolean} isRest 是否休息日
 * @property {string} focus 当日主题
 * @property {ExerciseItem[]} exercises 动作列表（休息日为空数组）
 * @property {number} durationMin 预计时长（分钟）
 * @property {'low'|'medium'|'high'} intensity 强度
 *
 * @typedef {Object} TrainingPlan TrainingAgent 输出
 * @property {string} title 计划标题
 * @property {TrainingDay[]} weeklyPlan 固定 7 项，按周一到周日排列
 * @property {{durationMin:number, items:string[]}} warmup 热身方案
 * @property {{durationMin:number, items:string[]}} cooldown 拉伸放松方案
 * @property {string[]} notes 注意事项
 *
 * @typedef {Object} MealItem
 * @property {string} name 餐次名称
 * @property {string} time 建议时间
 * @property {number} calories 热量 kcal
 * @property {{food:string, amount:string}[]} foods 食物清单
 *
 * @typedef {Object} NutritionPlan DietAgent 输出
 * @property {number} targetCalories 目标热量 kcal
 * @property {{protein:number, carbs:number, fat:number}} macros 三大营养素（单位 g）
 * @property {MealItem[]} meals 食谱
 * @property {string[]} tips 饮食建议
 *
 * @typedef {Object} CoachingResult CoachAgent 输出
 * @property {string} planId 方案 ID
 * @property {UserProfile} profile 归一化后的用户档案
 * @property {TrainingPlan|null} trainingPlan 训练计划
 * @property {NutritionPlan|null} nutritionPlan 营养方案
 * @property {{agent:string, message:string}[]} errors 子 Agent 失败记录（降级信息）
 * @property {number} elapsedMs 调度总耗时（ms）
 *
 * @typedef {Object} PostureSession PostureAgent 输出（实时会话对象）
 * @property {string} id 会话 ID
 * @property {string} exercise 动作 key
 * @property {{camera:boolean, poseDetection:boolean, repCounting:boolean, voiceCoaching:boolean}} capabilities 能力开关
 * @property {(event:string, handler:Function) => Function} on 订阅事件，返回取消订阅函数
 * @property {() => Promise<{ok:boolean, reason?:string, message?:string}>} start 启动会话
 * @property {() => Promise<void>} stop 停止会话
 * @property {() => {reps:number, score:number, issues:string[]}} getStats 读取实时统计
 *
 * @typedef {Object} ReviewReport ReviewAgent 输出
 * @property {string} date 复盘日期 YYYY-MM-DD
 * @property {number} score 当日评分 0~100
 * @property {string[]} highlights 做得好
 * @property {string[]} issues 待改进
 * @property {string} advice 总结建议
 * @property {{intensity:'increase'|'keep'|'decrease', reason:string, volumeDelta:number}} nextDay 明日强度微调
 *
 * @typedef {Object} QaResult QaAgent 输出
 * @property {'training'|'diet'|'review'|'general'} intent 识别到的意图
 * @property {string} answer 答复文本
 * @property {string[]} regenerateTargets 需要重新生成的子 Agent
 * @property {Partial<CoachingResult>|null} updated 重新生成后的结果
 */
(function (global) {
  'use strict';

  const App = (global.FitnessApp = global.FitnessApp || {});

  /** 契约版本：Agent 接口发生不兼容变更时递增 */
  const CONTRACT_VERSION = '0.1.0';

  /** 训练目标枚举（表单 value 与此保持一致） */
  const GOALS = {
    LOSE_FAT: 'lose_fat',
    BUILD_MUSCLE: 'build_muscle',
    BODY_SHAPE: 'body_shape',
    ENDURANCE: 'endurance',
    HEALTH: 'health'
  };

  /** 目标中文名，供 UI 与 Agent 复用 */
  const GOAL_LABELS = {
    lose_fat: '减脂',
    build_muscle: '增肌',
    body_shape: '塑形',
    endurance: '提升体能',
    health: '保持健康'
  };

  const GENDERS = { MALE: 'male', FEMALE: 'female' };

  const EXPERIENCE = {
    BEGINNER: 'beginner',
    INTERMEDIATE: 'intermediate',
    ADVANCED: 'advanced'
  };

  const EXPERIENCE_LABELS = {
    beginner: '新手',
    intermediate: '有基础',
    advanced: '进阶'
  };

  /** 器械枚举 */
  const EQUIPMENT = {
    BODYWEIGHT: 'bodyweight',
    DUMBBELL: 'dumbbell',
    BARBELL: 'barbell',
    MACHINE: 'machine',
    BAND: 'band',
    KETTLEBELL: 'kettlebell'
  };

  const EQUIPMENT_LABELS = {
    bodyweight: '徒手',
    dumbbell: '哑铃',
    barbell: '杠铃',
    machine: '固定器械',
    band: '弹力带',
    kettlebell: '壶铃'
  };

  /** 数值安全夹取：非法值一律回落到 fallback */
  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  /** 字符串数组归一化：支持数组、中英文逗号/顿号/分号分隔的字符串 */
  function normalizeStringArray(value, fallback) {
    const raw = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(/[,，、;；\n]+/)
        : [];
    const cleaned = raw.map((item) => String(item).trim()).filter(Boolean);
    return cleaned.length ? Array.from(new Set(cleaned)) : fallback.slice();
  }

  /**
   * 归一化用户档案。
   * 所有 Agent 内部都必须先调用它，确保不会收到缺失字段或错误类型。
   *
   * @param {Partial<UserProfile>|null|undefined} input 原始输入
   * @returns {UserProfile}
   */
  function normalizeUserProfile(input) {
    const raw = input || {};
    const goal = Object.values(GOALS).includes(raw.goal) ? raw.goal : GOALS.HEALTH;
    const experience = Object.values(EXPERIENCE).includes(raw.experience)
      ? raw.experience
      : EXPERIENCE.BEGINNER;

    return {
      goal: goal,
      gender: raw.gender === GENDERS.FEMALE ? GENDERS.FEMALE : GENDERS.MALE,
      age: Math.round(clampNumber(raw.age, 12, 90, 28)),
      height: Math.round(clampNumber(raw.height, 120, 230, 170)),
      weight: Math.round(clampNumber(raw.weight, 30, 250, 65) * 10) / 10,
      daysPerWeek: Math.round(clampNumber(raw.daysPerWeek, 1, 7, 3)),
      equipment: normalizeStringArray(raw.equipment, [EQUIPMENT.BODYWEIGHT]),
      injuries: normalizeStringArray(raw.injuries, []),
      experience: experience,
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : ''
    };
  }

  /** 生成短 ID，用于方案 ID / 会话 ID */
  function newId(prefix) {
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${prefix || 'id'}_${Date.now().toString(36)}${suffix}`;
  }

  /**
   * 给占位结果打统一标记。
   * 前端据此显示「占位数据」徽标；替换真实实现后把 placeholder 置为 false。
   *
   * @param {string} agent Agent 名称
   * @param {Object} [extra] 附加字段
   */
  function createMeta(agent, extra) {
    return Object.assign(
      {
        agent: agent,
        placeholder: true,
        contractVersion: CONTRACT_VERSION,
        generatedAt: new Date().toISOString()
      },
      extra || {}
    );
  }

  /** 当前注册的 Agent 函数名，main.js 可据此做启动自检 */
  const AGENT_KEYS = [
    'coachAgent',
    'trainingAgent',
    'dietAgent',
    'postureAgent',
    'reviewAgent',
    'qaAgent'
  ];

  App.CONTRACT_VERSION = CONTRACT_VERSION;
  App.Goal = GOALS;
  App.GoalLabel = GOAL_LABELS;
  App.Gender = GENDERS;
  App.Experience = EXPERIENCE;
  App.ExperienceLabel = EXPERIENCE_LABELS;
  App.Equipment = EQUIPMENT;
  App.EquipmentLabel = EQUIPMENT_LABELS;
  App.AGENT_KEYS = AGENT_KEYS;

  App.normalizeUserProfile = normalizeUserProfile;
  App.normalizeStringArray = normalizeStringArray;
  App.clampNumber = clampNumber;
  App.createMeta = createMeta;
  App.newId = newId;
})(window);