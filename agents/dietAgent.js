/**
 * ============================================================================
 * agents/dietAgent.js —— 营养饮食 Agent（内置规则公式，不依赖外部 API）
 * ----------------------------------------------------------------------------
 * 职责：
 *   根据用户信息与训练计划，计算每日热量、三大营养素与占比，生成一日三餐示例
 *   食谱，并说明训练日/休息日热量差异与补水建议。
 *
 * 输入：
 *   @param {Object} userInfo 用户信息
 *     英文：{ gender:'male'|'female', age, height, weight, goal, daysPerWeek }
 *     中文：{ 性别, 年龄, 身高, 体重, 目标, 每周训练天数 }
 *   @param {TrainingPlan} [plan] 训练计划 Agent 的产出（可选）
 *     用于读取 weeklyPlan 中实际训练日数量；缺失时回退到 userInfo.daysPerWeek
 *
 * 输出：
 *   @returns {NutritionPlan}
 *   {
 *     targetCalories,                       // 每日目标摄入 kcal
 *     bmr, tdee, activityFactor, goalAdjust,// 计算过程明细
 *     macros: { protein, carbs, fat },      // 克数
 *     macroPercent: { protein, carbs, fat },// 占比（%）
 *     trainingDay: { calories, carbsExtraGrams, note },
 *     restDay: { calories, note },
 *     calorieDelta,                         // 训练日与休息日差值 kcal
 *     meals: [{ name, time, calories, foods:[{food, amount}] }],
 *     hydration: { dailyMl, trainingDayMl, dailyLiters, trainingDayLiters, tips },
 *     tips: string[],
 *     meta, _meta
 *   }
 *
 * 计算规则（用户指定）：
 *   1. 基础代谢 Mifflin-St Jeor：
 *      男 = 10×体重 + 6.25×身高 - 5×年龄 + 5
 *      女 = 10×体重 + 6.25×身高 - 5×年龄 - 161
 *   2. 每日总消耗 = 基础代谢 × 活动系数：
 *      每周训练 1-2 天 1.2；3-4 天 1.375；5-6 天 1.55；7 天 1.725
 *   3. 目标调整：增肌 +300 kcal，减脂 -300 kcal，塑形 0
 *   4. 蛋白质：增肌 2.0 g/kg，减脂 2.2 g/kg，塑形 1.8 g/kg
 *      脂肪占总热量 25%，剩余热量给碳水
 *   5. 训练日比休息日多约 150 kcal，多出的热量优先加到碳水，周平均仍等于目标热量
 *
 * 对外函数：
 *   generateDiet(userInfo, plan) —— 纯规则核心实现（同步）
 *   dietAgent(profile, options)  —— 既有注册入口，返回 Promise<NutritionPlan>，契约不变
 * ============================================================================
 */
