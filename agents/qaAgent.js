/**
 * ============================================================================
 * agents/qaAgent.js —— 答疑调整 Agent（内置关键词规则，不依赖外部 API）
 * ----------------------------------------------------------------------------
 * 职责：
 *   理解用户用自然语言提出的调整需求，判断意图（改训练 / 改饮食 / 询问），
 *   在需要时触发对应 Agent 重新生成，并返回一段解释「做了什么调整」的文字。
 *
 * 输入：
 *   @param {string} text      用户输入的文字
 *   @param {Object} userInfo  用户信息（支持中英文字段）
 *   @param {TrainingPlan} [plan] 当前训练计划
 *   @param {NutritionPlan} [diet] 当前饮食建议
 *
 * 输出：
 *   @returns {Promise<Object>}
 *   {
 *     intent: 'training'|'diet'|'question',
 *     intentLabel: '改训练计划'|'改饮食建议'|'询问',
 *     regenerateTargets: string[],   // 需要重新生成的 Agent：training / diet
 *     adjustments: Object,           // 从文字中解析出的调整参数
 *     reply, answer,                 // 给用户的文字回复（两个字段内容一致，兼容旧页面）
 *     updated: { profile, trainingPlan, nutritionPlan } | null,
 *     updatedPlan, updatedDiet,
 *     error, _meta
 *   }
 *
 * 可识别示例：
 *   "我膝盖不好，把深蹲换掉"       → 改训练计划（伤病）
 *   "只有哑铃，在家练"             → 改训练计划（器械）
 *   "没时间，改成一周练2天"        → 改训练计划（天数）
 *   "减脂餐太单调了，换点花样"     → 改饮食建议（食谱多样化）
 *   "增肌期能吃火锅吗"             → 询问（不重生成）
 *
 * 对外函数：
 *   answerQuery(text, userInfo, plan, diet) —— 核心实现（异步，可能触发子 Agent）
 *   qaAgent(payload, options)               —— 既有注册入口，契约不变
 * ============================================================================
 */
