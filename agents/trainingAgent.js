/**
 * ============================================================================
 * agents/trainingAgent.js —— 训练计划 Agent（内置规则模板，不依赖外部 API）
 * ----------------------------------------------------------------------------
 * 职责：
 *   根据用户信息生成一周训练计划：按训练天数自动分化部位、给出动作/组数/次数、
 *   为每天生成对应的热身与拉伸，并按伤病自动替换或删除高风险动作。
 *
 * 输入（两种写法都支持，内部统一归一化）：
 *   @param {Object} userInfo 用户信息
 *   英文结构（项目内部使用）：
 *     { goal: 'build_muscle'|'lose_fat'|'body_shape', height, weight,
 *       daysPerWeek, equipment: string[], injuries: string[]|string }
 *   中文结构（直接调用也支持）：
 *     { 目标: '增肌'|'减脂'|'塑形', 身高, 体重, 每周训练天数,
 *       是否有健身房: boolean, 器械: string[]|string, 伤病情况: string[]|string }
 *
 * 输出：
 *   @returns {TrainingPlan}
 *   {
 *     title, summary, split,
 *     weeklyPlan: [{
 *       dayIndex: 1~7, isRest, focus, parts,
 *       warmup: { durationMin, items },        // 当天训练前的热身
 *       exercises: [{ name, target, sets, reps, restSec, durationMin, note }],
 *       cooldown: { durationMin, items },      // 当天训练后的拉伸
 *       durationMin, intensity, suggestion?
 *     }],
 *     warmup, cooldown,                        // 顶层通用版本，兼容旧页面
 *     notes: string[],
 *     meta: { goal, daysPerWeek, hasEquipment, injuries, bmi, ... },
 *     _meta
 *   }
 *
 * 对外函数：
 *   generatePlan(userInfo)  —— 纯规则核心实现（同步）
 *   trainingAgent(profile, options) —— 既有注册入口，返回 Promise<TrainingPlan>，契约不变
 *
 * 规则说明：
 *   1. 组数/次数：增肌 8-12 次/组，减脂 15-20 次/组，塑形 12-15 次/组
 *   2. 器械：有器械优先杠铃/哑铃/固定器械动作，无器械全部使用自重动作
 *   3. 伤病：命中关键词的动作优先找同部位替代，无替代则直接删除并记录到 notes
 * ============================================================================
 */