(function (global) {
  'use strict';

  const App = (global.FitnessApp = global.FitnessApp || {});

  /* ==========================================================================
   * 一、规则常量
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

  const GOAL_LABELS = {
    build_muscle: '增肌',
    lose_fat: '减脂',
    body_shape: '塑形',
    endurance: '提升体能',
    health: '保持健康'
  };

  /** 目标热量调整（kcal / 天） */
  const GOAL_CALORIE_ADJUST = {
    build_muscle: 300,
    lose_fat: -300,
    body_shape: 0,
    endurance: 0,
    health: 0
  };

  /** 蛋白质系数（g / kg 体重） */
  const PROTEIN_PER_KG = {
    build_muscle: 2.0,
    lose_fat: 2.2,
    body_shape: 1.8,
    endurance: 1.8,
    health: 1.5
  };

  /** 脂肪占总热量的比例 */
  const FAT_RATIO = 0.25;

  /** 蛋白质热量占目标热量的上限，防止极端体重下碳水被挤成负数 */
  const PROTEIN_MAX_ENERGY_RATIO = 0.4;

  /** 每日最低热量保护 */
  const MIN_CALORIES = 1200;

  /** 训练日比休息日多出的热量（kcal），全部加到碳水 */
  const TRAINING_DAY_DELTA = 150;

  /** 补水：每公斤体重 35 ml，训练日额外 600 ml */
  const WATER_ML_PER_KG = 35;
  const TRAINING_WATER_EXTRA_ML = 600;

  /** 三餐热量分配比例：早餐 27%、午餐 38%、晚餐 35% */
  const MEAL_RATIOS = [0.27, 0.38, 0.35];

  /* ==========================================================================
   * 二、示例食谱模板
   * --------------------------------------------------------------------------
   * 食物分量为 70 kg 左右成年人的示例值，热量目标不同时可按比例增减主食与油脂。
   * ========================================================================== */

  const MEAL_TEMPLATES = {
    /** 增肌：热量与蛋白偏高，主食量更大 */
    build_muscle: [
      {
        name: '早餐',
        time: '07:30',
        foods: [
          { food: '燕麦片', amount: '60 g' },
          { food: '全脂牛奶', amount: '300 ml' },
          { food: '鸡蛋', amount: '2 个' },
          { food: '香蕉', amount: '1 根' }
        ]
      },
      {
        name: '午餐',
        time: '12:00',
        foods: [
          { food: '糙米饭', amount: '200 g（熟重）' },
          { food: '鸡胸肉', amount: '150 g' },
          { food: '西兰花 + 彩椒', amount: '200 g' },
          { food: '橄榄油', amount: '10 g' }
        ]
      },
      {
        name: '晚餐',
        time: '18:30',
        foods: [
          { food: '红薯', amount: '200 g' },
          { food: '三文鱼', amount: '150 g' },
          { food: '混合蔬菜', amount: '200 g' },
          { food: '无糖酸奶', amount: '150 g' }
        ]
      }
    ],

    /** 减脂：控制主食与油脂，保证蛋白质和蔬菜 */
    lose_fat: [
      {
        name: '早餐',
        time: '07:30',
        foods: [
          { food: '全麦面包', amount: '2 片' },
          { food: '水煮蛋', amount: '2 个' },
          { food: '无糖豆浆', amount: '300 ml' },
          { food: '圣女果', amount: '100 g' }
        ]
      },
      {
        name: '午餐',
        time: '12:00',
        foods: [
          { food: '糙米饭', amount: '100 g（熟重）' },
          { food: '鸡胸肉', amount: '150 g' },
          { food: '绿叶蔬菜', amount: '250 g' },
          { food: '橄榄油', amount: '5 g' }
        ]
      },
      {
        name: '晚餐',
        time: '18:30',
        foods: [
          { food: '杂粮饭', amount: '80 g（熟重）' },
          { food: '虾仁 / 龙利鱼', amount: '150 g' },
          { food: '清炒时蔬', amount: '250 g' },
          { food: '无糖酸奶', amount: '100 g' }
        ]
      }
    ],

    /** 塑形：均衡型食谱，兼顾蛋白与主食 */
    body_shape: [
      {
        name: '早餐',
        time: '07:30',
        foods: [
          { food: '希腊酸奶', amount: '200 g' },
          { food: '燕麦片', amount: '40 g' },
          { food: '蓝莓', amount: '100 g' },
          { food: '水煮蛋', amount: '1 个' }
        ]
      },
      {
        name: '午餐',
        time: '12:00',
        foods: [
          { food: '藜麦饭', amount: '150 g（熟重）' },
          { food: '瘦牛肉', amount: '120 g' },
          { food: '彩椒 + 西兰花', amount: '200 g' },
          { food: '橄榄油', amount: '8 g' }
        ]
      },
      {
        name: '晚餐',
        time: '18:30',
        foods: [
          { food: '玉米', amount: '1 根' },
          { food: '去皮鸡腿肉', amount: '120 g' },
          { food: '菠菜', amount: '200 g' },
          { food: '北豆腐', amount: '100 g' }
        ]
      }
    ]
  };

  /* ==========================================================================
   * 三、输入解析
   * ========================================================================== */

  /** 按顺序读取字段，兼容中英文两种写法 */
  function readField(raw, keys, fallback) {
    for (let i = 0; i < keys.length; i += 1) {
      const value = raw[keys[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
  }

  /** 目标归一化 */
  function resolveGoal(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (GOAL_ALIAS[text]) return GOAL_ALIAS[text];
    const lower = text.toLowerCase();
    if (GOAL_ALIAS[lower]) return GOAL_ALIAS[lower];
    return 'health';
  }

  /** 性别归一化：只有明确为女性时返回 female，其余按 male 处理（Mifflin 公式需要） */
  function resolveGender(value) {
    const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (text === 'female' || text === 'f' || text === '女') return 'female';
    return 'male';
  }

  /**
   * 训练天数：
   *   优先读训练计划里实际训练日数量（最准确，能反映休息日安排）；
   *   没有计划时回退到用户填写的每周训练天数。
   */
  function resolveTrainingDays(raw, plan) {
    if (plan && Array.isArray(plan.weeklyPlan) && plan.weeklyPlan.length) {
      const trainedDays = plan.weeklyPlan.filter(function (day) {
        return !day.isRest;
      }).length;
      if (trainedDays > 0) return trainedDays;
    }

    const declared = readField(raw, ['daysPerWeek', 'trainingDays', '每周训练天数'], 3);
    return Math.round(App.clampNumber(declared, 1, 7, 3));
  }

  /** 组装计算上下文 */
  function buildContext(userInfo, plan) {
    const raw = userInfo || {};
    const fallback = App.normalizeUserProfile(raw);

    return {
      gender: resolveGender(readField(raw, ['gender', '性别'], fallback.gender)),
      age: Math.round(App.clampNumber(readField(raw, ['age', '年龄'], fallback.age), 12, 90, 28)),
      height: App.clampNumber(readField(raw, ['height', '身高'], fallback.height), 120, 230, 170),
      weight: App.clampNumber(readField(raw, ['weight', '体重'], fallback.weight), 30, 250, 65),
      goalKey: resolveGoal(readField(raw, ['goal', 'target', '目标'], fallback.goal)),
      trainingDays: resolveTrainingDays(raw, plan),
      hasPlan: Boolean(plan && Array.isArray(plan.weeklyPlan)),
      // 答疑 Agent 触发调整时透传的额外参数
      calorieAdjust: App.clampNumber(raw.calorieAdjust, -300, 300, 0),
      dietVariety: raw.dietVariety === true || raw.dietVariety === 'true'
    };
  }

  /* ==========================================================================
   * 四、热量与营养素计算
   * ========================================================================== */

  /** Mifflin-St Jeor 基础代谢 */
  function calcBmr(ctx) {
    const base = 10 * ctx.weight + 6.25 * ctx.height - 5 * ctx.age;
    return Math.round(base + (ctx.gender === 'female' ? -161 : 5));
  }

  /** 按每周训练天数取活动系数 */
  function resolveActivityFactor(trainingDays) {
    if (trainingDays <= 2) return 1.2;
    if (trainingDays <= 4) return 1.375;
    if (trainingDays <= 6) return 1.55;
    return 1.725;
  }

  /**
   * 三大营养素：
   *   蛋白质按 g/kg 计算，并限制不超过目标热量的 40%；
   *   脂肪固定占总热量 25%；
   *   剩余热量全部给碳水。
   */
  function calcMacros(targetCalories, weight, goalKey) {
    const perKg = PROTEIN_PER_KG[goalKey] || 1.6;
    const maxProtein = Math.floor((targetCalories * PROTEIN_MAX_ENERGY_RATIO) / 4);
    const protein = Math.round(Math.min(weight * perKg, maxProtein));
    const fat = Math.round((targetCalories * FAT_RATIO) / 9);
    const carbs = Math.max(0, Math.round((targetCalories - protein * 4 - fat * 9) / 4));

    // 占比按实际热量换算，碳水用差值补齐，保证三项合计 100%
    const proteinPercent = Math.round(((protein * 4) / targetCalories) * 1000) / 10;
    const fatPercent = Math.round(((fat * 9) / targetCalories) * 1000) / 10;
    const carbsPercent = Math.max(
      0,
      Math.round((100 - proteinPercent - fatPercent) * 10) / 10
    );

    return {
      protein: protein,
      carbs: carbs,
      fat: fat,
      percent: {
        protein: proteinPercent,
        carbs: carbsPercent,
        fat: fatPercent
      }
    };
  }

  /**
   * 训练日 / 休息日热量差异。
   * 设训练日比休息日多 150 kcal，并按周平均回算休息日热量，
   * 保证 (训练日 × 天数 + 休息日 × 天数) / 7 = 每日目标热量。
   */
  function buildDayEnergy(targetCalories, trainingDays) {
    const restDays = 7 - trainingDays;

    if (trainingDays >= 7) {
      return {
        calorieDelta: 0,
        trainingDay: {
          calories: targetCalories,
          carbsExtraGrams: 0,
          note: '本周每天都有训练，按每日目标热量执行，重点保证睡眠与恢复。'
        },
        restDay: {
          calories: targetCalories,
          note: '本周没有完整休息日，可将其中一天改为低强度主动恢复。'
        }
      };
    }

    if (trainingDays <= 0) {
      return {
        calorieDelta: 0,
        trainingDay: {
          calories: targetCalories,
          carbsExtraGrams: 0,
          note: '当前没有安排训练日，按每日目标热量执行。'
        },
        restDay: {
          calories: targetCalories,
          note: '休息日与日常一致，建议保持日常活动量。'
        }
      };
    }

    const restCalories = Math.round(targetCalories - (TRAINING_DAY_DELTA * trainingDays) / 7);
    const trainingCalories = restCalories + TRAINING_DAY_DELTA;
    const carbsExtraGrams = Math.round(TRAINING_DAY_DELTA / 4);

    return {
      calorieDelta: TRAINING_DAY_DELTA,
      trainingDay: {
        calories: trainingCalories,
        carbsExtraGrams: carbsExtraGrams,
        note:
          `训练日约 ${trainingCalories} kcal，比休息日多 ${TRAINING_DAY_DELTA} kcal；` +
          `多出的热量优先加到碳水（约 ${carbsExtraGrams} g），蛋白质保持不变。`
      },
      restDay: {
        calories: restCalories,
        note:
          `休息日约 ${restCalories} kcal，比训练日少 ${TRAINING_DAY_DELTA} kcal；` +
          '减少的主要是主食，蛋白质和蔬菜保持原有水平。'
      }
    };
  }

  /** 食谱多样化时附带的同类替换建议（每餐一条） */
  const VARIETY_SWAPS = {
    build_muscle: [
      '牛奶 ↔ 无糖豆浆 / 酸奶；香蕉 ↔ 苹果 / 蓝莓',
      '鸡胸肉 ↔ 牛肉 / 龙利鱼；糙米 ↔ 藜麦 / 红薯',
      '三文鱼 ↔ 虾仁 / 鸡腿肉；红薯 ↔ 玉米 / 糙米'
    ],
    lose_fat: [
      '全麦面包 ↔ 玉米 / 燕麦；豆浆 ↔ 脱脂牛奶',
      '鸡胸肉 ↔ 虾仁 / 龙利鱼；糙米 ↔ 藜麦 / 魔芋面',
      '虾仁 ↔ 鸡胸肉 / 豆腐；杂粮饭 ↔ 红薯 / 玉米'
    ],
    body_shape: [
      '希腊酸奶 ↔ 无糖酸奶 / 豆浆；蓝莓 ↔ 草莓 / 苹果',
      '瘦牛肉 ↔ 鸡胸肉 / 三文鱼；藜麦 ↔ 糙米 / 红薯',
      '鸡腿肉 ↔ 鱼虾 / 豆腐；玉米 ↔ 南瓜 / 杂粮饭'
    ]
  };

  /** 按比例把每日热量分配到三餐，并套用对应目标的示例食谱 */
  function buildMeals(goalKey, targetCalories, variety) {
    const template = MEAL_TEMPLATES[goalKey] || MEAL_TEMPLATES.body_shape;
    const swaps = VARIETY_SWAPS[goalKey] || VARIETY_SWAPS.body_shape;

    return template.map(function (meal, index) {
      const foods = meal.foods.map(function (item) {
        return { food: item.food, amount: item.amount };
      });

      // 用户要求"换点花样"时，为每餐追加一条同类食物替换建议
      if (variety && swaps[index]) {
        foods.push({ food: '同类替换', amount: swaps[index] });
      }

      return {
        name: meal.name,
        time: meal.time,
        calories: Math.round(targetCalories * MEAL_RATIOS[index]),
        foods: foods
      };
    });
  }

  /** 补水建议 */
  function buildHydration(weight, trainingDays) {
    const dailyMl = Math.round(weight * WATER_ML_PER_KG);
    const trainingDayMl = dailyMl + TRAINING_WATER_EXTRA_ML;
    const dailyLiters = Math.round(dailyMl / 100) / 10;
    const trainingDayLiters = Math.round(trainingDayMl / 100) / 10;

    return {
      dailyMl: dailyMl,
      trainingDayMl: trainingDayMl,
      dailyLiters: dailyLiters,
      trainingDayLiters: trainingDayLiters,
      tips: [
        `日常饮水约 ${dailyLiters} L，训练日约 ${trainingDayLiters} L（按体重 ${weight} kg 估算）。`,
        '训练前 30 分钟补充 300~500 ml，训练中每 15~20 分钟少量补水。',
        '训练后可补充 500 ml 左右；出汗量大时适当加入电解质。',
        '不要等到口渴才喝水，尿液呈浅黄色说明补水基本充足。'
      ]
    };
  }

  /** 饮食建议文案 */
  function buildTips(ctx, targetCalories, macros) {
    const tips = [];

    tips.push(
      `每日蛋白质约 ${macros.protein} g，建议分到三餐，每餐 25~35 g；训练后 30~60 分钟内补充一次。`
    );
    tips.push('脂肪优先来自坚果、牛油果、橄榄油和深海鱼，减少油炸食品与反式脂肪。');
    tips.push('碳水优先选择糙米、燕麦、红薯、藜麦等低加工主食，训练日可适当增加。');
    tips.push('每天至少摄入 300~500 g 蔬菜，保证膳食纤维与微量元素。');

    if (ctx.goalKey === 'lose_fat') {
      tips.push('减脂期保持三餐规律，避免长时间空腹后暴食，可安排一份低热量加餐。');
    }
    if (ctx.goalKey === 'build_muscle') {
      tips.push('增肌期若体重连续 2 周不增长，可在当前热量基础上再增加 100~200 kcal。');
    }
    if (ctx.trainingDays >= 5) {
      tips.push('每周训练 5 天以上，注意安排至少 1 天完整休息，避免恢复不足。');
    }

    tips.push(
      `当前按每日 ${targetCalories} kcal 计算，食谱为示例，同类食物可等量替换。`
    );

    return tips;
  }

  /* ==========================================================================
   * 五、对外函数
   * ========================================================================== */

  /**
   * 生成营养方案（核心实现，纯规则、同步返回）。
   *
   * @param {Object} userInfo 用户信息（支持中英文两种字段名）
   * @param {Object} [plan] 训练计划 Agent 的产出
   * @returns {NutritionPlan}
   */
  function generateDiet(userInfo, plan) {
    const ctx = buildContext(userInfo, plan);
    const goalLabel = GOAL_LABELS[ctx.goalKey] || '综合';

    const bmr = calcBmr(ctx);
    const activityFactor = resolveActivityFactor(ctx.trainingDays);
    const tdee = Math.round(bmr * activityFactor);
    const goalAdjust = GOAL_CALORIE_ADJUST[ctx.goalKey] || 0;
    // 答疑 Agent 可传入 calorieAdjust（默认 ±100）做热量微调
    const targetCalories = Math.max(
      MIN_CALORIES,
      Math.round(tdee + goalAdjust + ctx.calorieAdjust)
    );

    const macros = calcMacros(targetCalories, ctx.weight, ctx.goalKey);
    const dayEnergy = buildDayEnergy(targetCalories, ctx.trainingDays);
    const meals = buildMeals(ctx.goalKey, targetCalories, ctx.dietVariety);
    const hydration = buildHydration(ctx.weight, ctx.trainingDays);

    return {
      targetCalories: targetCalories,
      bmr: bmr,
      tdee: tdee,
      activityFactor: activityFactor,
      goalAdjust: goalAdjust,
      macros: {
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat
      },
      macroPercent: macros.percent,
      trainingDay: dayEnergy.trainingDay,
      restDay: dayEnergy.restDay,
      calorieDelta: dayEnergy.calorieDelta,
      meals: meals,
      hydration: hydration,
      tips: buildTips(ctx, targetCalories, macros),
      meta: {
        gender: ctx.gender,
        age: ctx.age,
        height: ctx.height,
        weight: ctx.weight,
        goal: ctx.goalKey,
        goalLabel: goalLabel,
        trainingDays: ctx.trainingDays,
        restDays: 7 - ctx.trainingDays,
        usedTrainingPlan: ctx.hasPlan,
        calorieAdjust: ctx.calorieAdjust,
        dietVariety: ctx.dietVariety,
        formula: 'Mifflin-St Jeor',
        source: 'builtin_rule_formula'
      },
      _meta: App.createMeta('dietAgent', {
        placeholder: false,
        ruleBased: true
      })
    };
  }

  /**
   * 既有注册入口（契约不变）：coachAgent 调用它，并把训练计划放进 options.plan。
   *
   * @param {Object} profile 用户档案
   * @param {Object} [options] { plan: TrainingPlan }
   * @returns {Promise<NutritionPlan>}
   */
  async function dietAgent(profile, options = {}) {
    return generateDiet(profile, options.plan || null);
  }

  /**

   * 内置食物营养库（每 100 g 的热量与三大营养素）。
   * 用于打卡页手动记录食物分量时计算实际摄入，不依赖外部 API。
   * 数值为常见食物近似值，仅用于日常估算。
   */
  const FOOD_LIBRARY = [
    /* ---------------- 主食 ---------------- */
    { id: 'rice', name: '米饭', category: '主食', aliases: ['白米饭', '大米饭'], per100g: { calories: 116, protein: 2.6, carbs: 25.9, fat: 0.3 } },
    { id: 'brown_rice', name: '糙米饭', category: '主食', aliases: ['糙米'], per100g: { calories: 111, protein: 2.6, carbs: 23, fat: 0.9 } },
    { id: 'noodles', name: '面条（熟）', category: '主食', aliases: ['面条', '挂面'], per100g: { calories: 110, protein: 4.5, carbs: 23, fat: 0.5 } },
    { id: 'steamed_bun', name: '馒头', category: '主食', aliases: ['白馒头'], per100g: { calories: 223, protein: 7, carbs: 47, fat: 1.1 } },
    { id: 'oats', name: '燕麦片', category: '主食', aliases: ['燕麦'], per100g: { calories: 377, protein: 13, carbs: 66, fat: 7 } },
    { id: 'corn', name: '玉米', category: '主食', aliases: ['甜玉米', '玉米棒'], per100g: { calories: 86, protein: 3.3, carbs: 19, fat: 1.2 } },
    { id: 'sweet_potato', name: '红薯', category: '主食', aliases: ['地瓜', '番薯'], per100g: { calories: 86, protein: 1.6, carbs: 20, fat: 0.1 } },
    { id: 'whole_bread', name: '全麦面包', category: '主食', aliases: ['面包'], per100g: { calories: 246, protein: 9, carbs: 49, fat: 3.3 } },
    { id: 'quinoa', name: '藜麦（熟）', category: '主食', aliases: ['藜麦'], per100g: { calories: 120, protein: 4.4, carbs: 21, fat: 1.9 } },
    { id: 'millet_porridge', name: '小米粥', category: '主食', aliases: ['小米稀饭'], per100g: { calories: 46, protein: 1.4, carbs: 9.7, fat: 0.7 } },
    { id: 'potato', name: '土豆', category: '主食', aliases: ['马铃薯'], per100g: { calories: 77, protein: 2, carbs: 17.2, fat: 0.2 } },

    /* ---------------- 肉蛋 ---------------- */
    { id: 'chicken_breast', name: '鸡胸肉', category: '肉蛋', aliases: ['鸡胸', '鸡脯肉'], per100g: { calories: 133, protein: 24, carbs: 2.5, fat: 2.5 } },
    { id: 'chicken_thigh', name: '去皮鸡腿肉', category: '肉蛋', aliases: ['鸡腿肉', '鸡腿'], per100g: { calories: 161, protein: 19, carbs: 0, fat: 9 } },
    { id: 'beef', name: '瘦牛肉', category: '肉蛋', aliases: ['牛肉'], per100g: { calories: 125, protein: 20, carbs: 2, fat: 4 } },
    { id: 'pork_lean', name: '瘦猪肉', category: '肉蛋', aliases: ['猪里脊', '猪肉'], per100g: { calories: 143, protein: 20.3, carbs: 0, fat: 6.2 } },
    { id: 'egg', name: '鸡蛋', category: '肉蛋', aliases: ['蛋', '水煮蛋'], per100g: { calories: 144, protein: 13, carbs: 2.8, fat: 8.8 } },
    { id: 'duck_breast', name: '鸭胸肉', category: '肉蛋', aliases: ['鸭肉'], per100g: { calories: 90, protein: 19, carbs: 0, fat: 1.5 } },
    { id: 'lamb_lean', name: '瘦羊肉', category: '肉蛋', aliases: ['羊肉'], per100g: { calories: 118, protein: 20, carbs: 0, fat: 4 } },

    /* ---------------- 水产 ---------------- */
    { id: 'salmon', name: '三文鱼', category: '水产', aliases: ['鲑鱼'], per100g: { calories: 208, protein: 20, carbs: 0, fat: 13 } },
    { id: 'fish', name: '鱼（草鱼）', category: '水产', aliases: ['鱼', '草鱼', '鱼肉'], per100g: { calories: 113, protein: 16.6, carbs: 0, fat: 5.2 } },
    { id: 'seabass', name: '鲈鱼', category: '水产', aliases: ['海鲈鱼'], per100g: { calories: 105, protein: 18.6, carbs: 0, fat: 3.4 } },
    { id: 'dory', name: '龙利鱼', category: '水产', aliases: ['巴沙鱼'], per100g: { calories: 83, protein: 17, carbs: 0, fat: 1.2 } },
    { id: 'shrimp', name: '虾仁', category: '水产', aliases: ['虾', '基围虾'], per100g: { calories: 93, protein: 18, carbs: 1, fat: 1.5 } },
    { id: 'hairtail', name: '带鱼', category: '水产', aliases: [], per100g: { calories: 127, protein: 17.7, carbs: 0, fat: 4.9 } },

    /* ---------------- 蔬菜 ---------------- */
    { id: 'broccoli', name: '西兰花', category: '蔬菜', aliases: ['绿花菜'], per100g: { calories: 34, protein: 2.8, carbs: 7, fat: 0.4 } },
    { id: 'tomato', name: '番茄', category: '蔬菜', aliases: ['西红柿'], per100g: { calories: 18, protein: 0.9, carbs: 3.9, fat: 0.2 } },
    { id: 'cucumber', name: '黄瓜', category: '蔬菜', aliases: [], per100g: { calories: 15, protein: 0.7, carbs: 3.6, fat: 0.1 } },
    { id: 'spinach', name: '菠菜', category: '蔬菜', aliases: [], per100g: { calories: 23, protein: 2.9, carbs: 3.6, fat: 0.4 } },
    { id: 'lettuce', name: '生菜', category: '蔬菜', aliases: [], per100g: { calories: 15, protein: 1.4, carbs: 2.9, fat: 0.2 } },
    { id: 'carrot', name: '胡萝卜', category: '蔬菜', aliases: ['红萝卜'], per100g: { calories: 41, protein: 0.9, carbs: 9.6, fat: 0.2 } },
    { id: 'cabbage', name: '白菜', category: '蔬菜', aliases: ['大白菜', '娃娃菜'], per100g: { calories: 17, protein: 1.5, carbs: 3.2, fat: 0.1 } },
    { id: 'eggplant', name: '茄子', category: '蔬菜', aliases: [], per100g: { calories: 21, protein: 1.1, carbs: 4.9, fat: 0.2 } },
    { id: 'green_pepper', name: '青椒', category: '蔬菜', aliases: ['柿子椒'], per100g: { calories: 22, protein: 1, carbs: 5.4, fat: 0.2 } },
    { id: 'bean_sprout', name: '豆芽', category: '蔬菜', aliases: ['绿豆芽'], per100g: { calories: 18, protein: 2.1, carbs: 2.9, fat: 0.1 } },
    { id: 'mushroom', name: '香菇', category: '蔬菜', aliases: ['蘑菇'], per100g: { calories: 26, protein: 2.2, carbs: 5.2, fat: 0.3 } },

    /* ---------------- 水果 ---------------- */
    { id: 'apple', name: '苹果', category: '水果', aliases: [], per100g: { calories: 52, protein: 0.3, carbs: 13.8, fat: 0.2 } },
    { id: 'banana', name: '香蕉', category: '水果', aliases: [], per100g: { calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3 } },
    { id: 'orange', name: '橙子', category: '水果', aliases: ['橙'], per100g: { calories: 47, protein: 0.9, carbs: 11.8, fat: 0.1 } },
    { id: 'blueberry', name: '蓝莓', category: '水果', aliases: [], per100g: { calories: 57, protein: 0.7, carbs: 14.5, fat: 0.3 } },
    { id: 'watermelon', name: '西瓜', category: '水果', aliases: [], per100g: { calories: 30, protein: 0.6, carbs: 7.6, fat: 0.2 } },
    { id: 'grape', name: '葡萄', category: '水果', aliases: ['提子'], per100g: { calories: 69, protein: 0.7, carbs: 18.1, fat: 0.2 } },
    { id: 'kiwi', name: '猕猴桃', category: '水果', aliases: ['奇异果'], per100g: { calories: 61, protein: 1.1, carbs: 14.7, fat: 0.5 } },
    { id: 'strawberry', name: '草莓', category: '水果', aliases: [], per100g: { calories: 32, protein: 0.7, carbs: 7.7, fat: 0.3 } },

    /* ---------------- 常见菜品（按成品熟重估算） ---------------- */
    { id: 'tomato_egg', name: '西红柿炒蛋', category: '常见菜品', aliases: ['番茄炒蛋', '番茄炒鸡蛋'], per100g: { calories: 86, protein: 5.2, carbs: 3.9, fat: 5.6 } },
    { id: 'kung_pao_chicken', name: '宫保鸡丁', category: '常见菜品', aliases: ['宫爆鸡丁'], per100g: { calories: 152, protein: 13.5, carbs: 7.4, fat: 8.2 } },
    { id: 'steamed_fish', name: '清蒸鱼', category: '常见菜品', aliases: ['清蒸鲈鱼'], per100g: { calories: 96, protein: 17.5, carbs: 0.8, fat: 2.9 } },
    { id: 'stir_fried_greens', name: '炒青菜', category: '常见菜品', aliases: ['清炒时蔬', '炒蔬菜'], per100g: { calories: 48, protein: 1.8, carbs: 4.3, fat: 3.1 } },
    { id: 'braised_pork', name: '红烧肉', category: '常见菜品', aliases: [], per100g: { calories: 393, protein: 9.5, carbs: 4.5, fat: 38 } },
    { id: 'mapo_tofu', name: '麻婆豆腐', category: '常见菜品', aliases: [], per100g: { calories: 118, protein: 8.1, carbs: 4.2, fat: 7.9 } },
    { id: 'fish_fragrant_pork', name: '鱼香肉丝', category: '常见菜品', aliases: [], per100g: { calories: 145, protein: 10.5, carbs: 9.6, fat: 8.2 } },
    { id: 'green_pepper_pork', name: '青椒肉丝', category: '常见菜品', aliases: [], per100g: { calories: 116, protein: 10.9, carbs: 3.6, fat: 6.8 } },
    { id: 'garlic_broccoli', name: '蒜蓉西兰花', category: '常见菜品', aliases: [], per100g: { calories: 55, protein: 2.6, carbs: 6.5, fat: 2.6 } },
    { id: 'tomato_beef', name: '番茄牛腩', category: '常见菜品', aliases: ['西红柿炖牛腩'], per100g: { calories: 108, protein: 11.2, carbs: 4.3, fat: 4.9 } },

    /* ---------------- 饮品 ---------------- */
    { id: 'milk', name: '牛奶', category: '饮品', aliases: ['全脂牛奶'], per100g: { calories: 54, protein: 3, carbs: 3.4, fat: 3.2 } },
    { id: 'skim_milk', name: '脱脂牛奶', category: '饮品', aliases: ['低脂牛奶'], per100g: { calories: 33, protein: 3.4, carbs: 5, fat: 0.2 } },
    { id: 'soy_milk', name: '无糖豆浆', category: '饮品', aliases: ['豆浆'], per100g: { calories: 30, protein: 3, carbs: 1.8, fat: 1.5 } },
    { id: 'yogurt', name: '无糖酸奶', category: '饮品', aliases: ['酸奶'], per100g: { calories: 63, protein: 5, carbs: 4, fat: 2.5 } },
    { id: 'black_coffee', name: '黑咖啡', category: '饮品', aliases: ['美式咖啡'], per100g: { calories: 2, protein: 0.1, carbs: 0, fat: 0 } },
    { id: 'cola', name: '可乐', category: '饮品', aliases: ['碳酸饮料'], per100g: { calories: 43, protein: 0, carbs: 10.6, fat: 0 } },

    /* ---------------- 坚果油脂 ---------------- */
    { id: 'almond', name: '杏仁', category: '坚果油脂', aliases: [], per100g: { calories: 579, protein: 21, carbs: 21.6, fat: 49.9 } },
    { id: 'peanut', name: '花生', category: '坚果油脂', aliases: ['花生米'], per100g: { calories: 567, protein: 25.8, carbs: 16.1, fat: 49.2 } },
    { id: 'walnut', name: '核桃', category: '坚果油脂', aliases: [], per100g: { calories: 654, protein: 15.2, carbs: 19.1, fat: 65.2 } },
    { id: 'olive_oil', name: '橄榄油', category: '坚果油脂', aliases: ['食用油'], per100g: { calories: 884, protein: 0, carbs: 0, fat: 100 } },
    { id: 'avocado', name: '牛油果', category: '坚果油脂', aliases: ['鳄梨'], per100g: { calories: 160, protein: 2, carbs: 8.5, fat: 14.7 } },

    /* ---------------- 豆制品 ---------------- */
    { id: 'tofu', name: '豆腐', category: '豆制品', aliases: ['北豆腐', '南豆腐'], per100g: { calories: 76, protein: 8, carbs: 1.9, fat: 4.8 } },
    { id: 'dried_tofu', name: '豆干', category: '豆制品', aliases: ['豆腐干'], per100g: { calories: 140, protein: 16.2, carbs: 4.5, fat: 7 } },
    { id: 'whey', name: '乳清蛋白粉', category: '豆制品', aliases: ['蛋白粉'], per100g: { calories: 400, protein: 80, carbs: 8, fat: 6 } }
  ];

  /**
   * 内置推荐食谱库（25 套，覆盖增肌 / 减脂 / 塑形 / 素食 / 中式家常 / 快手）。
   * 每套只存「食物 id + 克数」，营养值运行时按食物库计算，便于长期维护。
   */
  const RECIPE_LIBRARY = [
    /* ---------------- 增肌餐 💪 ---------------- */
    { id: 'muscle_1', name: '鸡胸米饭套餐', type: 'muscle', tag: '增肌优选💪', say: '训练后补蛋白，鸡胸配米饭简单又顶饱。', items: [{ foodId: 'chicken_breast', grams: 120 }, { foodId: 'rice', grams: 150 }, { foodId: 'broccoli', grams: 150 }] },
    { id: 'muscle_2', name: '牛肉红薯餐', type: 'muscle', tag: '增肌优选💪', say: '牛肉补铁又补蛋白，红薯让能量更持久。', items: [{ foodId: 'beef', grams: 120 }, { foodId: 'sweet_potato', grams: 200 }, { foodId: 'spinach', grams: 100 }] },
    { id: 'muscle_3', name: '三文鱼糙米餐', type: 'muscle', tag: '增肌优选💪', say: '优质蛋白配好脂肪，恢复日吃它刚刚好。', items: [{ foodId: 'salmon', grams: 120 }, { foodId: 'brown_rice', grams: 150 }, { foodId: 'spinach', grams: 100 }] },
    { id: 'muscle_4', name: '虾仁面套餐', type: 'muscle', tag: '增肌优选💪', say: '虾仁低脂高蛋白，搭面条好吃又顶饿。', items: [{ foodId: 'shrimp', grams: 120 }, { foodId: 'noodles', grams: 150 }, { foodId: 'cabbage', grams: 120 }] },
    { id: 'muscle_5', name: '鸡腿土豆餐', type: 'muscle', tag: '增肌优选💪', say: '鸡腿肉更香，土豆补碳水，练腿日很合适。', items: [{ foodId: 'chicken_thigh', grams: 150 }, { foodId: 'potato', grams: 180 }, { foodId: 'carrot', grams: 100 }] },

    /* ---------------- 减脂餐 🌿 ---------------- */
    { id: 'cut_1', name: '鸡胸西兰花餐', type: 'fat_loss', tag: '低卡清爽🌿', say: '经典减脂组合，热量低还扛饿。', items: [{ foodId: 'chicken_breast', grams: 100 }, { foodId: 'broccoli', grams: 150 }, { foodId: 'cucumber', grams: 100 }] },
    { id: 'cut_2', name: '龙利鱼轻食', type: 'fat_loss', tag: '低卡清爽🌿', say: '鱼肉细嫩、脂肪低，配蔬菜很清爽。', items: [{ foodId: 'dory', grams: 120 }, { foodId: 'lettuce', grams: 150 }, { foodId: 'tomato', grams: 120 }] },
    { id: 'cut_3', name: '虾仁菠菜餐', type: 'fat_loss', tag: '低卡清爽🌿', say: '高蛋白低脂的一餐，吃完不犯困。', items: [{ foodId: 'shrimp', grams: 100 }, { foodId: 'spinach', grams: 150 }, { foodId: 'tomato', grams: 100 }] },
    { id: 'cut_4', name: '豆腐白菜餐', type: 'fat_loss', tag: '低卡清爽🌿', say: '素净又舒服，晚餐吃它负担小。', items: [{ foodId: 'tofu', grams: 150 }, { foodId: 'cabbage', grams: 150 }, { foodId: 'mushroom', grams: 80 }] },
    { id: 'cut_5', name: '鸡蛋黄瓜餐', type: 'fat_loss', tag: '低卡清爽🌿', say: '简单快手，鸡蛋补蛋白，黄瓜解腻。', items: [{ foodId: 'egg', grams: 100 }, { foodId: 'cucumber', grams: 150 }, { foodId: 'tomato', grams: 100 }] },

    /* ---------------- 塑形餐 ✨ ---------------- */
    { id: 'shape_1', name: '鸡胸藜麦餐', type: 'shape', tag: '塑形轻盈✨', say: '藜麦和鸡胸的搭配，线条感拉满。', items: [{ foodId: 'chicken_breast', grams: 110 }, { foodId: 'quinoa', grams: 150 }, { foodId: 'broccoli', grams: 120 }] },
    { id: 'shape_2', name: '三文鱼糙米餐', type: 'shape', tag: '塑形轻盈✨', say: '好脂肪加慢碳水，吃完状态很稳。', items: [{ foodId: 'salmon', grams: 100 }, { foodId: 'brown_rice', grams: 120 }, { foodId: 'spinach', grams: 120 }] },
    { id: 'shape_3', name: '牛肉红薯餐', type: 'shape', tag: '塑形轻盈✨', say: '牛肉耐饿，红薯清甜，塑形期也能吃好。', items: [{ foodId: 'beef', grams: 100 }, { foodId: 'sweet_potato', grams: 150 }, { foodId: 'lettuce', grams: 120 }] },
    { id: 'shape_4', name: '虾仁玉米餐', type: 'shape', tag: '塑形轻盈✨', say: '颜色好看、口感清爽，减脂塑形都合适。', items: [{ foodId: 'shrimp', grams: 110 }, { foodId: 'corn', grams: 150 }, { foodId: 'cucumber', grams: 100 }] },

    /* ---------------- 素食 🥬 ---------------- */
    { id: 'veg_1', name: '豆腐糙米餐', type: 'vegan', tag: '素食友好🥬', say: '植物蛋白配糙米，素食也能吃得很完整。', items: [{ foodId: 'tofu', grams: 150 }, { foodId: 'brown_rice', grams: 130 }, { foodId: 'broccoli', grams: 120 }] },
    { id: 'veg_2', name: '豆干红薯餐', type: 'vegan', tag: '素食友好🥬', say: '豆干蛋白足，红薯饱腹感强。', items: [{ foodId: 'dried_tofu', grams: 100 }, { foodId: 'sweet_potato', grams: 180 }, { foodId: 'spinach', grams: 120 }] },
    { id: 'veg_3', name: '豆腐藜麦餐', type: 'vegan', tag: '素食友好🥬', say: '藜麦加豆腐，氨基酸组合很棒。', items: [{ foodId: 'tofu', grams: 150 }, { foodId: 'quinoa', grams: 130 }, { foodId: 'tomato', grams: 120 }] },
    { id: 'veg_4', name: '素炒时蔬餐', type: 'vegan', tag: '素食友好🥬', say: '蔬菜多多，清爽不寡淡。', items: [{ foodId: 'tofu', grams: 120 }, { foodId: 'cabbage', grams: 120 }, { foodId: 'green_pepper', grams: 80 }] },

    /* ---------------- 中式家常 🍚 ---------------- */
    { id: 'home_1', name: '西红柿炒蛋盖饭', type: 'homestyle', tag: '中式家常🍚', say: '家常味最治愈，一碗下去很满足。', items: [{ foodId: 'tomato_egg', grams: 150 }, { foodId: 'rice', grams: 150 }, { foodId: 'stir_fried_greens', grams: 120 }] },
    { id: 'home_2', name: '清蒸鱼套餐', type: 'homestyle', tag: '中式家常🍚', say: '清蒸少油，鱼肉鲜嫩，配饭很舒服。', items: [{ foodId: 'steamed_fish', grams: 150 }, { foodId: 'rice', grams: 130 }, { foodId: 'cabbage', grams: 120 }] },
    { id: 'home_3', name: '宫保鸡丁套餐', type: 'homestyle', tag: '中式家常🍚', say: '想吃点有味道的，就选它，记得主食适量。', items: [{ foodId: 'kung_pao_chicken', grams: 150 }, { foodId: 'rice', grams: 130 }, { foodId: 'cucumber', grams: 80 }] },
    { id: 'home_4', name: '麻婆豆腐套餐', type: 'homestyle', tag: '中式家常🍚', say: '下饭神器，配点菠菜平衡一下更好。', items: [{ foodId: 'mapo_tofu', grams: 150 }, { foodId: 'rice', grams: 130 }, { foodId: 'spinach', grams: 100 }] },

    /* ---------------- 快手餐 ⚡ ---------------- */
    { id: 'quick_1', name: '牛奶燕麦香蕉', type: 'quick', tag: '快手省时⚡', say: '三分钟搞定早餐，赶时间也不将就。', items: [{ foodId: 'milk', grams: 250 }, { foodId: 'oats', grams: 40 }, { foodId: 'banana', grams: 100 }] },
    { id: 'quick_2', name: '酸奶莓果面包', type: 'quick', tag: '快手省时⚡', say: '不用开火，酸甜清爽，适合加餐。', items: [{ foodId: 'yogurt', grams: 150 }, { foodId: 'blueberry', grams: 50 }, { foodId: 'whole_bread', grams: 80 }] },
    { id: 'quick_3', name: '豆浆鸡蛋玉米', type: 'quick', tag: '快手省时⚡', say: '中式快手早餐，蛋白和碳水都照顾到。', items: [{ foodId: 'soy_milk', grams: 250 }, { foodId: 'egg', grams: 100 }, { foodId: 'corn', grams: 120 }] }
  ];

  /**
   * 按训练部位配置的三餐方案（纯规则）。
   * 每个部位覆盖早餐 / 午餐 / 晚餐，只存食物 id + 克数，营养运行时计算。
   */
  const PART_MEAL_PLANS = {
    legs: {
      label: '腿部训练日',
      text: '练腿消耗大，碳水蛋白要跟上 💪',
      meals: {
        breakfast: { name: '能量启动早餐', say: '练腿日早餐吃点扎实的，血糖稳、训练更有劲 🌅', items: [{ foodId: 'oats', grams: 50 }, { foodId: 'milk', grams: 250 }, { foodId: 'banana', grams: 100 }] },
        lunch: { name: '主食给足午餐', say: '中午主食别省，下午练腿才不打软 💪', items: [{ foodId: 'chicken_breast', grams: 130 }, { foodId: 'rice', grams: 180 }, { foodId: 'broccoli', grams: 150 }] },
        dinner: { name: '修复晚餐', say: '练完补蛋白和碳水，恢复快一步 🌙', items: [{ foodId: 'beef', grams: 120 }, { foodId: 'sweet_potato', grams: 200 }, { foodId: 'spinach', grams: 120 }] }
      }
    },
    chest_back: {
      label: '胸背训练日',
      text: '大肌群训练日，蛋白质管够 🥩',
      meals: {
        breakfast: { name: '高蛋白早餐', say: '大肌群日，早餐先把蛋白质垫上 🥚', items: [{ foodId: 'egg', grams: 120 }, { foodId: 'whole_bread', grams: 80 }, { foodId: 'milk', grams: 250 }] },
        lunch: { name: '蛋白修复午餐', say: '胸背练完，蛋白质管够才好长 🥩', items: [{ foodId: 'chicken_breast', grams: 150 }, { foodId: 'brown_rice', grams: 150 }, { foodId: 'broccoli', grams: 150 }] },
        dinner: { name: '好脂肪晚餐', say: '好脂肪配优质蛋白，修复更从容 🌙', items: [{ foodId: 'salmon', grams: 120 }, { foodId: 'quinoa', grams: 130 }, { foodId: 'spinach', grams: 120 }] }
      }
    },
    shoulders_arms: {
      label: '肩臂训练日',
      text: '中等强度，营养均衡就好 ⚖️',
      meals: {
        breakfast: { name: '清爽早餐', say: '中等强度日，早餐清爽一点就好 ☀️', items: [{ foodId: 'yogurt', grams: 150 }, { foodId: 'oats', grams: 40 }, { foodId: 'blueberry', grams: 50 }] },
        lunch: { name: '荤素搭配午餐', say: '荤素搭配，下午练肩不乏力 ⚖️', items: [{ foodId: 'chicken_thigh', grams: 130 }, { foodId: 'rice', grams: 150 }, { foodId: 'green_pepper', grams: 80 }] },
        dinner: { name: '轻盈晚餐', say: '清淡一点的晚餐，睡前更舒服 🌙', items: [{ foodId: 'shrimp', grams: 120 }, { foodId: 'corn', grams: 150 }, { foodId: 'cucumber', grams: 100 }] }
      }
    },
    core: {
      label: '核心训练日',
      text: '核心 / 有氧日，清爽高蛋白刚刚好 ✨',
      meals: {
        breakfast: { name: '轻负担早餐', say: '轻强度日，早餐简单又顶饱 🌅', items: [{ foodId: 'soy_milk', grams: 250 }, { foodId: 'egg', grams: 100 }, { foodId: 'corn', grams: 120 }] },
        lunch: { name: '清爽午餐', say: '清爽高蛋白，下午核心训练不犯困 ☀️', items: [{ foodId: 'dory', grams: 120 }, { foodId: 'rice', grams: 130 }, { foodId: 'tomato', grams: 120 }] },
        dinner: { name: '轻盈晚餐', say: '晚餐别太重，给身体留点轻盈感 🌙', items: [{ foodId: 'tofu', grams: 150 }, { foodId: 'sweet_potato', grams: 150 }, { foodId: 'lettuce', grams: 120 }] }
      }
    },
    rest: {
      label: '休息日',
      text: '休息日，给肠胃放个假 🌿',
      meals: {
        breakfast: { name: '温和早餐', say: '休息日早餐温和一点，肠胃更舒服 🌅', items: [{ foodId: 'millet_porridge', grams: 300 }, { foodId: 'egg', grams: 100 }, { foodId: 'apple', grams: 100 }] },
        lunch: { name: '清淡午餐', say: '清淡均衡，休息日也别亏待自己 ☀️', items: [{ foodId: 'steamed_fish', grams: 150 }, { foodId: 'rice', grams: 130 }, { foodId: 'stir_fried_greens', grams: 120 }] },
        dinner: { name: '好消化的晚餐', say: '给肠胃放个假，明天继续加油 🌙', items: [{ foodId: 'tofu', grams: 150 }, { foodId: 'cabbage', grams: 150 }, { foodId: 'mushroom', grams: 80 }] }
      }
    }
  };

  /**
   * 按训练部位生成完整三餐推荐（纯规则）。
   * 训练消耗估算与之前一致：每组约 12 kcal。
   *
   * @param {Object} targets 每日目标
   * @param {{part:string, trained:boolean, sets:number, exercises:number}} [options]
   * @returns {Object} 三餐方案
   */
  function buildPartMealPlan(targets, options) {
    const goal = targets || {};
    const data = options || {};
    const partKey = PART_MEAL_PLANS[data.part] ? data.part : 'shoulders_arms';
    const plan = PART_MEAL_PLANS[partKey];

    const trained = Boolean(data.trained);
    const sets = Math.max(0, Number(data.sets) || 0);
    const exercises = Math.max(0, Number(data.exercises) || 0);
    const effectiveSets = sets > 0 ? sets : (trained ? Math.max(1, exercises) * 3 : 0);
    const burn = trained ? Math.round(effectiveSets * 12) : 0;

    const baseCalories = Math.max(0, Number(goal.calories) || 0);
    const adjustedCalories = baseCalories + burn;

    const mealMeta = {
      breakfast: { label: '早餐', emoji: '🌅' },
      lunch: { label: '午餐', emoji: '☀️' },
      dinner: { label: '晚餐', emoji: '🌙' }
    };

    const meals = ['breakfast', 'lunch', 'dinner'].map(function (key) {
      const config = plan.meals[key] || { name: '', say: '', items: [] };
      const meta = mealMeta[key];

      const items = config.items.map(function (entry) {
        const food = FOOD_LIBRARY.find(function (item) {
          return item.id === entry.foodId;
        });
        if (!food) return null;

        const grams = Math.max(0, Number(entry.grams) || 0);
        const ratio = grams / 100;

        return {
          foodId: food.id,
          name: food.name,
          grams: Math.round(grams),
          calories: Math.round(food.per100g.calories * ratio),
          protein: Math.round(food.per100g.protein * ratio * 10) / 10,
          carbs: Math.round(food.per100g.carbs * ratio * 10) / 10,
          fat: Math.round(food.per100g.fat * ratio * 10) / 10
        };
      }).filter(Boolean);

      const totals = items.reduce(function (sum, item) {
        sum.calories += item.calories;
        sum.protein += item.protein;
        sum.carbs += item.carbs;
        sum.fat += item.fat;
        return sum;
      }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

      totals.calories = Math.round(totals.calories);
      totals.protein = Math.round(totals.protein * 10) / 10;
      totals.carbs = Math.round(totals.carbs * 10) / 10;
      totals.fat = Math.round(totals.fat * 10) / 10;

      return {
        key: key,
        label: meta.label,
        emoji: meta.emoji,
        name: config.name,
        say: config.say,
        items: items,
        totals: totals
      };
    }).filter(function (meal) {
      return meal.items.length > 0;
    });

    return {
      part: partKey,
      partLabel: plan.label,
      trained: trained,
      burn: burn,
      sets: effectiveSets,
      baseCalories: baseCalories,
      adjustedCalories: adjustedCalories,
      title: '🍽️ ' + plan.label + '三餐',
      text: plan.text,
      meals: meals
    };
  }

  /**
   * 计算食物清单的热量、三大营养素与供能占比。
   *
   * @param {{foodId?:string, name?:string, grams:number}[]} items 食物与分量
   * @returns {{items:Object[], totals:Object, percent:Object}}
   */
  function calcFoodItems(items) {
    const list = Array.isArray(items) ? items : [];

    const computed = list.map(function (entry) {
      const food = FOOD_LIBRARY.find(function (item) {
        return item.id === entry.foodId || item.name === entry.name;
      });
      if (!food) return null;

      const grams = App.clampNumber(entry.grams, 0, 5000, 0);
      const ratio = grams / 100;

      return {
        id: food.id,
        name: food.name,
        category: food.category,
        grams: Math.round(grams * 10) / 10,
        calories: Math.round(food.per100g.calories * ratio),
        protein: Math.round(food.per100g.protein * ratio * 10) / 10,
        carbs: Math.round(food.per100g.carbs * ratio * 10) / 10,
        fat: Math.round(food.per100g.fat * ratio * 10) / 10
      };
    }).filter(Boolean);

    const totals = computed.reduce(function (sum, item) {
      sum.calories += item.calories;
      sum.protein += item.protein;
      sum.carbs += item.carbs;
      sum.fat += item.fat;
      return sum;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

    totals.calories = Math.round(totals.calories);
    totals.protein = Math.round(totals.protein * 10) / 10;
    totals.carbs = Math.round(totals.carbs * 10) / 10;
    totals.fat = Math.round(totals.fat * 10) / 10;

    // 供能占比：蛋白质 4 kcal/g、碳水 4 kcal/g、脂肪 9 kcal/g
    const energy = totals.protein * 4 + totals.carbs * 4 + totals.fat * 9;
    const percent = {
      protein: energy > 0 ? Math.round((totals.protein * 4 / energy) * 1000) / 10 : 0,
      carbs: energy > 0 ? Math.round((totals.carbs * 4 / energy) * 1000) / 10 : 0,
      fat: energy > 0 ? Math.round((totals.fat * 9 / energy) * 1000) / 10 : 0
    };

    return { items: computed, totals: totals, percent: percent };
  }

  /** 食物是否匹配关键字：名称或别名包含关键字 */
  function matchFood(food, keyword) {
    if (!keyword) return true;
    if (String(food.name).indexOf(keyword) >= 0) return true;
    const aliases = food.aliases || [];
    return aliases.some(function (alias) {
      return String(alias).indexOf(keyword) >= 0;
    });
  }

  /**
   * 按关键字搜索食物，供饮食记录页的搜索列表使用。
   * 空关键字返回列表前若干项，帮助用户快速挑选常见食物。
   *
   * @param {string} keyword 搜索词
   * @param {number} [limit=20] 最多返回条数
   * @returns {Object[]} 食物列表
   */
  function searchFoods(keyword, limit) {
    const text = String(keyword === null || keyword === undefined ? '' : keyword).trim();
    const max = Math.max(1, Math.min(60, Number(limit) || 20));

    if (!text) return FOOD_LIBRARY.slice(0, max);

    return FOOD_LIBRARY.filter(function (food) {
      return matchFood(food, text);
    }).slice(0, max);
  }

  /**
   * 按名称查找食物：精确 → 别名精确 → 前缀 → 包含 → 反向包含。
   * 例："鸡胸" → 鸡胸肉；"西红柿" → 番茄。
   *
   * @param {string} name 用户输入的食物名称
   * @returns {Object|null}
   */
  function findFoodByName(name) {
    const text = String(name === null || name === undefined ? '' : name).trim();
    if (!text) return null;

    const exact = FOOD_LIBRARY.find(function (item) {
      return item.name === text || (item.aliases || []).indexOf(text) >= 0;
    });
    if (exact) return exact;

    const prefix = FOOD_LIBRARY.find(function (item) {
      if (item.name.indexOf(text) === 0) return true;
      return (item.aliases || []).some(function (alias) {
        return String(alias).indexOf(text) === 0;
      });
    });
    if (prefix) return prefix;

    const partial = FOOD_LIBRARY.find(function (item) {
      return matchFood(item, text);
    });
    if (partial) return partial;

    return FOOD_LIBRARY.find(function (item) {
      if (text.indexOf(item.name) >= 0) return true;
      return (item.aliases || []).some(function (alias) {
        return text.indexOf(alias) >= 0;
      });
    }) || null;
  }

  /**
   * 对照每日目标评估当前摄入，生成剩余额度与提醒。
   *
   * @param {{calories:number, protein:number, carbs:number, fat:number}} totals 已摄入
   * @param {{calories:number, protein:number, carbs:number, fat:number}} targets 每日目标
   * @returns {Object} 含各项进度与最多 3 条提醒
   */
  function evaluateIntake(totals, targets) {
    const eaten = totals || {};
    const goal = targets || {};

    function buildItem(key, label, unit) {
      const targetValue = Math.max(0, Number(goal[key]) || 0);
      const eatenValue = Math.max(0, Number(eaten[key]) || 0);
      const percent = targetValue > 0
        ? Math.round((eatenValue / targetValue) * 1000) / 10
        : 0;

      return {
        key: key,
        label: label,
        unit: unit,
        target: Math.round(targetValue * 10) / 10,
        eaten: Math.round(eatenValue * 10) / 10,
        remaining: Math.max(0, Math.round((targetValue - eatenValue) * 10) / 10),
        percent: percent,
        over: targetValue > 0 && eatenValue > targetValue
      };
    }

    const calories = buildItem('calories', '热量', 'kcal');
    const protein = buildItem('protein', '蛋白质', 'g');
    const carbs = buildItem('carbs', '碳水', 'g');
    const fat = buildItem('fat', '脂肪', 'g');

    const alerts = [];

    [protein, carbs, fat].forEach(function (item) {
      if (!item.target) return;
      if (item.percent >= 100) {
        alerts.push({
          key: item.key,
          level: 'over',
          text: item.label + '已超过今日目标（' + item.eaten + '/' + item.target + ' g）'
        });
      } else if (item.percent >= 90) {
        alerts.push({
          key: item.key,
          level: 'near',
          text: item.label + '已达今日目标 ' + item.percent + '%'
        });
      }
    });

    if (calories.target) {
      if (calories.percent >= 100) {
        alerts.push({
          key: 'calories',
          level: 'over',
          text: '今日热量已超过目标（' + calories.eaten + '/' + calories.target + ' kcal）'
        });
      } else if (calories.percent >= 90) {
        alerts.push({
          key: 'calories',
          level: 'near',
          text: '今日热量已达目标 ' + calories.percent + '%'
        });
      }
    }

    // 热量超标 > 其他营养素超标 > 接近目标
    function alertWeight(item) {
      if (item.level === 'over') return item.key === 'calories' ? 0 : 1;
      return 2;
    }

    alerts.sort(function (a, b) {
      return alertWeight(a) - alertWeight(b);
    });

    return {
      calories: calories,
      protein: protein,
      carbs: carbs,
      fat: fat,
      alerts: alerts.slice(0, 3)
    };
  }

  /**
   * 下一餐建议（纯规则）：先看哪个营养素缺口最大，再从内置食物库挑合适的食物与分量。
   * 某营养素已达标时，提醒下一餐相应减量。
   *
   * @param {Object} totals 今日已摄入
   * @param {Object} targets 每日目标
   * @param {{mealType:string}} [options] 当前餐次
   * @returns {{meal:Object, nutrient:string, text:string, foods:Object[]}}
   */
  function suggestNextMeal(totals, targets, options) {
    const eaten = totals || {};
    const goal = targets || {};
    const mealKey = options && options.mealType ? options.mealType : 'lunch';

    const meals = [
      { key: 'breakfast', label: '早餐', emoji: '🌅' },
      { key: 'lunch', label: '午餐', emoji: '☀️' },
      { key: 'dinner', label: '晚餐', emoji: '🌙' },
      { key: 'snack', label: '加餐', emoji: '🍪' }
    ];

    const index = meals.findIndex(function (item) {
      return item.key === mealKey;
    });
    const next = index >= 0 && index < meals.length - 1
      ? meals[index + 1]
      : { key: 'breakfast', label: '明天早餐', emoji: '🌅' };

    const nutrients = [
      { key: 'protein', label: '蛋白质', emoji: '🥩', foods: ['chicken_breast', 'egg', 'pork_lean', 'fish'] },
      { key: 'carbs', label: '碳水', emoji: '🍚', foods: ['rice', 'sweet_potato', 'noodles', 'oats'] },
      { key: 'fat', label: '脂肪', emoji: '🥑', foods: ['avocado', 'almond', 'walnut'] }
    ];

    const gaps = nutrients.map(function (item) {
      const target = Math.max(0, Number(goal[item.key]) || 0);
      const value = Math.max(0, Number(eaten[item.key]) || 0);

      return {
        key: item.key,
        label: item.label,
        emoji: item.emoji,
        foods: item.foods,
        target: target,
        eaten: value,
        percent: target > 0 ? (value / target) * 100 : 0
      };
    });

    // 已有营养素达标：优先提醒下一餐减量
    const reached = gaps.filter(function (item) {
      return item.target > 0 && item.percent >= 100;
    });

    if (reached.length) {
      const item = reached[0];
      return {
        meal: next,
        nutrient: item.key,
        text: '今天的' + item.label + '已经达标啦（约 ' + Math.round(item.percent) + '%），' +
          next.label + (item.key === 'carbs' ? '主食可以减半' : '别再堆同类食物') +
          '，把胃口留给蔬菜和蛋白质 ' + item.emoji,
        foods: []
      };
    }

    const gap = gaps.slice().sort(function (a, b) {
      return a.percent - b.percent;
    })[0];

    if (!gap || gap.target <= 0) {
      return { meal: next, nutrient: '', text: '', foods: [] };
    }

    const picks = gap.foods.map(function (id) {
      return FOOD_LIBRARY.find(function (food) {
        return food.id === id;
      });
    }).filter(Boolean).slice(0, 2);

    const descriptions = picks.map(function (food) {
      const perGram = food.per100g[gap.key] / 100;
      const rest = Math.max(0, gap.target - gap.eaten);
      const grams = perGram > 0
        ? Math.max(50, Math.min(300, Math.round((rest * 0.5) / perGram / 10) * 10))
        : 100;
      return food.name + ' 约 ' + grams + ' g';
    });

    return {
      meal: next,
      nutrient: gap.key,
      text: next.label + gap.label + '还差不少哦，' +
        (descriptions.length
          ? '可以试试 ' + descriptions.join(' 或 ')
          : '多补一点优质蛋白') +
        ' ' + gap.emoji,
      foods: picks.map(function (food) {
        return { id: food.id, name: food.name };
      })
    };
  }

  /**
   * 每日饮食报告（纯规则）：热量 / 营养素进度、饮水评价、三餐分配与温暖总评。
   *
   * @param {Object} input { totals, targets, water, waterTarget, mealCalories, date }
   * @returns {Object} 报告数据
   */
  function buildDailyDietReport(input) {
    const data = input || {};
    const totals = data.totals || {};
    const targets = data.targets || {};
    const water = Math.max(0, Number(data.water) || 0);
    const waterTarget = Math.max(1, Number(data.waterTarget) || 2000);
    const mealCalories = data.mealCalories || {};

    const calories = Math.max(0, Number(totals.calories) || 0);
    const caloriesTarget = Math.max(0, Number(targets.calories) || 0);
    const caloriePercent = caloriesTarget > 0
      ? Math.round((calories / caloriesTarget) * 100)
      : 0;
    const proteinPercent = Number(targets.protein) > 0
      ? Math.round((Number(totals.protein || 0) / Number(targets.protein)) * 100)
      : 0;

    const waterPercent = Math.round((water / waterTarget) * 100);
    const waterOk = water >= waterTarget;

    const breakfast = Number(mealCalories.breakfast) || 0;
    const lunch = Number(mealCalories.lunch) || 0;
    const dinner = Number(mealCalories.dinner) || 0;
    const snack = Number(mealCalories.snack) || 0;
    const totalMeal = breakfast + lunch + dinner + snack;

    function share(value) {
      return totalMeal > 0 ? Math.round((value / totalMeal) * 100) : 0;
    }

    const breakfastShare = share(breakfast);
    const dinnerShare = share(dinner);

    let allocationText = '三餐分配比较均衡，继续保持这个节奏 🌿';
    if (dinnerShare >= 42) {
      allocationText = '晚餐占比偏高（约 ' + dinnerShare + '%），明天可以早餐多吃一点 🌅';
    } else if (breakfastShare > 0 && breakfastShare < 15) {
      allocationText = '早餐吃得有点少（约 ' + breakfastShare + '%），上午容易没精神，' +
        '明天加个鸡蛋或一杯奶 🥚';
    } else if (totalMeal > 0 && breakfastShare >= 25 && dinnerShare <= 35) {
      allocationText = '早餐和午餐分担得不错，晚餐也克制，分配很舒服 👏';
    }

    let comment = '';
    if (caloriePercent < 60) {
      comment = '今天吃得偏少，别把自己饿着，加点优质蛋白和主食会更稳 🍚';
    } else if (caloriePercent > 110) {
      comment = '今天热量稍微超了一点，明天主食收一收、多走几步就好，不用自责 🌿';
    } else if (proteinPercent < 70) {
      comment = '热量控制得不错，蛋白质还可以再补一补，明天加份鸡胸或鸡蛋吧 🥩';
    } else {
      comment = '今天整体完成得挺好，热量和蛋白质都在轨道上，保持这个感觉 ✨';
    }

    return {
      date: data.date || '',
      totals: totals,
      targets: targets,
      calories: calories,
      caloriesTarget: caloriesTarget,
      caloriePercent: caloriePercent,
      proteinPercent: proteinPercent,
      water: water,
      waterTarget: waterTarget,
      waterPercent: waterPercent,
      waterOk: waterOk,
      mealCalories: mealCalories,
      mealShare: {
        breakfast: breakfastShare,
        lunch: share(lunch),
        dinner: dinnerShare,
        snack: share(snack)
      },
      allocationText: allocationText,
      comment: comment,
      advice: (waterOk
        ? '喝水达标，做得很好 💧'
        : '今天水喝得有点少，明天记得随手补水 💧') + ' ' + allocationText
    };
  }

  /**
   * 今日推荐食谱（纯规则）。
   * 已训练时按每组约 12 kcal 估算消耗，加到每日目标热量上；
   * 再按蛋白质 / 碳水目标比例从内置食物库搭配 1~2 份套餐。
   *
   * @param {Object} targets 每日目标
   * @param {{trained:boolean, sets:number, exercises:number, reps:number}} [options]
   * @returns {Object} 推荐结果
   */
  function buildRecommendedMeals(targets, options) {
    const goal = targets || {};
    const data = options || {};
    const trained = Boolean(data.trained);

    const sets = Math.max(0, Number(data.sets) || 0);
    const exercises = Math.max(0, Number(data.exercises) || 0);
    const reps = Math.max(0, Number(data.reps) || 0);

    // 每组约 10~15 kcal，取中值 12；只有打卡没有明细时按 3 组/动作估算
    const effectiveSets = sets > 0 ? sets : (trained ? Math.max(1, exercises) * 3 : 0);
    const burn = trained ? Math.round(effectiveSets * 12) : 0;

    const baseCalories = Math.max(0, Number(goal.calories) || 0);
    const adjustedCalories = baseCalories + burn;
    const proteinGoal = Math.max(0, Number(goal.protein) || 0);
    const carbsGoal = Math.max(0, Number(goal.carbs) || 0);

    const findFood = function (id) {
      return FOOD_LIBRARY.find(function (item) {
        return item.id === id;
      }) || null;
    };

    const clamp = function (value, min, max) {
      return Math.max(min, Math.min(max, Math.round(value)));
    };

    /** 用「蛋白源 + 主食 + 蔬菜」组合出一份套餐 */
    const buildMeal = function (name, proteinId, carbId, vegId, ratio) {
      const proteinFood = findFood(proteinId);
      const carbFood = findFood(carbId);
      const vegFood = findFood(vegId);
      const items = [];

      if (proteinFood) {
        const grams = clamp(
          (proteinGoal * ratio) / (proteinFood.per100g.protein / 100),
          80, 220
        );
        items.push({
          foodId: proteinFood.id,
          name: proteinFood.name,
          grams: grams,
          calories: Math.round(proteinFood.per100g.calories * grams / 100),
          protein: Math.round(proteinFood.per100g.protein * grams / 10) / 10,
          carbs: Math.round(proteinFood.per100g.carbs * grams / 10) / 10,
          fat: Math.round(proteinFood.per100g.fat * grams / 10) / 10
        });
      }

      if (carbFood) {
        const grams = clamp(
          (carbsGoal * ratio) / (carbFood.per100g.carbs / 100),
          60, 250
        );
        items.push({
          foodId: carbFood.id,
          name: carbFood.name,
          grams: grams,
          calories: Math.round(carbFood.per100g.calories * grams / 100),
          protein: Math.round(carbFood.per100g.protein * grams / 10) / 10,
          carbs: Math.round(carbFood.per100g.carbs * grams / 10) / 10,
          fat: Math.round(carbFood.per100g.fat * grams / 10) / 10
        });
      }

      if (vegFood) {
        const grams = 150;
        items.push({
          foodId: vegFood.id,
          name: vegFood.name,
          grams: grams,
          calories: Math.round(vegFood.per100g.calories * grams / 100),
          protein: Math.round(vegFood.per100g.protein * grams / 10) / 10,
          carbs: Math.round(vegFood.per100g.carbs * grams / 10) / 10,
          fat: Math.round(vegFood.per100g.fat * grams / 10) / 10
        });
      }

      const totals = items.reduce(function (sum, item) {
        sum.calories += item.calories;
        sum.protein += item.protein;
        sum.carbs += item.carbs;
        sum.fat += item.fat;
        return sum;
      }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

      totals.calories = Math.round(totals.calories);
      totals.protein = Math.round(totals.protein * 10) / 10;
      totals.carbs = Math.round(totals.carbs * 10) / 10;
      totals.fat = Math.round(totals.fat * 10) / 10;

      return { name: name, items: items, totals: totals };
    };

    /* 按用户目标与今日训练状态筛选食谱，再随机抽 1~2 套 */
    const goalTypeMap = {
      build_muscle: 'muscle',
      lose_fat: 'fat_loss',
      body_shape: 'shape'
    };
    const goalType = goalTypeMap[String(data.goal || '')] || '';

    const wantedTypes = [];
    if (goalType) wantedTypes.push(goalType);
    wantedTypes.push(trained ? 'muscle' : 'fat_loss');
    if (!trained) wantedTypes.push('vegan');

    let pool = RECIPE_LIBRARY.filter(function (recipe) {
      return wantedTypes.indexOf(recipe.type) >= 0;
    });
    if (!pool.length) pool = RECIPE_LIBRARY.slice();

    // 训练日抽 2 套、休息日抽 1 套，尽量不与上次重复
    const wantedCount = Math.min(trained ? 2 : 1, pool.length);
    const picked = [];
    const candidates = pool.slice();

    while (picked.length < wantedCount && candidates.length) {
      picked.push(candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0]);
    }

    // 按食物库计算每套食谱的实际营养
    const meals = picked.map(function (recipe) {
      const items = recipe.items.map(function (entry) {
        const food = findFood(entry.foodId);
        if (!food) return null;

        const grams = Math.max(0, Number(entry.grams) || 0);
        const ratio = grams / 100;

        return {
          foodId: food.id,
          name: food.name,
          grams: Math.round(grams * 10) / 10,
          calories: Math.round(food.per100g.calories * ratio),
          protein: Math.round(food.per100g.protein * ratio * 10) / 10,
          carbs: Math.round(food.per100g.carbs * ratio * 10) / 10,
          fat: Math.round(food.per100g.fat * ratio * 10) / 10
        };
      }).filter(Boolean);

      const totals = items.reduce(function (sum, item) {
        sum.calories += item.calories;
        sum.protein += item.protein;
        sum.carbs += item.carbs;
        sum.fat += item.fat;
        return sum;
      }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

      totals.calories = Math.round(totals.calories);
      totals.protein = Math.round(totals.protein * 10) / 10;
      totals.carbs = Math.round(totals.carbs * 10) / 10;
      totals.fat = Math.round(totals.fat * 10) / 10;

      return {
        name: recipe.name,
        tag: recipe.tag,
        say: recipe.say,
        type: recipe.type,
        items: items,
        totals: totals
      };
    }).filter(function (meal) {
      return meal.items.length > 0;
    });

    return {
      trained: trained,
      burn: burn,
      sets: effectiveSets,
      exercises: exercises,
      reps: reps,
      baseCalories: baseCalories,
      adjustedCalories: adjustedCalories,
      title: trained ? '💪 训练日推荐' : '🌿 休息日推荐',
      text: trained
        ? '今天练得不错，多补充点优质蛋白 💪'
        : '今天是休息日，清淡均衡为主 🌿',
      meals: meals
    };
  }

  /** 暴露核心实现，方便单测与直接调用 */
  dietAgent.generateDiet = generateDiet;
  dietAgent.calcFoodItems = calcFoodItems;
  dietAgent.findFoodByName = findFoodByName;
  dietAgent.searchFoods = searchFoods;
  dietAgent.evaluateIntake = evaluateIntake;
  dietAgent.suggestNextMeal = suggestNextMeal;
  dietAgent.buildDailyDietReport = buildDailyDietReport;
  dietAgent.buildRecommendedMeals = buildRecommendedMeals;
  dietAgent.buildPartMealPlan = buildPartMealPlan;
  dietAgent.FOOD_LIBRARY = FOOD_LIBRARY;
  App.generateDiet = generateDiet;
  App.foodLibrary = FOOD_LIBRARY;
  App.calcFoodItems = calcFoodItems;
  App.findFoodByName = findFoodByName;
  App.searchFoods = searchFoods;
  App.evaluateIntake = evaluateIntake;
  App.suggestNextMeal = suggestNextMeal;
  App.buildDailyDietReport = buildDailyDietReport;
  App.buildRecommendedMeals = buildRecommendedMeals;
  App.buildPartMealPlan = buildPartMealPlan;
  App.dietAgent = dietAgent;
})(window);