(function (global) {
  'use strict';

  const App = (global.FitnessApp = global.FitnessApp || {});

  /* ==========================================================================
   * 一、关键词规则
   * ========================================================================== */

  /** 调整动作词：出现这些词才视为「要改方案」，否则按「询问」处理 */
  const ADJUST_VERBS =
    /(换|改|调整|替换|删掉|删除|去掉|避开|增加|减少|降低|提高|不要|不想|只有|没有|没时间|太忙|太累|太难|太简单|太单调|单调|腻|吃腻|换成|改成|高一点|低一点|太高|太低|偏高|偏低)/;

  /** 疑问词 */
  const QUESTION_WORDS = /(吗|呢|能不能|可不可以|可以吗|是否|怎么|为什么|多久|什么时候|多少|哪个|哪些|\?|？)/;

  /** 社交类意图规则 */
  const GREETING_RULES = /^(你好|您好|hi|hello|嗨|哈喽|在吗|教练好|早上好|中午好|下午好|晚上好)[!！。~～\s]*$/i;
  const PRAISE_RULES = /(练得不错|厉害|真棒|牛|坚持下来|有进步|谢谢|感谢|辛苦了|做得好|太强了)/;
  const COMPLAIN_RULES = /(好累|太累|累死|不想练|没动力|坚持不下去|好难|太难了|酸痛|难受|疲惫|想放弃|摆烂)/;

  /** 社交类回复（多套随机，语气温暖、有教练感） */
  const SOCIAL_REPLIES = {
    greeting: [
      '你好呀 👋 今天想练点什么？可以说「只有哑铃，在家练」或「膝盖不舒服，换掉深蹲」，我来帮你调。',
      '嗨，我在呢 😊 今天状态怎么样？想调计划、问饮食，或者只是想聊聊训练，都可以。',
      '教练在线 🏋️ 需要我帮你安排今天的训练吗？告诉我时间、器械和身体情况就行。'
    ],
    praise: [
      '听到这句话我比你还开心 😄 坚持本身就是很强的天赋，继续保持！',
      '你最近真的很稳，训练记录不会骗人 👏 记得把恢复也安排好，进步会更扎实。',
      '厉害！这种正反馈就是坚持下去的动力 💪 明天继续把动作质量放在第一位。'
    ],
    complain: [
      '累是身体在提醒你需要恢复 🌙 今天可以只做轻量活动，睡够、吃够蛋白质，明天再战。',
      '这种时候先别硬撑，降低训练量也是训练的一部分 🫂 休息好了，状态会回来的。',
      '抱抱，疲惫时还能来问一句，就已经比放弃强很多了 💗 今天早点休息吧。'
    ]
  };

  /** 随机挑一句回复 */
  function pickReply(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  /** 训练类主题关键词 */
  const TRAINING_TOPICS = {
    injury: /(膝|膝盖|半月板|髌|腰|腰椎|下背|肩|肩袖|腕|手腕|肘|踝|脚踝|颈|颈椎|受伤|旧伤|疼|痛|不舒服)/,
    equipment: /(只有|没有器械|没器械|无器械|在家|徒手|哑铃|杠铃|壶铃|弹力带|健身房|器械)/,
    days: /(没时间|太忙|时间少|一周|每周|几天|改成.{0,4}天|练.{0,3}天|减少.{0,3}天|增加.{0,3}天|减到)/,
    action: /(深蹲|硬拉|卧推|推举|弓步|腿举|划船|俯卧撑|动作|计划|训练)/
  };

  /** 饮食类主题关键词 */
  const DIET_TOPICS = {
    variety: /(单调|花样|换点|换换|腻|吃腻|口味|不喜欢|吃不下|重复)/,
    calories: /(热量|卡路里|蛋白|碳水|脂肪|少吃|多吃)/,
    meal: /(食谱|饮食|三餐|早餐|午餐|晚餐|加餐|外卖|做饭|餐|吃)/
  };

  /** 伤病文本 → 标准描述 */
  const INJURY_PATTERNS = [
    { label: '膝部', regex: /膝|半月板|髌/ },
    { label: '腰背', regex: /腰|腰椎|下背|椎间盘/ },
    { label: '肩部', regex: /肩|肩袖/ },
    { label: '手腕', regex: /腕|手腕/ },
    { label: '肘部', regex: /肘/ },
    { label: '踝部', regex: /踝|脚踝/ },
    { label: '颈部', regex: /颈|颈椎/ }
  ];

  const EQUIPMENT_LABELS = {
    barbell: '杠铃',
    dumbbell: '哑铃',
    machine: '固定器械',
    band: '弹力带',
    kettlebell: '壶铃',
    bodyweight: '徒手'
  };

  const GOAL_LABELS = {
    build_muscle: '增肌',
    lose_fat: '减脂',
    body_shape: '塑形',
    endurance: '提升体能',
    health: '保持健康'
  };

  const CN_NUMBERS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };

  /* ==========================================================================
   * 二、意图识别
   * ========================================================================== */

  /** 统计文本命中的主题数量 */
  function scoreTopics(text, topics) {
    let score = 0;
    const reasons = [];
    Object.keys(topics).forEach(function (key) {
      if (topics[key].test(text)) {
        score += 1;
        reasons.push(key);
      }
    });
    return { score: score, reasons: reasons };
  }

  /**
   * 识别意图：
   *   1. 有调整动作词 + 训练主题 → 改训练计划
   *   2. 有调整动作词 + 饮食主题（且强于训练）→ 改饮食建议
   *   3. 其余（含纯疑问句）→ 询问
   */
  function detectIntent(text) {
    if (!text) {
      return { intent: 'question', label: '询问', topic: 'general', reasons: [] };
    }

    const training = scoreTopics(text, TRAINING_TOPICS);
    const diet = scoreTopics(text, DIET_TOPICS);
    const hasAdjust = ADJUST_VERBS.test(text);

    if (hasAdjust && training.score > 0 && training.score >= diet.score) {
      return {
        intent: 'training',
        label: '改训练计划',
        topic: 'training',
        reasons: training.reasons
      };
    }

    if (hasAdjust && diet.score > 0 && diet.score > training.score) {
      return { intent: 'diet', label: '改饮食建议', topic: 'diet', reasons: diet.reasons };
    }

    const topic = diet.score > training.score
      ? 'diet'
      : training.score > 0
        ? 'training'
        : 'general';

    // 社交意图：没有明确调整动作时，优先给温暖回应
    if (GREETING_RULES.test(text)) {
      return { intent: 'greeting', label: '问候', topic: 'general', reasons: [] };
    }

    if (PRAISE_RULES.test(text)) {
      return { intent: 'praise', label: '夸奖', topic: 'general', reasons: [] };
    }

    if (COMPLAIN_RULES.test(text)) {
      return { intent: 'complain', label: '倾诉', topic: 'general', reasons: [] };
    }

    // 询问知识：带疑问词且命中训练 / 饮食主题
    if (QUESTION_WORDS.test(text) && (training.score > 0 || diet.score > 0)) {
      return { intent: 'knowledge', label: '健康知识', topic: topic, reasons: [] };
    }

    return {
      intent: 'question',
      label: '询问',
      topic: topic,
      reasons: [],
      hasQuestion: QUESTION_WORDS.test(text)
    };
  }

  /* ==========================================================================
   * 三、从自然语言中解析调整参数
   * ========================================================================== */

  /** 伤病：提取标准描述 */
  function detectInjuries(text) {
    return INJURY_PATTERNS.filter(function (item) {
      return item.regex.test(text);
    }).map(function (item) {
      return item.label;
    });
  }

  /**
   * 器械：返回器械 key 数组。
   *   "只有哑铃" → ['dumbbell']
   *   "在家练 / 徒手" → ['bodyweight']
   *   "健身房 / 器械齐全" → 全套
   */
  function detectEquipment(text) {
    if (/(健身房|器械齐全|有器械|去健身房)/.test(text)) {
      return ['barbell', 'dumbbell', 'machine', 'bodyweight'];
    }

    const bodyweightOnly = /(徒手|自重|无器械|没有器械|没器械|在家|家里练|居家)/.test(text);
    const keys = [];

    if (/哑铃/.test(text)) keys.push('dumbbell');
    if (/杠铃/.test(text)) keys.push('barbell');
    if (/壶铃/.test(text)) keys.push('kettlebell');
    if (/弹力带/.test(text)) keys.push('band');
    if (/(固定器械|龙门架|器械)/.test(text) && !bodyweightOnly) keys.push('machine');
    if (bodyweightOnly) keys.push('bodyweight');

    if (!keys.length) return null;
    return Array.from(new Set(keys));
  }

  /**
   * 训练天数：
   *   明确数字优先（"一周练2天" / "改成3天" / "练两天"）；
   *   其次按"少练/减少""多练/增加"在当前天数上加减。
   */
  function detectDays(text, current) {
    const explicit = text.match(
      /(?:改成|改为|变成|减到|降到|增加到|提高到|练|每周|一周)\s*([1-7])\s*天/
    );
    if (explicit) return Number(explicit[1]);

    if (/(少练|减少|降一点|降一|减一)/.test(text) && /天|次/.test(text)) {
      return Math.max(1, Math.round(current) - 1);
    }
    if (/(多练|增加|加一点|加一)/.test(text) && /天|次/.test(text)) {
      return Math.min(7, Math.round(current) + 1);
    }

    const chinese = text.match(/(?:改成|改为|变成|每周|一周)\s*([一二两三四五六七])\s*天/);
    if (chinese && CN_NUMBERS[chinese[1]]) return CN_NUMBERS[chinese[1]];

    const plain = text.match(/([1-7一二两三四五六七])\s*天/);
    if (plain) {
      const value = CN_NUMBERS[plain[1]] || Number(plain[1]);
      if (value >= 1 && value <= 7) return value;
    }

    return null;
  }

  /** 目标：只在明确的"改成 / 想 / 目标"语境下调整，避免误判 */
  function detectGoal(text) {
    if (/(改成|改为|目标|想|转成|转为|变成)/.test(text)) {
      if (/增肌/.test(text)) return 'build_muscle';
      if (/减脂/.test(text)) return 'lose_fat';
      if (/塑形/.test(text)) return 'body_shape';
    }
    return null;
  }

  /** 解析训练调整参数 */
  function parseTrainingAdjustments(text, user) {
    const changes = {};
    const labels = [];

    const injuries = detectInjuries(text);
    if (injuries.length) {
      changes.injuries = Array.from(new Set((user.injuries || []).concat(injuries)));
      labels.push('伤病限制：' + injuries.join('、'));
    }

    const equipment = detectEquipment(text);
    if (equipment) {
      changes.equipment = equipment;
      labels.push(
        '器械条件：' +
          equipment.map(function (key) {
            return EQUIPMENT_LABELS[key] || key;
          }).join(' / ')
      );
    }

    const days = detectDays(text, user.daysPerWeek);
    if (days !== null) {
      changes.daysPerWeek = days;
      labels.push('训练天数调整为 ' + days + ' 天');
    }

    const goal = detectGoal(text);
    if (goal) {
      changes.goal = goal;
      labels.push('目标：' + (GOAL_LABELS[goal] || goal));
    }

    return { changes: changes, labels: labels };
  }

  /** 解析饮食调整参数 */
  function parseDietAdjustments(text) {
    const changes = {};
    const labels = [];

    if (/(单调|花样|换点|换换|腻|吃腻|口味|不喜欢|吃不下|重复|换个)/.test(text)) {
      changes.dietVariety = true;
      labels.push('更换食谱花样');
    }

    if (/(热量|卡路里).{0,6}(高|多|大)|少吃|减量|低一点|降一点/.test(text)) {
      changes.calorieAdjust = -100;
      labels.push('每日热量下调 100 kcal');
    } else if (/(热量|卡路里).{0,6}(低|少)|多吃|加量|高一点/.test(text)) {
      changes.calorieAdjust = 100;
      labels.push('每日热量上调 100 kcal');
    }

    return { changes: changes, labels: labels };
  }

  /* ==========================================================================
   * 四、回复文案
   * ========================================================================== */

  /** 训练调整的原因说明：让用户知道为什么这么改 */
  function buildTrainingReason(changes) {
    const safe = changes || {};

    if (Array.isArray(safe.injuries) && safe.injuries.length) {
      return '已把相关高风险动作换成低冲击替代，同样练到目标肌群，但对膝盖/腰背的压力小得多 🛡️';
    }
    if (Array.isArray(safe.equipment) && safe.equipment.length) {
      return '按你现有的器械重排了动作，保证在家也能完整执行 🏠';
    }
    if (safe.daysPerWeek) {
      return '把训练量重新分配到 ' + safe.daysPerWeek + ' 天，让每个肌群都有恢复时间 📅';
    }
    if (safe.goal) {
      return '按新目标重算了组数与次数，强度更匹配你现在的阶段 🎯';
    }
    return '按你的反馈重新平衡了训练量，尽量贴着你现在的节奏走 💡';
  }

  /** 饮食调整的原因说明 */
  function buildDietReason(changes) {
    const safe = changes || {};

    if (safe.dietVariety) {
      return '在热量不变的前提下换了食材组合，更容易长期坚持 🍽️';
    }
    if (safe.calorieAdjust) {
      return '热量按你的反馈做了微调，减脂更稳、增肌更从容 ⚖️';
    }
    return '把方案调整得更贴合你现在的作息和口味 💡';
  }

  /** 训练计划调整后的回复（多套话术随机） */
  function buildTrainingReply(parsed, updatedPlan, error) {
    if (error) {
      return (
        '调整训练计划时出错：' + error + '。已保留原计划，请稍后再试。'
      );
    }

    if (!parsed.labels.length) {
      return (
        '我理解你想调整训练计划，但没能从这句话里识别出具体条件。' +
        '可以这样说：“我膝盖不好，换成低冲击动作”“只有哑铃，在家练”“一周改成 3 天”。'
      );
    }

    const trainDays = updatedPlan
      ? updatedPlan.weeklyPlan.filter(function (day) {
          return !day.isRest;
        }).length
      : 0;
    const reason = buildTrainingReason(parsed.changes);
    const labels = parsed.labels.join('；');

    return pickReply([
      '已经帮你调好啦：' + labels + '。' + reason +
        (updatedPlan ? '新计划每周训练 ' + trainDays + ' 天。' : '') +
        '饮食热量也同步重算了，刷新首页就能看到 🌿',
      '按你的情况重新排了一版：' + labels + '。' + reason +
        (updatedPlan ? '现在每周练 ' + trainDays + ' 天。' : '') +
        '先按新计划走一周，不合适再告诉我，我们再调 💪',
      '调整完成 ✅ ' + labels + '。' + reason +
        '动作质量和恢复优先，别急着加量，我们慢慢来 🧘'
    ]);
  }

  /** 饮食调整后的回复（多套话术随机） */
  function buildDietReply(parsed, updatedDiet, error) {
    if (error) {
      return '调整饮食建议时出错：' + error + '。已保留原方案，请稍后再试。';
    }

    if (!parsed.labels.length) {
      return (
        '我理解你想调整饮食，但没识别出具体方向。' +
        '可以这样说：“食谱太单调，换点花样”“热量想再低一点”。'
      );
    }

    const labels = parsed.labels.join('；');
    const reason = buildDietReason(parsed.changes);
    const kcal = updatedDiet
      ? '新的每日目标热量是 ' + updatedDiet.targetCalories + ' kcal'
      : '';

    return pickReply([
      '饮食方案已经重排：' + labels + '。' + reason +
        (kcal ? '，' + kcal : '') + '。新食谱刷新到首页就能看到 🍱',
      '搞定 ✨ ' + labels + '。' + reason +
        (kcal ? '现在每天目标 ' + kcal.replace('新的每日目标热量是 ', '') : '') +
        '。如果吃两天觉得不方便，随时告诉我换更简单的搭配。',
      '按你的口味调好了：' + labels + '。' + reason +
        '记住总热量和蛋白质达标最重要，具体吃什么可以灵活一点 🥗'
    ]);
  }

  /** 询问类回复：基于规则给出简短解答，不重生成 */
  function buildQuestionAnswer(text, user, plan, diet) {
    const targetCalories = diet && diet.targetCalories ? diet.targetCalories : null;
    const protein = diet && diet.macros ? diet.macros.protein : Math.round(user.weight * 1.8);

    if (/(火锅|烧烤|外卖|聚餐|奶茶|炸鸡|夜宵)/.test(text)) {
      return (
        '可以吃，增肌或减脂都不需要完全忌口。建议选清汤锅底、瘦肉和蔬菜，' +
        '少喝汤底、少用高油蘸料；把这一餐控制在你每日目标' +
        (targetCalories ? '（' + targetCalories + ' kcal）' : '') +
        '之内，并保证当天蛋白质达到约 ' + protein + ' g。' +
        '本次只做解答，没有修改你的训练或饮食方案。'
      );
    }

    if (/(蛋白|蛋白质)/.test(text)) {
      return (
        '按你当前的体重（' + user.weight + ' kg）和目标，建议每天摄入蛋白质约 ' +
        protein + ' g，分 3~4 餐吃，每餐 25~35 g；训练后 30~60 分钟内补充一次效果更好。' +
        '本次只做解答，没有修改方案。'
      );
    }

    if (/(有氧|跑步|体能|心肺)/.test(text)) {
      return (
        '有氧建议每周安排 2~3 次、每次 20~40 分钟，放在力量训练之后或单独一天。' +
        '减脂期可以适当增加，但不要挤占力量训练和恢复时间。本次只做解答，没有修改方案。'
      );
    }

    if (/(几次|频率|一周|每周|多久|多长时间)/.test(text)) {
      const days = plan
        ? plan.weeklyPlan.filter(function (day) {
            return !day.isRest;
          }).length
        : user.daysPerWeek;
      return (
        '你当前计划每周训练 ' + days + ' 天。新手建议从每周 2~3 天开始，' +
        '能稳定坚持后再加到 4~5 天；训练频率比单次强度更重要。本次只做解答，没有修改方案。'
      );
    }

    if (/(深蹲|蹲)/.test(text) && /(膝|膝盖)/.test(text)) {
      return (
        '深蹲本身并不“伤膝盖”，真正伤膝的通常是膝盖内扣、重心过度前移，' +
        '或者重量超出自己的控制能力 🦵 把膝盖对准脚尖、脚掌踩稳、重量降到可控范围，' +
        '深蹲反而是很好的练腿动作。若已经有膝痛，可以先做靠墙静蹲或箱式深蹲，' +
        '幅度控制在完全不痛的范围内；持续疼痛请及时就医。本次只做解答，没有修改方案。'
      );
    }

    if (/(膝盖|腰|肩|伤病|疼|痛|不舒服)/.test(text)) {
      return (
        '如果关节出现疼痛，先停止会加重不适的动作，优先选择低冲击替代' +
        '（如臀桥、腿弯举、快走、椭圆机）。持续疼痛建议就医。' +
        '你也可以直接说“膝盖不好，替换深蹲”，我会重新生成训练计划。本次只做解答。'
      );
    }

    return (
      '这个问题我暂时没有匹配到具体的规则答案。当前答疑 Agent 支持三类操作：' +
      '改训练计划（伤病、器械、天数）、改饮食建议（食谱花样、热量）、以及常见问题解答。' +
      '你可以直接说“膝盖不好，换掉深蹲”“只有哑铃”“一周练 2 天”“食谱太单调”。' +
      '本次没有触发重新生成。'
    );
  }

  /* ==========================================================================
   * 五、对外函数
   * ========================================================================== */

  /**
   * 处理用户提问（核心实现）。
   *
   * @param {string} text 用户输入
   * @param {Object} userInfo 用户信息
   * @param {Object} [plan] 当前训练计划
   * @param {Object} [diet] 当前饮食建议
   * @returns {Promise<Object>}
   */
  async function answerQuery(text, userInfo, plan, diet) {
    const question = String(text === null || text === undefined ? '' : text).trim();
    const user = App.normalizeUserProfile(userInfo || {});
    const detection = detectIntent(question);

    // 空输入
    if (!question) {
      return {
        intent: 'question',
        intentLabel: '询问',
        regenerateTargets: [],
        adjustments: {},
        reply: '请先输入你想咨询或调整的内容。',
        answer: '请先输入你想咨询或调整的内容。',
        updated: null,
        updatedPlan: null,
        updatedDiet: null,
        _meta: App.createMeta('qaAgent', { mode: 'empty', ruleBased: true })
      };
    }

    // ⓪ 社交意图：问候 / 夸奖 / 倾诉，只回应情绪，不改方案
    if (['greeting', 'praise', 'complain'].indexOf(detection.intent) >= 0) {
      const reply = pickReply(SOCIAL_REPLIES[detection.intent]);

      return {
        intent: detection.intent,
        intentLabel: detection.label,
        regenerateTargets: [],
        adjustments: {},
        reply: reply,
        answer: reply,
        updated: null,
        updatedPlan: null,
        updatedDiet: null,
        _meta: App.createMeta('qaAgent', {
          mode: 'social',
          ruleBased: true,
          placeholder: false
        })
      };
    }

    // ⓪ 知识问答：给出解释，但不改方案
    if (detection.intent === 'knowledge') {
      const reply = '🌿 ' + buildQuestionAnswer(question, user, plan, diet);

      return {
        intent: 'knowledge',
        intentLabel: '健康知识',
        regenerateTargets: [],
        adjustments: {},
        reply: reply,
        answer: reply,
        updated: null,
        updatedPlan: null,
        updatedDiet: null,
        _meta: App.createMeta('qaAgent', {
          mode: 'knowledge',
          topic: detection.topic,
          ruleBased: true,
          placeholder: false
        })
      };
    }

    // ① 询问：不触发重新生成
    if (detection.intent === 'question') {
      const reply = buildQuestionAnswer(question, user, plan, diet);
      return {
        intent: 'question',
        intentLabel: '询问',
        regenerateTargets: [],
        adjustments: {},
        reply: reply,
        answer: reply,
        updated: null,
        updatedPlan: null,
        updatedDiet: null,
        _meta: App.createMeta('qaAgent', {
          mode: 'answer',
          topic: detection.topic,
          ruleBased: true,
          placeholder: false
        })
      };
    }

    // ② 改训练计划：解析参数 → 重生成训练 → 同步重算饮食
    if (detection.intent === 'training') {
      const parsed = parseTrainingAdjustments(question, user);
      const nextProfile = Object.assign({}, user, parsed.changes);

      let updatedPlan = null;
      let updatedDiet = null;
      let error = null;

      try {
        updatedPlan = await App.trainingAgent(nextProfile);
        // 训练天数/伤病变化会影响热量分配，饮食方案一并重算
        if (diet) {
          updatedDiet = await App.dietAgent(nextProfile, { plan: updatedPlan });
        }
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }

      const reply = buildTrainingReply(parsed, updatedPlan, error);
      const targets = updatedDiet ? ['training', 'diet'] : ['training'];

      return {
        intent: 'training',
        intentLabel: '改训练计划',
        regenerateTargets: targets,
        adjustments: parsed.changes,
        reply: reply,
        answer: reply,
        updated: updatedPlan
          ? {
              profile: nextProfile,
              trainingPlan: updatedPlan,
              nutritionPlan: updatedDiet || diet || null
            }
          : null,
        updatedPlan: updatedPlan,
        updatedDiet: updatedDiet,
        error: error,
        _meta: App.createMeta('qaAgent', {
          mode: 'adjust_training',
          matched: detection.reasons,
          ruleBased: true,
          placeholder: false
        })
      };
    }

    // ③ 改饮食建议：解析参数 → 重新生成饮食
    const parsed = parseDietAdjustments(question);
    const nextProfile = Object.assign({}, user, parsed.changes);

    let updatedDiet = null;
    let error = null;

    try {
      updatedDiet = await App.dietAgent(nextProfile, { plan: plan || null });
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    }

    const reply = buildDietReply(parsed, updatedDiet, error);

    return {
      intent: 'diet',
      intentLabel: '改饮食建议',
      regenerateTargets: ['diet'],
      adjustments: parsed.changes,
      reply: reply,
      answer: reply,
      updated: updatedDiet
        ? {
            profile: nextProfile,
            trainingPlan: plan || null,
            nutritionPlan: updatedDiet
          }
        : null,
      updatedPlan: null,
      updatedDiet: updatedDiet,
      error: error,
      _meta: App.createMeta('qaAgent', {
        mode: 'adjust_diet',
        matched: detection.reasons,
        ruleBased: true,
        placeholder: false
      })
    };
  }

  /**
   * 既有注册入口（契约不变）。
   * 兼容旧页面传参：{ profile, question, currentPlan }。
   *
   * @param {Object} payload
   * @param {Object} [options] 预留参数
   * @returns {Promise<Object>}
   */
  async function qaAgent(payload = {}, options = {}) {
    const current = payload.currentPlan || {};
    const text = payload.question || payload.text || payload.query || '';
    const userInfo = payload.profile || payload.userInfo || {};
    const plan = payload.plan || current.trainingPlan || null;
    const diet = payload.diet || current.nutritionPlan || null;

    return answerQuery(text, userInfo, plan, diet);
  }

  /** 暴露核心实现，方便单测与直接调用 */
  qaAgent.answerQuery = answerQuery;
  App.answerQuery = answerQuery;
  App.qaAgent = qaAgent;
})(window);