(function (global) {
  'use strict';

  const App = (global.FitnessApp = global.FitnessApp || {});

  /* ==========================================================================
   * 一、目标与规则参数
   * ========================================================================== */

  /** 目标中文别名 → 内部 key */
  const GOAL_ALIAS = {
    增肌: 'build_muscle',
    build_muscle: 'build_muscle',
    muscle: 'build_muscle',
    减脂: 'lose_fat',
    lose_fat: 'lose_fat',
    fat_loss: 'lose_fat',
    塑形: 'body_shape',
    body_shape: 'body_shape',
    shape: 'body_shape',
    提升体能: 'endurance',
    endurance: 'endurance',
    保持健康: 'health',
    health: 'health'
  };

  /**
   * 每个目标的处方规则：
   *   reps      —— 常规动作次数区间（用户要求：增肌 8-12，减脂 15-20）
   *   staticReps—— 静力动作（平板支撑等）的保持时间
   *   setsBig   —— 大肌群组数；setsSmall —— 小肌群/核心组数
   *   restBig   —— 大肌群组间休息（秒）；restSmall —— 小肌群组间休息
   */
  const GOAL_SCHEMES = {
    build_muscle: {
      label: '增肌',
      reps: '8-12',
      staticReps: '30-45 秒',
      setsBig: 4,
      setsSmall: 3,
      restBig: 90,
      restSmall: 60
    },
    lose_fat: {
      label: '减脂',
      reps: '15-20',
      staticReps: '45-60 秒',
      setsBig: 4,
      setsSmall: 3,
      restBig: 45,
      restSmall: 30
    },
    body_shape: {
      label: '塑形',
      reps: '12-15',
      staticReps: '40-60 秒',
      setsBig: 3,
      setsSmall: 3,
      restBig: 60,
      restSmall: 45
    },
    endurance: {
      label: '提升体能',
      reps: '15-20',
      staticReps: '45-60 秒',
      setsBig: 3,
      setsSmall: 3,
      restBig: 45,
      restSmall: 30
    },
    health: {
      label: '保持健康',
      reps: '12-15',
      staticReps: '30-45 秒',
      setsBig: 3,
      setsSmall: 2,
      restBig: 60,
      restSmall: 45
    }
  };

  /** 伤病关键词 → 内部 key，用于匹配动作库的 avoid 列表 */
  const INJURY_DEFINITIONS = [
    { key: 'knee', label: '膝部', regex: /膝|半月板|髌/ },
    { key: 'lower_back', label: '腰背', regex: /腰|下背|椎间盘|腰椎/ },
    { key: 'shoulder', label: '肩部', regex: /肩|肩袖|肩峰/ },
    { key: 'wrist', label: '手腕', regex: /腕|手腕/ },
    { key: 'elbow', label: '肘部', regex: /肘|网球肘|高尔夫球肘/ },
    { key: 'ankle', label: '踝部', regex: /踝|脚踝/ },
    { key: 'neck', label: '颈部', regex: /颈|颈椎/ }
  ];

  const INJURY_LABELS = INJURY_DEFINITIONS.reduce(function (map, item) {
    map[item.key] = item.label;
    return map;
  }, {});

  /* ==========================================================================
   * 二、训练分化模板
   * --------------------------------------------------------------------------
   * parts 是部位 key，生成时会映射到动作库对应分区。
   * 1 天：全身；2 天：上肢 / 下肢；3 天：推 / 拉 / 腿；
   * 4 天：胸+三头 / 背+二头 / 腿 / 肩+核心；
   * 5 天：胸 / 背 / 腿 / 肩 / 手臂；6 天：推拉腿 ×2；
   * 7 天：6 天分化 + 有氧核心。
   * ========================================================================== */

  const SPLIT_TEMPLATES = {
    1: [{ focus: '全身循环', parts: ['chest', 'back', 'legs', 'core'] }],
    2: [
      { focus: '上肢 · 推 + 拉', parts: ['chest', 'back', 'shoulders', 'arms'] },
      { focus: '下肢 + 核心', parts: ['legs', 'core'] }
    ],
    3: [
      { focus: '推 · 胸 / 肩 / 三头', parts: ['chest', 'shoulders', 'triceps'] },
      { focus: '拉 · 背 / 二头', parts: ['back', 'biceps'] },
      { focus: '腿 · 下肢 + 核心', parts: ['legs', 'core'] }
    ],
    4: [
      { focus: '胸 + 三头', parts: ['chest', 'triceps'] },
      { focus: '背 + 二头', parts: ['back', 'biceps'] },
      { focus: '腿 + 臀', parts: ['legs'] },
      { focus: '肩 + 核心', parts: ['shoulders', 'core'] }
    ],
    5: [
      { focus: '胸', parts: ['chest'] },
      { focus: '背', parts: ['back'] },
      { focus: '腿', parts: ['legs'] },
      { focus: '肩', parts: ['shoulders'] },
      { focus: '手臂', parts: ['arms'] }
    ],
    6: [
      { focus: '推 · 胸 / 肩 / 三头', parts: ['chest', 'shoulders', 'triceps'] },
      { focus: '拉 · 背 / 二头', parts: ['back', 'biceps'] },
      { focus: '腿 + 核心', parts: ['legs', 'core'] },
      { focus: '胸 + 肩', parts: ['chest', 'shoulders'] },
      { focus: '背 + 手臂', parts: ['back', 'arms'] },
      { focus: '腿 + 核心', parts: ['legs', 'core'] }
    ],
    7: [
      { focus: '推 · 胸 / 肩 / 三头', parts: ['chest', 'shoulders', 'triceps'] },
      { focus: '拉 · 背 / 二头', parts: ['back', 'biceps'] },
      { focus: '腿 + 核心', parts: ['legs', 'core'] },
      { focus: '胸 + 肩', parts: ['chest', 'shoulders'] },
      { focus: '背 + 手臂', parts: ['back', 'arms'] },
      { focus: '腿 + 核心', parts: ['legs', 'core'] },
      { focus: '有氧 + 核心', parts: ['cardio', 'core'] }
    ]
  };

  const PART_LABELS = {
    chest: '胸',
    back: '背',
    legs: '腿',
    shoulders: '肩',
    arms: '手臂',
    biceps: '二头',
    triceps: '三头',
    core: '核心',
    cardio: '有氧'
  };

  /** 单部位训练日的动作数量 */
  const QUOTA_SINGLE = {
    chest: 4,
    back: 4,
    legs: 4,
    shoulders: 3,
    arms: 3,
    biceps: 2,
    triceps: 2,
    core: 3,
    cardio: 2
  };

  /** 多部位训练日的每个部位动作数量（总量超过预算会按顺序削减） */
  const QUOTA_MULTI = {
    chest: 3,
    back: 3,
    legs: 3,
    shoulders: 2,
    arms: 2,
    biceps: 2,
    triceps: 2,
    core: 2,
    cardio: 1
  };

  /** 单日动作总数上限，避免计划过长 */
  const DAY_EXERCISE_BUDGET = 7;

  /* ==========================================================================
   * 三、动作库
   * --------------------------------------------------------------------------
   * 每个动作字段：
   *   name   —— 中文动作名
   *   target —— 目标肌群
   *   level  —— 'big' 大肌群 / 'small' 小肌群（决定组数与休息）
   *   avoid  —— 命中这些伤病 key 时视为高风险动作
   *   group  —— 手臂分区使用：'biceps' | 'triceps'
   *   isStatic —— 静力动作，次数替换为保持时间
   *   type   —— 'cardio' 有氧动作，按分钟计时
   *   durationMin —— 有氧动作的默认时长
   *
   * gym        = 需要杠铃 / 哑铃 / 固定器械
   * bodyweight = 徒手或水瓶即可完成
   * ========================================================================== */

  const EXERCISE_LIBRARY = {
    /* ---------------------------- 胸 ---------------------------- */
    chest: {
      label: '胸',
      gym: [
        { name: '杠铃卧推', target: '胸大肌', level: 'big', avoid: ['shoulder', 'wrist'] },
        { name: '哑铃卧推', target: '胸大肌', level: 'big', avoid: ['shoulder'] },
        { name: '上斜哑铃卧推', target: '上胸', level: 'big', avoid: ['shoulder'] },
        { name: '器械推胸', target: '胸大肌', level: 'big', avoid: ['shoulder'] },
        { name: '蝴蝶机夹胸', target: '胸大肌内侧', level: 'big', avoid: ['shoulder'] },
        { name: '绳索夹胸', target: '胸大肌', level: 'big', avoid: ['shoulder'] }
      ],
      bodyweight: [
        { name: '标准俯卧撑', target: '胸大肌', level: 'big', avoid: ['shoulder', 'wrist'] },
        { name: '跪姿俯卧撑', target: '胸大肌', level: 'big', avoid: ['wrist'] },
        { name: '上斜俯卧撑（手撑高）', target: '下胸', level: 'big', avoid: [] },
        { name: '宽距俯卧撑', target: '胸大肌外侧', level: 'big', avoid: ['shoulder', 'wrist'] },
        { name: '钻石俯卧撑', target: '胸肌内侧 / 三头', level: 'small', avoid: ['elbow', 'wrist'] }
      ]
    },

    /* ---------------------------- 背 ---------------------------- */
    back: {
      label: '背',
      gym: [
        { name: '高位下拉', target: '背阔肌', level: 'big', avoid: ['shoulder'] },
        { name: '坐姿绳索划船', target: '中背', level: 'big', avoid: ['lower_back'] },
        { name: '杠铃划船', target: '中背', level: 'big', avoid: ['lower_back', 'wrist'] },
        { name: '哑铃单臂划船', target: '背阔肌', level: 'big', avoid: ['lower_back'] },
        { name: '直臂下压', target: '背阔肌', level: 'small', avoid: ['shoulder'] }
      ],
      bodyweight: [
        { name: '引体向上', target: '背阔肌', level: 'big', avoid: ['shoulder', 'elbow'] },
        { name: '反向划船（低杠）', target: '中背', level: 'big', avoid: ['lower_back'] },
        { name: '毛巾划船', target: '中背', level: 'big', avoid: [] },
        { name: '俯身 YTW', target: '上背 / 后束', level: 'small', avoid: ['lower_back'] },
        { name: '超人式', target: '竖脊肌', level: 'small', avoid: ['lower_back'] }
      ]
    },

    /* ---------------------------- 腿 ---------------------------- */
    legs: {
      label: '腿',
      gym: [
        { name: '杠铃深蹲', target: '股四头肌 / 臀', level: 'big', avoid: ['knee', 'lower_back'] },
        { name: '高脚杯深蹲', target: '股四头肌 / 臀', level: 'big', avoid: ['knee'] },
        { name: '腿举', target: '股四头肌', level: 'big', avoid: ['knee', 'lower_back'] },
        { name: '罗马尼亚硬拉', target: '腘绳肌 / 臀', level: 'big', avoid: ['lower_back'] },
        { name: '保加利亚分腿蹲', target: '股四头肌 / 臀', level: 'big', avoid: ['knee', 'ankle'] },
        { name: '杠铃臀桥', target: '臀大肌', level: 'big', avoid: ['lower_back'] },
        { name: '腿弯举', target: '腘绳肌', level: 'small', avoid: [] },
        { name: '站姿提踵', target: '小腿', level: 'small', avoid: ['ankle'] }
      ],
      bodyweight: [
        { name: '自重深蹲', target: '股四头肌 / 臀', level: 'big', avoid: ['knee'] },
        { name: '箭步蹲', target: '股四头肌 / 臀', level: 'big', avoid: ['knee', 'ankle'] },
        { name: '臀桥', target: '臀大肌', level: 'big', avoid: [] },
        { name: '单腿臀桥', target: '臀大肌', level: 'big', avoid: ['lower_back'] },
        { name: '靠墙静蹲', target: '股四头肌', level: 'small', isStatic: true, avoid: ['knee'] },
        { name: '滑行腿弯举', target: '腘绳肌', level: 'small', avoid: [] },
        { name: '侧卧抬腿', target: '臀中肌', level: 'small', avoid: [] },
        { name: '蚌式开合', target: '臀中肌', level: 'small', avoid: [] },
        { name: '驴踢', target: '臀大肌', level: 'small', avoid: [] },
        { name: '站姿提踵', target: '小腿', level: 'small', avoid: ['ankle'] }
      ]
    },

    /* ---------------------------- 肩 ---------------------------- */
    shoulders: {
      label: '肩',
      gym: [
        { name: '坐姿哑铃推举', target: '三角肌前束', level: 'big', avoid: ['shoulder', 'wrist'] },
        { name: '杠铃站姿推举', target: '三角肌前 / 中束', level: 'big', avoid: ['lower_back', 'shoulder'] },
        { name: '哑铃侧平举', target: '三角肌中束', level: 'small', avoid: ['shoulder'] },
        { name: '哑铃前平举', target: '三角肌前束', level: 'small', avoid: ['shoulder'] },
        { name: '俯身哑铃反向飞鸟', target: '三角肌后束', level: 'small', avoid: ['lower_back', 'shoulder'] },
        { name: '绳索面拉', target: '三角肌后束 / 上背', level: 'small', avoid: ['shoulder'] }
      ],
      bodyweight: [
        { name: '派克俯卧撑', target: '三角肌前束', level: 'big', avoid: ['shoulder', 'wrist'] },
        { name: '靠墙倒立撑（高位）', target: '三角肌', level: 'big', avoid: ['shoulder', 'wrist'] },
        { name: '水瓶侧平举', target: '三角肌中束', level: 'small', avoid: ['shoulder'] },
        { name: '俯身反向飞鸟（水瓶）', target: '三角肌后束', level: 'small', avoid: ['lower_back'] },
        { name: '弹力带肩外旋', target: '肩袖 / 后束', level: 'small', avoid: [] },
        { name: '墙面天使', target: '肩关节活动度', level: 'small', avoid: [] }
      ]
    },

    /* ---------------------------- 手臂 ---------------------------- */
    arms: {
      label: '手臂',
      gym: [
        {
          name: '杠铃弯举',
          target: '肱二头肌',
          level: 'small',
          group: 'biceps',
          avoid: ['elbow', 'wrist']
        },
        {
          name: '哑铃交替弯举',
          target: '肱二头肌',
          level: 'small',
          group: 'biceps',
          avoid: ['elbow']
        },
        {
          name: '锤式弯举',
          target: '肱二头肌 / 肱桡肌',
          level: 'small',
          group: 'biceps',
          avoid: ['elbow']
        },
        {
          name: '绳索下压',
          target: '肱三头肌',
          level: 'small',
          group: 'triceps',
          avoid: ['elbow']
        },
        {
          name: '窄距卧推',
          target: '肱三头肌',
          level: 'small',
          group: 'triceps',
          avoid: ['shoulder', 'wrist']
        },
        {
          name: '哑铃颈后臂屈伸',
          target: '肱三头肌',
          level: 'small',
          group: 'triceps',
          avoid: ['elbow', 'shoulder']
        }
      ],
      bodyweight: [
        {
          name: '毛巾弯举',
          target: '肱二头肌',
          level: 'small',
          group: 'biceps',
          avoid: ['elbow']
        },
        {
          name: '反手反向划船',
          target: '肱二头肌',
          level: 'small',
          group: 'biceps',
          avoid: ['lower_back', 'elbow']
        },
        {
          name: '水瓶弯举',
          target: '肱二头肌',
          level: 'small',
          group: 'biceps',
          avoid: ['elbow']
        },
        {
          name: '钻石俯卧撑',
          target: '肱三头肌',
          level: 'small',
          group: 'triceps',
          avoid: ['shoulder', 'wrist']
        },
        {
          name: '凳上反屈伸',
          target: '肱三头肌',
          level: 'small',
          group: 'triceps',
          avoid: ['elbow', 'shoulder', 'wrist']
        },
        {
          name: '窄距俯卧撑',
          target: '肱三头肌',
          level: 'small',
          group: 'triceps',
          avoid: ['wrist']
        }
      ]
    },

    /* ---------------------------- 核心 ---------------------------- */
    core: {
      label: '核心',
      gym: [
        { name: '绳索卷腹', target: '腹直肌', level: 'small', avoid: ['lower_back'] },
        { name: '悬垂举腿', target: '下腹', level: 'small', avoid: ['shoulder', 'lower_back'] }
      ],
      bodyweight: [
        { name: '平板支撑', target: '核心稳定', level: 'small', isStatic: true, avoid: ['shoulder', 'wrist'] },
        { name: '死虫式', target: '深层核心', level: 'small', avoid: [] },
        { name: '侧平板支撑', target: '侧链核心', level: 'small', isStatic: true, avoid: ['shoulder', 'wrist'] },
        { name: '卷腹', target: '腹直肌', level: 'small', avoid: ['neck', 'lower_back'] },
        { name: '仰卧举腿', target: '下腹', level: 'small', avoid: ['lower_back'] },
        { name: '鸟狗式', target: '核心稳定', level: 'small', avoid: [] },
        { name: '臀桥', target: '臀 / 核心', level: 'small', avoid: [] },
        { name: '站姿提膝', target: '下腹', level: 'small', avoid: ['knee'] },
        { name: '俄罗斯转体', target: '腹斜肌', level: 'small', avoid: ['lower_back'] }
      ]
    },

    /* ---------------------------- 有氧 ---------------------------- */
    cardio: {
      label: '有氧',
      gym: [
        { name: '椭圆机', target: '心肺', level: 'small', type: 'cardio', durationMin: 25, avoid: [] },
        { name: '划船机', target: '心肺 / 全身', level: 'small', type: 'cardio', durationMin: 20, avoid: ['lower_back'] },
        { name: '动感单车', target: '心肺 / 下肢', level: 'small', type: 'cardio', durationMin: 25, avoid: ['knee'] }
      ],
      bodyweight: [
        { name: '快走', target: '心肺', level: 'small', type: 'cardio', durationMin: 30, avoid: [] },
        { name: '慢跑', target: '心肺', level: 'small', type: 'cardio', durationMin: 25, avoid: ['knee', 'ankle'] },
        { name: '开合跳', target: '心肺', level: 'small', type: 'cardio', durationMin: 15, avoid: ['knee', 'ankle', 'wrist'] },
        { name: '原地高抬腿', target: '心肺', level: 'small', type: 'cardio', durationMin: 15, avoid: ['knee', 'ankle'] },
        { name: '爬楼梯', target: '心肺 / 下肢', level: 'small', type: 'cardio', durationMin: 20, avoid: ['knee'] }
      ]
    }
  };

  /** biceps / triceps 复用 arms 动作库，并按 group 过滤 */
  const PART_POOL_META = {
    biceps: { libraryPart: 'arms', group: 'biceps' },
    triceps: { libraryPart: 'arms', group: 'triceps' }
  };

  /* ==========================================================================
   * 四、热身 / 拉伸库
   * --------------------------------------------------------------------------
   * text  —— 展示文案
   * avoid —— 命中伤病的条目会被跳过（例如膝伤不做徒手深蹲热身）
   * ========================================================================== */

  const WARMUP_LIBRARY = {
    chest: [
      { text: '肩关节环绕 前后各 10 次', avoid: ['shoulder'] },
      { text: '毛巾 / 弹力带肩外旋 15 次', avoid: ['shoulder'] },
      { text: '跪姿俯卧撑 10 个（激活动作）', avoid: ['wrist'] },
      { text: '胸大肌动态拉伸 每侧 10 次', avoid: [] }
    ],
    back: [
      { text: '肩胛骨激活 15 次', avoid: [] },
      { text: '猫牛式 10 次', avoid: ['lower_back'] },
      { text: '轻重量高位下拉 1 组', avoid: ['shoulder'] }
    ],
    legs: [
      { text: '髋关节环绕 每侧 10 次', avoid: [] },
      { text: '徒手深蹲 15 次', avoid: ['knee'] },
      { text: '臀桥 15 次（激活臀部）', avoid: [] },
      { text: '踝关节环绕 每侧 10 次', avoid: ['ankle'] }
    ],
    shoulders: [
      { text: '肩关节环绕 前后各 10 次', avoid: ['shoulder'] },
      { text: '弹力带肩外旋 15 次', avoid: ['shoulder'] },
      { text: '轻重量侧平举 1 组', avoid: ['shoulder'] }
    ],
    arms: [
      { text: '肘关节屈伸 15 次', avoid: ['elbow'] },
      { text: '手腕环绕 每侧 10 次', avoid: ['wrist'] },
      { text: '轻重量弯举 1 组', avoid: ['elbow'] }
    ],
    biceps: [
      { text: '肘关节屈伸 15 次', avoid: ['elbow'] },
      { text: '轻重量弯举 1 组', avoid: ['elbow'] }
    ],
    triceps: [
      { text: '肘关节屈伸 15 次', avoid: ['elbow'] },
      { text: '轻重量下压 1 组', avoid: ['elbow'] }
    ],
    core: [
      { text: '猫牛式 10 次', avoid: ['lower_back'] },
      { text: '死虫式 8 次', avoid: [] },
      { text: '臀桥 15 次', avoid: [] }
    ],
    cardio: [
      { text: '踝关节环绕 每侧 10 次', avoid: ['ankle'] },
      { text: '原地小步走 2 分钟', avoid: [] },
      { text: '动态弓步拉伸 每侧 5 次', avoid: ['knee'] }
    ]
  };

  const COOLDOWN_LIBRARY = {
    chest: [
      { text: '门框胸大肌拉伸 每侧 30 秒 × 2', avoid: [] },
      { text: '肱三头肌拉伸 每侧 30 秒', avoid: [] }
    ],
    back: [
      { text: '背阔肌拉伸 每侧 30 秒 × 2', avoid: [] },
      { text: '婴儿式 30 秒', avoid: [] }
    ],
    legs: [
      { text: '股四头肌拉伸 每侧 30 秒 × 2', avoid: [] },
      { text: '腘绳肌拉伸 每侧 30 秒 × 2', avoid: [] },
      { text: '臀肌拉伸 每侧 30 秒', avoid: [] }
    ],
    shoulders: [
      { text: '肩后束拉伸 每侧 30 秒', avoid: [] },
      { text: '胸小肌拉伸 每侧 30 秒', avoid: [] }
    ],
    arms: [
      { text: '肱二头肌拉伸 每侧 30 秒', avoid: [] },
      { text: '肱三头肌拉伸 每侧 30 秒', avoid: [] }
    ],
    biceps: [{ text: '肱二头肌拉伸 每侧 30 秒', avoid: [] }],
    triceps: [{ text: '肱三头肌拉伸 每侧 30 秒', avoid: [] }],
    core: [
      { text: '眼镜蛇式 30 秒', avoid: ['lower_back'] },
      { text: '婴儿式 30 秒', avoid: [] }
    ],
    cardio: [
      { text: '慢走 2 分钟', avoid: [] },
      { text: '小腿拉伸 每侧 30 秒', avoid: [] },
      { text: '大腿前侧拉伸 每侧 30 秒', avoid: [] }
    ]
  };

  const GENERAL_WARMUP_ITEMS = ['低强度有氧 3 分钟（快走 / 原地踏步）', '关节活动：肩、髋、膝、踝各 10 次'];

  const GENERAL_COOLDOWN_ITEMS = ['慢走 2~3 分钟，逐步降低心率', '深呼吸放松 1 分钟'];

  /* ==========================================================================
   * 五、输入解析与归一化
   * ========================================================================== */

  /** 按顺序读取字段，兼容中英文两种写法 */
  function readField(raw, keys, fallback) {
    for (let i = 0; i < keys.length; i += 1) {
      const value = raw[keys[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
  }

  /** 目标归一化：支持 "增肌" / "build_muscle" 等写法 */
  function resolveGoal(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (GOAL_ALIAS[text]) return GOAL_ALIAS[text];
    const lower = text.toLowerCase();
    if (GOAL_ALIAS[lower]) return GOAL_ALIAS[lower];
    return 'health';
  }

  /**
   * 器械判断：
   *   布尔字段 hasEquipment / hasGym / 是否有健身房 优先；
   *   否则看 equipment 数组是否包含杠铃、哑铃、器械等 key；
   *   字符串写"无器械"视为没有器械。
   */
  function resolveEquipment(raw) {
    const flags = [raw.hasEquipment, raw.hasGym, raw['是否有健身房'], raw['有器械']];
    for (let i = 0; i < flags.length; i += 1) {
      if (typeof flags[i] === 'boolean') return flags[i];
    }

    const equipment = readField(raw, ['equipment', '器械'], null);
    const gymKeys = ['barbell', 'dumbbell', 'machine', 'band', 'kettlebell', 'gym'];
    if (Array.isArray(equipment)) {
      return equipment.some(function (key) {
        return gymKeys.indexOf(String(key)) >= 0;
      });
    }
    if (typeof equipment === 'string') {
      const text = equipment.trim();
      if (/^(无|没有|否|无器械|徒手)$/.test(text)) return false;
      return /杠铃|哑铃|器械|健身房|壶铃|弹力带/.test(text);
    }
    return false;
  }

  /** 伤病文本 → 伤病 key 数组（去重） */
  function detectInjuryKeys(injuries) {
    const keys = [];
    injuries.forEach(function (text) {
      INJURY_DEFINITIONS.forEach(function (definition) {
        if (definition.regex.test(String(text)) && keys.indexOf(definition.key) < 0) {
          keys.push(definition.key);
        }
      });
    });
    return keys;
  }

  /** 组装生成上下文：所有生成函数只依赖这个对象 */
  function buildContext(userInfo) {
    const raw = userInfo || {};
    const fallbackProfile = App.normalizeUserProfile(raw);

    const goalKey = resolveGoal(readField(raw, ['goal', 'target', '目标'], fallbackProfile.goal));
    const scheme = GOAL_SCHEMES[goalKey] || GOAL_SCHEMES.health;

    const daysPerWeek = Math.round(
      App.clampNumber(
        readField(raw, ['daysPerWeek', 'trainingDays', '每周训练天数'], fallbackProfile.daysPerWeek),
        1,
        7,
        3
      )
    );

    const height = App.clampNumber(
      readField(raw, ['height', '身高'], fallbackProfile.height),
      120,
      230,
      170
    );
    const weight = App.clampNumber(
      readField(raw, ['weight', '体重'], fallbackProfile.weight),
      30,
      250,
      65
    );
    const bmi = Math.round((weight / Math.pow(height / 100, 2)) * 10) / 10;

    const injuries = App.normalizeStringArray(
      readField(raw, ['injuries', 'injury', '伤病情况', '伤病'], fallbackProfile.injuries),
      []
    );

    return {
      goalKey: goalKey,
      goalLabel: scheme.label,
      scheme: scheme,
      daysPerWeek: daysPerWeek,
      height: height,
      weight: weight,
      bmi: bmi,
      injuries: injuries,
      injuryKeys: detectInjuryKeys(injuries),
      hasEquipment: resolveEquipment(raw),
      /** 因伤病被删除的动作，用于写入 notes */
      removed: []
    };
  }

  /* ==========================================================================
   * 六、动作筛选与处方
   * ========================================================================== */

  /**
   * 按部位 + 器械条件构建候选动作池。
   * 有器械：杠铃/哑铃/固定器械优先，自重动作作为补充；
   * 无器械：只取自重动作；
   * 核心与有氧以自重为主。
   */
  function buildPool(part, hasEquipment) {
    const meta = PART_POOL_META[part];
    const libraryPart = meta ? meta.libraryPart : part;
    const group = meta ? meta.group : null;
    const library = EXERCISE_LIBRARY[libraryPart];
    if (!library) return [];

    let pool;
    if (libraryPart === 'core' || libraryPart === 'cardio') {
      pool = library.bodyweight.concat(hasEquipment ? library.gym : []);
    } else if (hasEquipment) {
      pool = library.gym.concat(library.bodyweight);
    } else {
      pool = library.bodyweight.slice();
    }

    if (!group) return pool;
    return pool.filter(function (item) {
      return item.group === group;
    });
  }

  /** 判断动作是否命中用户伤病 */
  function isBlocked(exercise, injuryKeys) {
    return exercise.avoid.some(function (key) {
      return injuryKeys.indexOf(key) >= 0;
    });
  }

  /**
   * 从部位动作池中挑选指定数量动作：
   *   命中伤病 → 优先在池中找同部位替代动作，找不到则删除。
   *
   * @param {string} part 部位 key
   * @param {number} count 需要的动作数
   * @param {Object} ctx 生成上下文
   * @param {Set<string>} dayUsed 当日已用动作名（跨部位去重）
   * @returns {{exercise:Object, note:string}[]}
   */
  function selectExercises(part, count, ctx, dayUsed) {
    const pool = buildPool(part, ctx.hasEquipment);
    const selected = [];
    let index = 0;

    while (selected.length < count && index < pool.length) {
      const candidate = pool[index];
      index += 1;

      if (dayUsed.has(candidate.name)) continue;

      const conflict = candidate.avoid.find(function (key) {
        return ctx.injuryKeys.indexOf(key) >= 0;
      });

      if (!conflict) {
        selected.push({ exercise: candidate, note: '' });
        dayUsed.add(candidate.name);
        continue;
      }

      // 伤病冲突：在后续候选里找同部位、无冲突、未使用的动作作为替代
      let substitute = null;
      for (let i = index; i < pool.length; i += 1) {
        const option = pool[i];
        if (dayUsed.has(option.name)) continue;
        if (isBlocked(option, ctx.injuryKeys)) continue;
        substitute = option;
        break;
      }

      if (substitute) {
        dayUsed.add(substitute.name);
        selected.push({
          exercise: substitute,
          note: `因${INJURY_LABELS[conflict] || conflict}，替换原动作「${candidate.name}」`
        });
      } else if (!ctx.removed.some(function (item) { return item.name === candidate.name; })) {
        ctx.removed.push({
          part: PART_LABELS[part] || part,
          name: candidate.name,
          injury: INJURY_LABELS[conflict] || conflict
        });
      }
    }

    return selected;
  }

  /** 按目标规则生成组数 / 次数 / 休息时间 */
  function buildPrescription(exercise, scheme) {
    if (exercise.type === 'cardio') {
      return {
        sets: 1,
        reps: `${exercise.durationMin || 20} 分钟`,
        restSec: 0,
        durationMin: exercise.durationMin || 20
      };
    }

    const isBig = exercise.level === 'big';
    return {
      sets: isBig ? scheme.setsBig : scheme.setsSmall,
      reps: exercise.isStatic ? scheme.staticReps : scheme.reps,
      restSec: isBig ? scheme.restBig : scheme.restSmall,
      durationMin: 0
    };
  }

  /* ==========================================================================
   * 七、训练日 / 周计划生成
   * ========================================================================== */

  /** 计算一周中哪几天训练，让休息日尽量均匀分布 */
  function buildTrainingIndexes(daysPerWeek) {
    const indexes = new Set();
    if (daysPerWeek >= 7) {
      for (let i = 0; i < 7; i += 1) indexes.add(i);
      return indexes;
    }
    if (daysPerWeek === 1) {
      indexes.add(2);
      return indexes;
    }
    for (let i = 0; i < daysPerWeek; i += 1) {
      indexes.add(Math.round((i * 6) / (daysPerWeek - 1)));
    }
    return indexes;
  }

  /**
   * 计算每个部位的动作配额。
   * 单部位日给足专项动作；多部位日控制总量在预算内。
   */
  function planQuotas(parts) {
    const entries = parts.map(function (part) {
      const quota = parts.length === 1 ? QUOTA_SINGLE[part] : QUOTA_MULTI[part];
      return { part: part, quota: quota || 2 };
    });

    let total = entries.reduce(function (sum, item) {
      return sum + item.quota;
    }, 0);

    while (total > DAY_EXERCISE_BUDGET) {
      let target = null;
      entries.forEach(function (entry) {
        if (entry.quota <= 1) return;
        if (!target || entry.quota > target.quota) target = entry;
      });
      if (!target) break;
      target.quota -= 1;
      total -= 1;
    }

    return entries;
  }

  /** 生成当天热身：通用激活 + 当天部位专项 */
  function buildWarmupForParts(parts, ctx) {
    const items = GENERAL_WARMUP_ITEMS.slice();

    parts.forEach(function (part) {
      (WARMUP_LIBRARY[part] || []).forEach(function (entry) {
        if (items.length >= 5) return;
        if (entry.avoid.some(function (key) { return ctx.injuryKeys.indexOf(key) >= 0; })) return;
        if (items.indexOf(entry.text) < 0) items.push(entry.text);
      });
    });

    return { durationMin: 6, items: items };
  }

  /** 生成当天拉伸：当天部位静态拉伸 + 通用放松 */
  function buildCooldownForParts(parts, ctx) {
    const items = [];

    parts.forEach(function (part) {
      (COOLDOWN_LIBRARY[part] || []).forEach(function (entry) {
        if (items.length >= 4) return;
        if (entry.avoid.some(function (key) { return ctx.injuryKeys.indexOf(key) >= 0; })) return;
        if (items.indexOf(entry.text) < 0) items.push(entry.text);
      });
    });

    GENERAL_COOLDOWN_ITEMS.forEach(function (text) {
      if (items.length < 5 && items.indexOf(text) < 0) items.push(text);
    });

    return { durationMin: 5, items: items };
  }

  /** 估算单次训练总时长（热身 + 训练 + 拉伸） */
  function estimateDuration(warmup, exercises, cooldown) {
    const workMin = exercises.reduce(function (sum, item) {
      if (item.durationMin) return sum + item.durationMin;
      const sets = Number(item.sets) || 0;
      const restMin = (Number(item.restSec) || 0) / 60;
      return sum + sets * (restMin + 0.7);
    }, 0);

    return Math.max(20, Math.round(warmup.durationMin + workMin + cooldown.durationMin));
  }

  /** 强度判断：腿部日与减脂目标偏高，核心/有氧日偏低 */
  function resolveIntensity(template, ctx) {
    if (template.parts.indexOf('cardio') >= 0) return 'low';
    if (template.parts.indexOf('legs') >= 0) return 'high';
    if (ctx.goalKey === 'lose_fat') return 'high';
    if (template.parts.every(function (part) { return part === 'core'; })) return 'low';
    return 'medium';
  }

  /** 休息日结构 */
  function buildRestDay(dayIndex) {
    return {
      dayIndex: dayIndex,
      isRest: true,
      focus: '休息 / 主动恢复',
      parts: [],
      warmup: { durationMin: 0, items: [] },
      exercises: [],
      cooldown: { durationMin: 0, items: [] },
      durationMin: 0,
      intensity: 'low',
      suggestion: '散步 20~30 分钟或做轻度拉伸，保证 7 小时以上睡眠。'
    };
  }

  /** 训练日结构：热身 + 动作 + 拉伸 + 时长 + 强度 */
  function buildTrainingDay(dayIndex, template, ctx) {
    const dayUsed = new Set();
    const exercises = [];

    planQuotas(template.parts).forEach(function (entry) {
      const picked = selectExercises(entry.part, entry.quota, ctx, dayUsed);
      picked.forEach(function (item) {
        const prescription = buildPrescription(item.exercise, ctx.scheme);
        exercises.push({
          name: item.exercise.name,
          target: item.exercise.target,
          sets: prescription.sets,
          reps: prescription.reps,
          restSec: prescription.restSec,
          durationMin: prescription.durationMin,
          note: item.note || ''
        });
      });
    });

    // 伤病导致动作过少时，用核心动作补足到 4 个，避免训练日内容过空
    if (exercises.length < 4) {
      const fillers = selectExercises('core', 4 - exercises.length, ctx, dayUsed);
      fillers.forEach(function (item) {
        const prescription = buildPrescription(item.exercise, ctx.scheme);
        exercises.push({
          name: item.exercise.name,
          target: item.exercise.target,
          sets: prescription.sets,
          reps: prescription.reps,
          restSec: prescription.restSec,
          durationMin: prescription.durationMin,
          note: item.note || ''
        });
      });
    }

    const warmup = buildWarmupForParts(template.parts, ctx);
    const cooldown = buildCooldownForParts(template.parts, ctx);

    return {
      dayIndex: dayIndex,
      isRest: false,
      focus: template.focus,
      parts: template.parts,
      warmup: warmup,
      exercises: exercises,
      cooldown: cooldown,
      durationMin: estimateDuration(warmup, exercises, cooldown),
      intensity: resolveIntensity(template, ctx)
    };
  }

  /** 生成 7 天周计划：训练日按模板顺序分配，其余为休息日 */
  function buildWeeklyPlan(ctx) {
    const templates = SPLIT_TEMPLATES[ctx.daysPerWeek] || SPLIT_TEMPLATES[3];
    const trainIndexes = Array.from(buildTrainingIndexes(ctx.daysPerWeek)).sort(function (a, b) {
      return a - b;
    });

    return Array.from({ length: 7 }, function (_, index) {
      const position = trainIndexes.indexOf(index);
      if (position < 0) return buildRestDay(index + 1);
      return buildTrainingDay(index + 1, templates[position % templates.length], ctx);
    });
  }

  /* ==========================================================================
   * 八、说明文案
   * ========================================================================== */

  function buildNotes(ctx) {
    const notes = [];

    notes.push(
      `${ctx.goalLabel}目标的动作次数按 ${ctx.scheme.reps} 次 / 组安排：大肌群 ${ctx.scheme.setsBig} 组，小肌群与核心 ${ctx.scheme.setsSmall} 组。`
    );

    notes.push(
      ctx.hasEquipment
        ? '已检测到器械条件：优先安排杠铃、哑铃与固定器械动作，自重动作作为补充。'
        : '未检测到器械条件：全部安排自重动作，可用水瓶增加轻负重。'
    );

    ctx.injuryKeys.forEach(function (key) {
      notes.push(
        `已识别${INJURY_LABELS[key] || key}限制：相关高风险动作已自动替换为同部位低冲击动作，无替代动作的已删除。`
      );
    });

    const removedNames = Array.from(
      new Set(ctx.removed.map(function (item) { return item.name; }))
    );
    if (removedNames.length) {
      notes.push('因伤病移除的动作：' + removedNames.join('、') + '。');
    }

    if (ctx.bmi >= 28) {
      notes.push(
        `当前 BMI 约 ${ctx.bmi}，建议优先选择快走、椭圆机等低冲击有氧，减少跳跃类动作，保护膝踝关节。`
      );
    } else if (ctx.bmi > 0 && ctx.bmi < 18.5) {
      notes.push(`当前 BMI 约 ${ctx.bmi}，建议以增肌为主，保证热量盈余与蛋白质摄入。`);
    }

    notes.push('训练中出现关节刺痛、头晕或明显不适时请立即停止，并咨询专业教练或医生。');
    notes.push('本计划由内置规则模板生成，不构成医疗处方。');

    return notes;
  }

  /* ==========================================================================
   * 九、对外函数
   * ========================================================================== */

  /**
   * 生成训练计划（核心实现，纯规则、同步返回）。
   *
   * @param {Object} userInfo 用户信息（支持中英文两种字段名）
   * @returns {TrainingPlan}
   */
  function generatePlan(userInfo) {
    const ctx = buildContext(userInfo);
    const weeklyPlan = buildWeeklyPlan(ctx);

    const trainDays = weeklyPlan.filter(function (day) {
      return !day.isRest;
    });

    const split = trainDays
      .map(function (day) {
        return day.focus;
      })
      .join('；');

    return {
      title: `${ctx.goalLabel} · 每周 ${ctx.daysPerWeek} 天分化训练计划`,
      summary:
        `${ctx.goalLabel}目标，每周训练 ${ctx.daysPerWeek} 天，` +
        `${ctx.hasEquipment ? '按器械条件安排杠铃/哑铃动作' : '全部使用自重动作'}，` +
        `分化方式：${split}。`,
      split: split,
      weeklyPlan: weeklyPlan,
      warmup: {
        durationMin: 8,
        items: GENERAL_WARMUP_ITEMS.concat(['目标肌群动态拉伸 2 分钟', '首个动作轻重量热身 1 组'])
      },
      cooldown: {
        durationMin: 6,
        items: GENERAL_COOLDOWN_ITEMS.concat(['目标肌群静态拉伸，每侧 30 秒', '泡沫轴放松 3 分钟'])
      },
      notes: buildNotes(ctx),
      meta: {
        goal: ctx.goalKey,
        goalLabel: ctx.goalLabel,
        daysPerWeek: ctx.daysPerWeek,
        hasEquipment: ctx.hasEquipment,
        height: ctx.height,
        weight: ctx.weight,
        bmi: ctx.bmi,
        injuries: ctx.injuries,
        injuryKeys: ctx.injuryKeys,
        source: 'builtin_rule_template'
      },
      _meta: App.createMeta('trainingAgent', {
        placeholder: false,
        ruleBased: true
      })
    };
  }

  /**
   * 既有注册入口（契约不变）：coachAgent 与 qaAgent 都调用它。
   *
   * @param {Object} profile 用户档案
   * @param {Object} [options] 预留参数，当前不影响规则生成
   * @returns {Promise<TrainingPlan>}
   */
  async function trainingAgent(profile, options = {}) {
    return generatePlan(profile);
  }

  /** 子接口：单独生成通用热身方案 */
  trainingAgent.generateWarmup = async function generateWarmup(profile) {
    const ctx = buildContext(profile);
    const parts = ['chest', 'back', 'legs', 'shoulders', 'core'];
    return buildWarmupForParts(parts, ctx);
  };

  /** 子接口：单独生成通用拉伸方案 */
  trainingAgent.generateCooldown = async function generateCooldown(profile) {
    const ctx = buildContext(profile);
    const parts = ['chest', 'back', 'legs', 'shoulders', 'core'];
    return buildCooldownForParts(parts, ctx);
  };

  /** 暴露核心实现，方便单测与直接调用 */
  trainingAgent.generatePlan = generatePlan;
  App.generatePlan = generatePlan;
  App.trainingAgent = trainingAgent;
})(window);