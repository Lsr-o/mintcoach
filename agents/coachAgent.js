/**
 * ============================================================================
 * agents/coachAgent.js —— 教练总控 Agent（真实调度）
 * ----------------------------------------------------------------------------
 * 职责：
 *   接收用户信息，按依赖顺序调度训练计划 Agent 与营养饮食 Agent，
 *   把两份结果汇总后返回。页面只调用总控，不直接拼装子 Agent。
 *
 * 核心函数：
 *   generateAll(userInfo) —— ① generatePlan(userInfo) 生成训练计划
 *                            ② generateDiet(userInfo, 训练计划) 生成饮食建议
 *                            ③ 返回 { trainingPlan, nutritionPlan }
 *
 * 兼容入口：
 *   coachAgent(profile, options) —— 返回 Promise<CoachingResult>，供首页生成方案
 *   coachAgent.regenerate(...)   —— 局部重新生成，供答疑场景使用
 *
 * 调度流程：
 *   ① 归一化用户档案（contract.js 的 normalizeUserProfile）
 *   ② 调用训练计划 Agent（内部调用 generatePlan）
 *   ③ 把训练计划作为 generateDiet 的第二个入参
 *      —— 营养 Agent 需要知道训练日 / 休息日分布，才能算出两天的热量差异
 *   ④ 汇总结果、记录失败降级信息、返回
 *
 * 子 Agent 失败时的降级策略：
 *   某一项失败不抛错，对应字段置 null，并写入 errors；
 *   训练计划失败时，营养方案会退化为按用户填写的每周训练天数估算。
 * ============================================================================
 */
(function (global) {
  'use strict';

  const App = (global.FitnessApp = global.FitnessApp || {});

  /** 调度顺序：训练计划必须先生成，营养方案依赖它的训练日分布 */
  const DISPATCH_ORDER = ['trainingAgent', 'dietAgent'];

  /** 把任意异常转成可读文案 */
  function toErrorMessage(reason) {
    if (!reason) return '未知错误';
    if (typeof reason === 'string') return reason;
    return reason.message || String(reason);
  }

  /**
   * 调用训练计划 Agent 的核心能力。
   * 优先使用 generatePlan，保证「总控 → 子 Agent」的调用关系稳定。
   *
   * @param {Object} userInfo
   * @returns {Promise<TrainingPlan>}
   */
  async function runGeneratePlan(userInfo) {
    if (typeof App.generatePlan === 'function') {
      return await App.generatePlan(userInfo);
    }
    if (App.trainingAgent && typeof App.trainingAgent.generatePlan === 'function') {
      return await App.trainingAgent.generatePlan(userInfo);
    }
    if (typeof App.trainingAgent === 'function') {
      // 兜底：兼容只注册了异步入口的情况
      return await App.trainingAgent(userInfo);
    }
    throw new Error('trainingAgent 未加载');
  }

  /**
   * 调用营养饮食 Agent 的核心能力。
   * 第二个参数必须传训练计划，训练日/休息日热量才能算准。
   *
   * @param {Object} userInfo
   * @param {TrainingPlan} plan
   * @returns {Promise<NutritionPlan>}
   */
  async function runGenerateDiet(userInfo, plan) {
    if (typeof App.generateDiet === 'function') {
      return await App.generateDiet(userInfo, plan);
    }
    if (App.dietAgent && typeof App.dietAgent.generateDiet === 'function') {
      return await App.dietAgent.generateDiet(userInfo, plan);
    }
    if (typeof App.dietAgent === 'function') {
      return await App.dietAgent(userInfo, { plan: plan });
    }
    throw new Error('dietAgent 未加载');
  }

  /**
   * 生成完整方案（真实调度核心）。
   *
   * 流程：
   *   ① 训练计划：generatePlan(userInfo)
   *   ② 饮食建议：generateDiet(userInfo, 训练计划)
   *   ③ 返回 { trainingPlan, nutritionPlan }
   *
   * @param {Object} userInfo 用户信息（支持中英文字段）
   * @returns {Promise<{trainingPlan:Object, nutritionPlan:Object}>}
   */
  async function generateAll(userInfo) {
    // 归一化档案，保证两个子 Agent 收到一致的数据结构
    const user = App.normalizeUserProfile(userInfo);

    // ① 训练计划 Agent
    const trainingPlan = await runGeneratePlan(user);

    // ② 营养饮食 Agent：把训练计划原样传进去
    const nutritionPlan = await runGenerateDiet(user, trainingPlan);

    // ③ 汇总返回
    return {
      trainingPlan: trainingPlan,
      nutritionPlan: nutritionPlan
    };
  }

  /**
   * 教练总控 Agent 主入口（兼容既有页面）。
   * 与 generateAll 使用同一套底层调用，但保留分项失败降级。
   *
   * @param {UserProfile} profile 用户档案
   * @param {Object} [options] 预留参数
   * @returns {Promise<CoachingResult>}
   */
  async function coachAgent(profile, options = {}) {
    const startedAt = Date.now();

    // ① 归一化用户档案
    const user = App.normalizeUserProfile(profile);

    const output = { trainingPlan: null, nutritionPlan: null };
    const errors = [];

    // ② 训练计划 Agent：失败时记录并继续
    try {
      output.trainingPlan = await runGeneratePlan(user);
    } catch (error) {
      errors.push({ agent: 'trainingAgent', message: toErrorMessage(error) });
    }

    // ③ 营养饮食 Agent：依赖训练计划，失败同样降级
    try {
      output.nutritionPlan = await runGenerateDiet(user, output.trainingPlan);
    } catch (error) {
      errors.push({ agent: 'dietAgent', message: toErrorMessage(error) });
    }

    // ④ 返回统一的 CoachingResult
    return {
      planId: App.newId('plan'),
      profile: user,
      trainingPlan: output.trainingPlan,
      nutritionPlan: output.nutritionPlan,
      errors: errors,
      elapsedMs: Date.now() - startedAt,
      _meta: App.createMeta('coachAgent', {
        dispatcher: DISPATCH_ORDER,
        mode: 'sequential'
      })
    };
  }

  /**
   * 局部重新生成（供答疑场景使用）。
   * 只重跑 parts 中指定的子 Agent，未指定的部分沿用 current 中的旧结果。
   * 训练与营养保持依赖顺序：先训练，再营养。
   *
   * @param {UserProfile} profile 用户档案
   * @param {('training'|'diet')[]} [parts] 需要重跑的部分
   * @param {Object} [options] { current: CoachingResult }
   * @returns {Promise<CoachingResult>}
   */
  coachAgent.regenerate = async function regenerate(
    profile,
    parts = ['training', 'diet'],
    options = {}
  ) {
    const startedAt = Date.now();
    const user = App.normalizeUserProfile(profile);
    const current = options.current || {};
    const targets = new Set(parts);
    const errors = [];

    // 未指定重跑的部分，直接复用上一次的结果
    let trainingPlan = current.trainingPlan || null;
    let nutritionPlan = current.nutritionPlan || null;

    if (targets.has('training')) {
      try {
        trainingPlan = await runGeneratePlan(user);
      } catch (error) {
        errors.push({ agent: 'trainingAgent', message: toErrorMessage(error) });
      }
    }

    if (targets.has('diet')) {
      try {
        nutritionPlan = await runGenerateDiet(user, trainingPlan);
      } catch (error) {
        errors.push({ agent: 'dietAgent', message: toErrorMessage(error) });
      }
    }

    return {
      planId: current.planId || App.newId('plan'),
      profile: user,
      trainingPlan: trainingPlan,
      nutritionPlan: nutritionPlan,
      errors: errors,
      regenerated: Array.from(targets),
      elapsedMs: Date.now() - startedAt,
      _meta: App.createMeta('coachAgent', { mode: 'regenerate' })
    };
  };

  /** 暴露核心调度函数与顺序，方便页面 / 调试直接使用 */
  coachAgent.generateAll = generateAll;
  coachAgent.runGeneratePlan = runGeneratePlan;
  coachAgent.runGenerateDiet = runGenerateDiet;
  coachAgent.DISPATCH_ORDER = DISPATCH_ORDER;

  App.generateAll = generateAll;
  App.coachAgent = coachAgent;
})(window);