/**
 * ============================================================================
 * js/main.js —— 页面交互层
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 顶部 Tab 切换（hash 路由，手机返回键可用）
 *   2. 首页收集用户信息 → 调用 coachAgent → 渲染汇总结果
 *   3. 各页面调用对应 Agent：postureAgent / reviewAgent / qaAgent
 *   4. localStorage 持久化档案、方案与复盘记录
 *
 * 注意：本文件不写业务逻辑，所有业务都委托给 window.FitnessApp 下的 Agent。
 * ============================================================================
 */
(function () {
  'use strict';

  const App = window.FitnessApp || {};
  /** 旧版单用户存储键，仅用于首次升级时迁移 */
  const LEGACY_STORAGE_KEY = 'ai_fitness_coach_state_v1';
  /** 统一存储层（多用户隔离） */
  const store = App.storage || null;
  /** 首次使用引导的已读标记，避免每次打开都弹窗 */
  const INTRO_KEY = 'ai_fitness_coach_intro_v1';
  /** 训练前安全提示的已确认标记 */
  const SAFETY_KEY = 'ai_fitness_coach_safety_v1';
  const VALID_TABS = ['home', 'training', 'review', 'diet', 'calendar', 'science', 'about'];
  const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const INTENSITY_LABEL = { low: '低强度', medium: '中等强度', high: '高强度' };

  /** 饮食餐次分区 */
  const MEALS = [
    { key: 'breakfast', label: '早餐', emoji: '🌅' },
    { key: 'lunch', label: '午餐', emoji: '☀️' },
    { key: 'dinner', label: '晚餐', emoji: '🌙' },
    { key: 'snack', label: '加餐', emoji: '🍪' }
  ];
  /** 喝水目标与单次增量 */
  const WATER_TARGET = 2000;
  const WATER_STEP = 250;

  /** 按时间推断当前餐次 */
  function guessMeal() {
    const hour = new Date().getHours();
    if (hour < 10) return 'breakfast';
    if (hour < 15) return 'lunch';
    if (hour < 21) return 'dinner';
    return 'snack';
  }

  const state = {
    profile: null,
    coaching: null,
    lastReview: null,
    reviewHistory: [],
    checkins: [],
    /** 累计打卡次数（不受最近 60 条裁剪影响），用于里程碑成就 */
    totalCheckins: 0,
    /** 高频易错动作累计：{ 动作名: 纠正次数 } */
    correctionStats: {},
    trainingSessions: [],
    dietLogs: {},
    /** 每日喝水记录：{ 'YYYY-MM-DD': ml } */
    waterLogs: {},
    /** 每日饮食报告：{ 'YYYY-MM-DD': report } */
    dietReports: {},
    dietDraft: {
      items: [],
      photo: null,
      selectedFood: null,
      keyword: '',
      /** 当前餐次：breakfast / lunch / dinner / snack */
      meal: 'lunch'
    },
    calendarSelected: null,
    /** 本周计划列表当前展开的星期索引（null 表示全部收起） */
    weekPlanOpen: null,
    postureSession: null,
    /** 是否处于「添加新用户」的录入态（不持久化，避免影响已登录用户） */
    addingUser: false
  };

  /* ============================ 通用工具 ============================ */

  function $(selector) {
    return document.querySelector(selector);
  }

  function $$(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  /** HTML 转义，所有用户输入渲染前必须经过它 */
  function esc(value) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return String(value === null || value === undefined ? '' : value).replace(
      /[&<>"']/g,
      (ch) => map[ch]
    );
  }

  /**
   * 动作部位 emoji 规则（配置驱动，按名称关键词匹配）。
   * 新增动作时只需补充关键词，无需改动渲染逻辑。
   */
  const EXERCISE_EMOJI_RULES = [
    { keys: ['深蹲', '弓步', '腿举', '腿弯举', '提踵', '臀桥', '硬拉'], emoji: '🦵' },
    { keys: ['卧推', '推举', '划船', '下拉', '飞鸟', '弯举', '臂屈伸', '俯卧撑'], emoji: '🦾' },
    { keys: ['平板', '卷腹', '核心', '支撑'], emoji: '🧘' },
    { keys: ['开合跳', '跳绳', '波比'], emoji: '⚡' },
    { keys: ['跑', '骑', '有氧', '椭圆', '划船机'], emoji: '🏃' },
    { keys: ['拉伸', '放松', '热身'], emoji: '🌿' }
  ];

  /** 按动作名取部位 emoji，未匹配时用通用杠铃 */
  function exerciseEmoji(name) {
    const text = String(name || '');
    const rule = EXERCISE_EMOJI_RULES.find(function (item) {
      return item.keys.some(function (key) {
        return text.indexOf(key) >= 0;
      });
    });
    return rule ? rule.emoji : '🏋️';
  }

  /** 营养素 emoji：热量 / 蛋白质 / 碳水 / 脂肪 */
  const NUTRIENT_EMOJI = { calories: '🔥', protein: '🥩', carbs: '🍚', fat: '🥑' };

  function nutrientEmoji(key) {
    return NUTRIENT_EMOJI[key] || '✨';
  }

  function pad(num) {
    return String(num).padStart(2, '0');
  }

  function todayStr() {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function toPositiveNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : undefined;
  }

  let toastTimer = null;

  function showToast(message, duration) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove('is-show');
    }, duration || 2800);
  }

  let confettiTimer = null;

  /** 页面中央飘落 emoji 彩带：动画走纯 CSS，2 秒后自动清理 */
  function celebrateConfetti() {
    const layer = $('#confetti-layer');
    if (!layer) return;

    const emojis = ['🎉', '✨', '🎊'];
    const pieces = [];

    for (let i = 0; i < 18; i += 1) {
      pieces.push(
        '<span class="confetti-piece" style="' +
          'left:' + (5 + Math.random() * 90).toFixed(1) + '%;' +
          'font-size:' + (14 + Math.random() * 12).toFixed(0) + 'px;' +
          'animation-delay:' + (Math.random() * 0.35).toFixed(2) + 's;' +
          'animation-duration:' + (1.5 + Math.random() * 0.5).toFixed(2) + 's">' +
          emojis[i % emojis.length] +
        '</span>'
      );
    }

    layer.innerHTML = pieces.join('');
    clearTimeout(confettiTimer);
    confettiTimer = setTimeout(function () {
      layer.innerHTML = '';
    }, 2100);
  }

  /** 数字滚动：把 [data-count-to] 在 0.6 秒内从 0 缓动到目标值 */
  function animateCounters(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll('[data-count-to]');
    if (!nodes.length) return;

    const duration = 600;

    nodes.forEach(function (node) {
      const target = Number(node.getAttribute('data-count-to'));
      if (!Number.isFinite(target)) return;

      const suffix = node.getAttribute('data-count-suffix') || '';
      const started = performance.now();

      node.textContent = '0' + suffix;

      function step(now) {
        const progress = Math.min(1, (now - started) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        node.textContent = Math.round(target * eased) + suffix;
        if (progress < 1) requestAnimationFrame(step);
      }

      requestAnimationFrame(step);
    });
  }

  /* ---------- Agent 调度可视化 ---------- */
  const AGENT_STEPS = [
    { emoji: '🤖', name: '教练总控Agent', text: '已收到你的信息，正在调度教练团队…' },
    { emoji: '📋', name: '训练计划Agent', text: '正在为你设计本周训练安排…' },
    { emoji: '🥗', name: '营养饮食Agent', text: '正在计算你的热量与营养目标…' }
  ];

  const AGENT_SUMMARY_STEP = { emoji: '✨', name: '', text: '已为你汇总生成专属方案' };

  let agentTraceTimer = null;

  /** 追加一条 Agent 状态 */
  function appendAgentStep(step) {
    const box = $('#agent-trace');
    if (!box) return;

    box.innerHTML += (
      '<div class="agent-trace-item">' +
        (step.emoji ? '<span class="agent-trace-emoji">' + step.emoji + '</span>' : '') +
        (step.name ? '<b>' + esc(step.name) + '</b>' : '') +
        '<span>' + esc(step.text) + '</span>' +
      '</div>'
    );
  }

  /** 逐条展示 Agent 状态（每条约 0.5 秒），全部追加完成后 resolve */
  function runAgentTrace(steps) {
    const box = $('#agent-trace');
    if (!box) return Promise.resolve();

    box.hidden = false;
    box.classList.remove('is-done');
    box.innerHTML = '';

    const list = steps && steps.length ? steps : AGENT_STEPS;
    const interval = 500;

    return new Promise(function (resolve) {
      let index = 0;

      function next() {
        if (index >= list.length) {
          resolve();
          return;
        }

        appendAgentStep(list[index]);
        index += 1;
        agentTraceTimer = setTimeout(next, interval);
      }

      next();
    });
  }

  /** 收尾：可补一条汇总，停留后淡出隐藏 */
  function finishAgentTrace(showSummary) {
    const box = $('#agent-trace');
    clearTimeout(agentTraceTimer);
    if (!box) return Promise.resolve();

    if (showSummary) appendAgentStep(AGENT_SUMMARY_STEP);
    box.hidden = false;

    return new Promise(function (resolve) {
      agentTraceTimer = setTimeout(function () {
        box.classList.add('is-done');
        agentTraceTimer = setTimeout(function () {
          box.hidden = true;
          box.classList.remove('is-done');
          box.innerHTML = '';
          resolve();
        }, 420);
      }, showSummary ? 520 : 0);
    });
  }

  /* ---------- 文案个性化引擎 ---------- */
  const PERSONA_STATE_TEXT = {
    idle: '还没开练',
    happy: '状态超棒',
    ok: '刚刚好',
    tired: '有点累'
  };

  /** 开场 / 结尾模板：每个区域各 5 套，随机选用 */
  const PERSONA_TEMPLATES = {
    training: {
      intro: [
        '{昵称}，{目标}的路上，今天也要稳稳迈一步 💪',
        '已连续打卡 {连续} 天，你的自律正在变成线条 ✨',
        '{昵称}，这份安排是为你排的，按自己的节奏来就好 🌿',
        '今日状态：{状态}。跟着计划走，比昨天强一点就够了 🏋️',
        '{昵称}，{目标}不是冲刺，是每天多一点点 🎯'
      ],
      outro: [
        '做完记得补水，今天的努力会留在身体里 💧',
        '训练结束后来打个卡，让复盘 Agent 看看你的状态 📊',
        '别追求一次到位，动作稳比数量多更重要 🌿',
        '已连续打卡 {连续} 天，明天继续保持这个节奏 ✨',
        '{昵称}，练完拉伸 5 分钟，明天的你会感谢今天 💪'
      ]
    },
    diet: {
      intro: [
        '{昵称}，今天的每一口都在给{目标}投票 🥗',
        '已连续打卡 {连续} 天，饮食也保持这个节奏吧 ✨',
        '今日状态：{状态}，按目标热量吃，不用饿着 🌿',
        '{昵称}，先把蛋白质吃够，训练才有回报 🍳',
        '营养 Agent 已按你的体重和目标算好，照着吃就行 🥗'
      ],
      outro: [
        '吃太咸记得多喝水，明天状态会更好 💧',
        '{昵称}，晚上别加餐太多，给肠胃留点休息时间 🌙',
        '热量差一点没关系，别因为一顿否定一整周 ✨',
        '已连续打卡 {连续} 天，饮食稳定比完美更重要 🌿',
        '明天换一种做法，同样的营养也能吃得开心 🍱'
      ]
    },
    review: {
      intro: [
        '{昵称}，已连续打卡 {连续} 天，节奏很稳 📊',
        '已连续打卡 {连续} 天，自律正在变成线条 💪',
        '今日状态：{状态}，复盘 Agent 已按强度给出建议 ✨',
        '{昵称}，看看这周的曲线，进步是看得见的 🌿',
        '别只盯体重，力量和状态也在悄悄变化 🎯'
      ],
      outro: [
        '明天按建议强度来，别一次加太多 💪',
        '{昵称}，睡够 7 小时，恢复也是训练的一部分 🌙',
        '已连续打卡 {连续} 天，保持这个节奏就很了不起 ✨',
        '下周我们再把计划调细一点，慢慢来 🎯',
        '有伤病就及时调整，安全永远第一位 🌿'
      ]
    }
  };

  const personaCache = {};

  /** 连续打卡天数：从今天往前连续有记录的天数 */
  function calcStreakDays() {
    const dates = {};
    (state.checkins || []).forEach(function (item) {
      if (item && item.date) dates[item.date] = true;
    });

    let streak = 0;
    const cursor = new Date();

    while (true) {
      const key = cursor.getFullYear() + '-' +
        pad(cursor.getMonth() + 1) + '-' + pad(cursor.getDate());
      if (!dates[key]) break;
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return streak;
  }

  /** 个性化变量：昵称 / 目标 / 连续打卡天数 / 今日状态 */
  function personaVars() {
    const user = currentUser() || state.profile || {};
    const goalKey = user.goal || (state.profile && state.profile.goal);

    return {
      昵称: user.nickname || '你',
      目标: (App.GoalLabel && App.GoalLabel[goalKey]) || '变强',
      连续: calcStreakDays(),
      状态: PERSONA_STATE_TEXT[resolveAvatarState()] || '还没开练'
    };
  }

  /** 把中文占位符替换成个性化变量 */
  function fillPersona(template, vars) {
    return String(template).replace(/{(昵称|目标|连续|状态)}/g, function (match, key) {
      return vars[key] === undefined ? match : String(vars[key]);
    });
  }

  /** 取某区域文案：首次随机选定后缓存，重绘时保持稳定 */
  function pickPersona(area, slot) {
    const templates = PERSONA_TEMPLATES[area] && PERSONA_TEMPLATES[area][slot];
    if (!templates || !templates.length) return '';

    const key = area + ':' + slot;
    if (!personaCache[key]) {
      personaCache[key] = templates[Math.floor(Math.random() * templates.length)];
    }

    return fillPersona(personaCache[key], personaVars());
  }

  /** 个性化文案行 */
  function personaHtml(area, slot) {
    const text = pickPersona(area, slot);
    if (!text) return '';

    return '<p class="persona-line' + (slot === 'outro' ? ' is-outro' : '') + '">' +
      esc(text) + '</p>';
  }

  /** 答疑调整类型 → 简短标签（用于调度轨迹文案） */
  function describeAdjustTag(adjustments) {
    if (!adjustments) return '方案调整';
    if (adjustments.injuries && adjustments.injuries.length) return '伤病调整';
    if (adjustments.equipment && adjustments.equipment.length) return '器械调整';
    if (adjustments.daysPerWeek) return '训练天数调整';
    if (adjustments.goal) return '目标调整';
    if (adjustments.calorieAdjust) return '热量调整';
    if (adjustments.dietVariety) return '饮食多样化调整';
    return '方案调整';
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    button.disabled = busy;
    if (busy) {
      button.dataset.idleText = button.textContent;
      button.textContent = busyText || '处理中…';
    } else {
      button.textContent = button.dataset.idleText || button.textContent;
    }
  }

  /* ============================ Tab 路由 ============================ */

  function currentTab() {
    const key = (location.hash || '').replace(/^#/, '');
    return VALID_TABS.indexOf(key) >= 0 ? key : 'home';
  }

  function applyRoute() {
    switchTab(currentTab());
  }

  function switchTab(key) {
    if (VALID_TABS.indexOf(key) < 0) key = 'home';

    $$('.tab').forEach(function (tab) {
      const active = tab.getAttribute('data-tab') === key;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    $$('.page').forEach(function (page) {
      page.classList.toggle('is-active', page.getAttribute('data-page') === key);
    });

    window.scrollTo(0, 0);

    // 每次进入科普页都检查是否跨天，保证「今日科普」随日期自动刷新
    if (key === 'science') {
      renderSciencePage();

      // 从首页「健康小测试」进入时自动开始答题
      if (pendingQuizAutoStart) {
        pendingQuizAutoStart = false;
        startQuiz();
      }
    }

    // 从首页「记录饮食」进入时，定位到饮食记录卡片
    if (key === 'review' && pendingReviewFocus === 'diet') {
      pendingReviewFocus = '';
      const dietCard = $('#diet-card');
      if (dietCard) dietCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // 进入独立饮食页时刷新草稿与历史，保证数据与其他页面同步
    if (key === 'diet') {
      renderDietDraft();
      renderDietHistory();
    }

    // 进入训练日历页时重绘，保证身材信息 / 方案变更后的本周计划与部位标注同步
    if (key === 'calendar') renderCalendar();

    // 回到首页时重新渲染，保证饮食 / 打卡等聚合卡片始终是最新数据
    if (key === 'home') renderHomeState();

    // 训练完成后跳转过来时，定位到复盘报告
    if (key === 'review' && pendingReviewFocus === 'report') {
      pendingReviewFocus = '';
      const report = $('#review-result');
      if (report) report.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function bindTabs() {
    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        const key = tab.getAttribute('data-tab');
        if (location.hash === '#' + key) switchTab(key);
        else location.hash = key;
      });
    });
    window.addEventListener('hashchange', function () {
      switchTab(currentTab());
    });
  }

  /** 全局导航：返回首页、首页聚合卡片跳转、自动开始小测试 */
  function bindGlobalActions() {
    document.addEventListener('click', function (event) {
      // 返回首页：二级页返回按钮与空状态引导共用
      if (event.target.closest('[data-back-home]') || event.target.closest('[data-go-home]')) {
        location.hash = 'home';
        return;
      }

      // 首页科普「换一篇」：原位替换全文，不跳转页面
      if (event.target.closest('[data-shuffle-home]')) {
        shuffleHomeArticle();
        return;
      }

      // 首页聚合卡片：进入对应二级页，并按需带上模式 / 定位意图
      const nav = event.target.closest('[data-nav]');
      if (nav) {
        const target = nav.getAttribute('data-nav');

        if (nav.getAttribute('data-mode') === 'plan') setTrainingMode('plan');
        if (nav.getAttribute('data-quiz') === '1') pendingQuizAutoStart = true;
        if (nav.getAttribute('data-focus') === 'diet') pendingReviewFocus = 'diet';

        if (location.hash === '#' + target) switchTab(target);
        else location.hash = target;
        return;
      }

      const quick = event.target.closest('[data-quick]');
      if (quick) {
        location.hash = quick.getAttribute('data-quick');
      }
    });
  }

  /** 跨页面跳转的临时意图（不持久化） */
  let pendingQuizAutoStart = false;
  let pendingReviewFocus = '';

  /* ============================ 首次使用引导 ============================ */

  /** 首次打开时展示三步引导；已读过则不弹 */
  function maybeShowIntro() {
    const modal = $('#intro-modal');
    if (!modal) return;

    let seen = false;
    try {
      seen = localStorage.getItem(INTRO_KEY) === '1';
    } catch (error) {
      // 存储不可用时直接视为已读，避免反复弹窗
      seen = true;
    }

    if (seen) return;

    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
  }

  /** 关闭引导并记录已读标记 */
  function closeIntro() {
    const modal = $('#intro-modal');
    if (modal) {
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
    }

    try {
      localStorage.setItem(INTRO_KEY, '1');
    } catch (error) {
      /* 忽略存储失败，本次仍然关闭弹层 */
    }
  }

  /** 绑定引导的关闭入口：遮罩、关闭按钮与「开始使用」 */
  function bindIntro() {
    const modal = $('#intro-modal');
    if (!modal) return;

    modal.addEventListener('click', function (event) {
      if (event.target.closest('[data-close-intro]')) closeIntro();
    });

    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && modal.classList.contains('is-open')) closeIntro();
    });
  }

  /** 绑定用户入口与切换弹层 */
  function bindUserModal() {
    const entry = $('#user-entry');
    if (entry) entry.addEventListener('click', openUserModal);


    const modal = $('#user-modal');
    if (modal) {
      modal.addEventListener('click', function (event) {
        if (event.target.closest('[data-close-user]')) {
          closeUserModal();
          return;
        }

        if (event.target.closest('[data-action="delete-user"]')) {
          const item = event.target.closest('[data-user-id]');
          if (item) deleteUser(item.getAttribute('data-user-id'));
          return;
        }

        const item = event.target.closest('[data-user-id]');
        if (item) switchUser(item.getAttribute('data-user-id'));
      });
    }

    const addButton = $('#add-user-btn');
    if (addButton) addButton.addEventListener('click', startAddUser);

    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && modal && modal.classList.contains('is-open')) {
        closeUserModal();
      }
    });
  }

  /* ============================ 本地持久化（多用户） ============================ */

  /** 把内存状态写入「当前用户」的数据键 */
  function persistState() {
    if (!store) return;

    store.saveData('profile', state.profile);
    store.saveData('coaching', state.coaching);
    store.saveData('reviewHistory', state.reviewHistory);
    store.saveData('checkins', state.checkins);
    store.saveData('totalCheckins', state.totalCheckins);
    store.saveData('correctionStats', state.correctionStats);
    store.saveData('trainingSessions', state.trainingSessions);
    store.saveData('dietLogs', state.dietLogs);
    store.saveData('waterLogs', state.waterLogs);
    store.saveData('dietReports', state.dietReports);
  }

  /** 从「当前用户」的数据键恢复内存状态 */
  function restoreState() {
    if (!store) return;

    state.profile = store.getData('profile', null);
    state.coaching = store.getData('coaching', null);

    state.reviewHistory = store.getData('reviewHistory', []);
    if (!Array.isArray(state.reviewHistory)) state.reviewHistory = [];

    state.checkins = store.getData('checkins', []);
    if (!Array.isArray(state.checkins)) state.checkins = [];

    state.totalCheckins = Number(store.getData('totalCheckins', 0)) || 0;
    // 兼容旧数据：没有累计值时用现有打卡条数兜底
    if (!state.totalCheckins) state.totalCheckins = state.checkins.length;

    state.correctionStats = store.getData('correctionStats', {});
    if (!state.correctionStats || typeof state.correctionStats !== 'object') {
      state.correctionStats = {};
    }

    state.trainingSessions = store.getData('trainingSessions', []);
    if (!Array.isArray(state.trainingSessions)) state.trainingSessions = [];

    state.dietLogs = store.getData('dietLogs', {});
    if (!state.dietLogs || typeof state.dietLogs !== 'object' || Array.isArray(state.dietLogs)) {
      state.dietLogs = {};
    }

    state.waterLogs = store.getData('waterLogs', {});
    if (!state.waterLogs || typeof state.waterLogs !== 'object' || Array.isArray(state.waterLogs)) {
      state.waterLogs = {};
    }

    state.dietReports = store.getData('dietReports', {});
    if (!state.dietReports || typeof state.dietReports !== 'object' || Array.isArray(state.dietReports)) {
      state.dietReports = {};
    }
  }

  /** 重置内存状态，切换用户时避免把上一个人的数据带过去 */
  function resetMemoryState() {
    state.profile = null;
    state.coaching = null;
    state.lastReview = null;
    state.reviewHistory = [];
    state.checkins = [];
    state.totalCheckins = 0;
    state.correctionStats = {};
    state.trainingSessions = [];
    state.dietLogs = {};
    state.waterLogs = {};
    state.dietReports = {};
    state.dietDraft = {
      items: [], photo: null, selectedFood: null, keyword: '', meal: 'lunch'
    };
  }

  /**
   * 首次升级到多用户版本时，把旧版单用户数据迁移成第一个用户。
   * 迁移完成后删除旧键，避免重复迁移。
   */
  function migrateLegacyState() {
    if (!store) return;
    if (store.getUsers().length) return;

    let legacy = null;
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return;
      legacy = JSON.parse(raw);
    } catch (error) {
      return;
    }
    if (!legacy) return;

    const profile = legacy.profile || null;
    const user = Object.assign(
      {
        id: store.createUserId(),
        nickname: (profile && profile.nickname) || '我',
        createdAt: new Date().toISOString()
      },
      profile || {}
    );

    store.saveUsers([user]);
    store.setCurrentUserId(user.id);
    store.saveData('profile', profile);
    store.saveData('coaching', legacy.coaching || null);
    store.saveData('reviewHistory', legacy.reviewHistory || []);
    store.saveData('checkins', legacy.checkins || []);
    store.saveData('trainingSessions', legacy.trainingSessions || []);
    store.saveData('dietLogs', legacy.dietLogs || {});

    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      /* 忽略清理失败 */
    }
  }

  /* ============================ 用户管理（多用户） ============================ */

  /** 目标文案 */
  const GOAL_TEXT = {
    lose_fat: '减脂',
    build_muscle: '增肌',
    body_shape: '塑形',
    endurance: '提升体能',
    health: '保持健康'
  };

  /** 身材信息可编辑的器械项（与录入表单保持一致） */
  const EQUIPMENT_KEYS = ['bodyweight', 'dumbbell', 'barbell', 'machine', 'band', 'kettlebell'];

  /** 目标对应的卡通小人主色：增肌绿 / 减脂蓝 / 塑形杏 */
  const AVATAR_COLOR = {
    build_muscle: '#4EC5C1',
    lose_fat: '#A8D8EA',
    body_shape: '#FFD3A5'
  };

  function currentUser() {
    return store ? store.currentUser() : null;
  }

  function getUsers() {
    return store ? store.getUsers() : [];
  }

  function goalText(goal) {
    return GOAL_TEXT[goal] || '保持健康';
  }

  /** 按时间生成问候语 */
  function timeGreeting() {
    const hour = new Date().getHours();
    if (hour < 6) return '夜深了';
    if (hour < 12) return '早上好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }

  /** BMI = 体重(kg) / 身高(m)²，保留 1 位小数 */
  function calcBmi(height, weight) {
    const h = Number(height) / 100;
    const w = Number(weight);
    if (!h || !w) return null;
    return Math.round((w / (h * h)) * 10) / 10;
  }

  /** 更新右上角用户入口显示 */
  function updateUserEntry() {
    const user = currentUser();
    const nameEl = $('#user-entry-name');
    const avatarEl = $('#user-entry-avatar');
    if (nameEl) nameEl.textContent = user ? (user.nickname || '未命名') : '未选择用户';
    if (avatarEl) avatarEl.textContent = user ? '🧑' : '👤';
  }

  /** 渲染用户列表弹层内容 */
  function renderUserList() {
    const root = $('#user-list');
    if (!root) return;

    const user = currentUser();
    const users = getUsers();

    if (!users.length) {
      root.innerHTML = '<p class="muted">还没有用户，点击下方按钮添加。</p>';
      return;
    }

    root.innerHTML = users.map(function (item) {
      const active = user && user.id === item.id;
      return (
        '<button type="button" class="user-item' + (active ? ' is-active' : '') + '" ' +
          'data-user-id="' + esc(item.id) + '">' +
          '<span class="user-item-avatar">🧑</span>' +
          '<span class="user-item-info">' +
            '<b>' + esc(item.nickname || '未命名') + (active ? ' · 当前' : '') + '</b>' +
            '<em>' + esc(goalText(item.goal)) + ' · 每周 ' +
              esc(item.daysPerWeek || '--') + ' 天</em>' +
          '</span>' +
          '<span class="user-item-del" data-action="delete-user" title="删除该用户">🗑</span>' +
        '</button>'
      );
    }).join('');
  }

  function openUserModal() {
    const modal = $('#user-modal');
    if (!modal) return;
    renderUserList();
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeUserModal() {
    const modal = $('#user-modal');
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }

  /** 切换用户：切换存储命名空间后重新加载该用户数据 */
  function switchUser(userId) {
    if (!store) return;

    const user = getUsers().find(function (item) {
      return item.id === userId;
    });
    if (!user) return;

    store.setCurrentUserId(user.id);
    closeUserModal();
    state.addingUser = false;

    resetMemoryState();
    restoreState();
    if (!state.profile) state.profile = Object.assign({}, user);

    renderAll();
    updateUserEntry();
    renderUserList();
    showToast('已切换到 ' + (user.nickname || '新用户'));
  }

  /**
   * 删除用户：二次确认后从列表移除，并清理该用户的全部数据。
   * 若删除的是当前用户，自动切换到剩余的第一个用户；没有剩余则回到录入态。
   */
  function deleteUser(userId) {
    if (!store) return;

    const target = getUsers().find(function (item) {
      return item.id === userId;
    });
    if (!target) return;

    const confirmed = window.confirm(
      '确定删除用户「' + (target.nickname || '未命名') + '」吗？\n该用户的训练计划、打卡、饮食记录等数据会一并删除，且无法恢复。'
    );
    if (!confirmed) return;

    const remaining = getUsers().filter(function (item) {
      return item.id !== userId;
    });
    store.saveUsers(remaining);
    store.removeUserData(userId);

    const wasCurrent = store.getCurrentUserId() === userId;
    if (wasCurrent) {
      if (remaining.length) {
        store.setCurrentUserId(remaining[0].id);
        showToast('已删除「' + (target.nickname || '未命名') + '」，切换到 ' + (remaining[0].nickname || '新用户'));
      } else {
        store.setCurrentUserId('');
        showToast('已删除最后一个用户，请重新录入信息 📝');
      }
    } else {
      showToast('已删除「' + (target.nickname || '未命名') + '」');
    }

    resetMemoryState();
    restoreState();
    renderAll();
    updateUserEntry();
    renderUserList();
  }

  /**
   * 打开录入表单，准备添加新用户。
   * 保留当前用户 ID，用户放弃添加时不会丢失登录态。
   */
  function startAddUser() {
    closeUserModal();
    state.addingUser = true;
    resetMemoryState();
    renderAll();
    updateUserEntry();

    const form = $('#profile-form');
    if (form) form.hidden = false;
    const nick = $('#nickname');
    if (nick) {
      nick.value = '';
      nick.focus();
    }
    location.hash = 'home';
  }

  /* ============================ 首页：个人主页 ============================ */

  /** 今日是否打卡，决定小人状态：未打卡=待机，否则按自评 */
  function resolveAvatarState() {
    const today = todayStr();
    const record = (state.checkins || []).find(function (item) {
      return item.date === today;
    });

    if (!record) return 'idle';
    if (record.feeling === 'easy') return 'happy';
    if (record.feeling === 'tired') return 'tired';
    return 'ok';
  }

  /** 四种状态对应的气泡文案 */
  const AVATAR_STATE_TEXT = {
    idle: '今天还没开练哦，一起动起来吧 💪',
    happy: '状态超棒！明天可以加一点点强度 ✨',
    ok: '今天的训练刚刚好，继续保持！👍',
    tired: '今天辛苦了，记得补水 💧'
  };

  /** 表情：按状态切换眼睛、嘴型、腮红与汗滴 */
  function renderAvatarFace(avatarState) {
    if (avatarState === 'happy') {
      return (
        '<path class="avatar-eye-curve" d="M68 34 Q73 29 78 34"/>' +
        '<path class="avatar-eye-curve" d="M82 34 Q87 29 92 34"/>' +
        '<path class="avatar-mouth" d="M72 44 Q80 53 88 44"/>' +
        '<circle class="avatar-blush" cx="66" cy="42" r="4.4"/>' +
        '<circle class="avatar-blush" cx="94" cy="42" r="4.4"/>'
      );
    }

    if (avatarState === 'tired') {
      return (
        '<path class="avatar-eye-curve" d="M68 35 L76 35"/>' +
        '<path class="avatar-eye-curve" d="M84 35 L92 35"/>' +
        '<path class="avatar-mouth" d="M73 47 Q80 44 87 47"/>' +
        '<path class="avatar-sweat" d="M106 26 q6 8 0 11 q-6 -3 0 -11"/>'
      );
    }

    // idle / ok：圆眼 + 微笑
    return (
      '<circle class="avatar-eye" cx="73" cy="34" r="2.8"/>' +
      '<circle class="avatar-eye" cx="87" cy="34" r="2.8"/>' +
      '<path class="avatar-mouth" d="M73 45 Q80 50 87 45"/>'
    );
  }

  /** 性别装饰：男孩短发，女孩短发 + 蝴蝶结 */
  function renderAvatarHair(gender) {
    if (gender === 'female') {
      return (
        '<path class="avatar-hair" d="M60 34 Q64 16 80 16 Q96 16 100 34 Q88 26 80 26 Q72 26 60 34Z"/>' +
        '<circle class="avatar-bow" cx="103" cy="22" r="4.2"/>' +
        '<circle class="avatar-bow" cx="110" cy="24" r="3.4"/>'
      );
    }
    return (
      '<path class="avatar-hair" d="M62 30 Q66 17 80 17 Q94 17 98 30 Q89 24 80 24 Q71 24 62 30Z"/>'
    );
  }

  /**
   * 卡通伙伴 SVG：状态类控制动画与附加元素
   * idle=待机招手 / happy=蹦跳星星 / ok=微笑比赞 / tired=擦汗呼吸
   */
  function renderAvatarSvg(user, avatarState) {
    const current = avatarState || 'idle';
    const extra = current === 'happy'
      ? '<g class="avatar-sparkles">' +
          '<text class="avatar-sparkle" x="24" y="34">✨</text>' +
          '<text class="avatar-sparkle" x="120" y="58">✨</text>' +
          '<text class="avatar-sparkle" x="30" y="92">✨</text>' +
        '</g>'
      : '';

    return (
      '<svg class="avatar-svg avatar-svg--' + current + '" viewBox="0 0 160 210" ' +
        'role="img" aria-label="卡通运动伙伴">' +
        '<circle class="avatar-head" cx="80" cy="36" r="21"/>' +
        renderAvatarHair(user && user.gender) +
        renderAvatarFace(current) +
        '<rect class="avatar-body" x="68" y="62" width="24" height="54" rx="12"/>' +
        '<rect class="avatar-arm avatar-arm--left" x="44" y="66" width="12" height="50" rx="6"/>' +
        '<rect class="avatar-arm avatar-arm--right" x="104" y="66" width="12" height="50" rx="6"/>' +
        '<rect class="avatar-leg" x="66" y="116" width="14" height="48" rx="7"/>' +
        '<rect class="avatar-leg" x="84" y="116" width="14" height="48" rx="7"/>' +
        extra +
      '</svg>'
    );
  }

  /* ---------- 吉祥物素材：透明 webp 静态图（按性别分版本） ---------- */
  // 状态键：idle=未训练，happy=轻松，ok=合适，tired=太累
  const MASCOT_IMAGES = {
    idle: 'images/mascot_idle.webp',
    happy: 'images/mascot_energetic.webp',
    ok: 'images/mascot_happy.webp',
    tired: 'images/mascot_tired.webp'
  };

  const MASCOT_GIRL_IMAGES = {
    idle: 'images/girl_idle.webp',
    happy: 'images/girl_energetic.webp',
    ok: 'images/girl_happy.webp',
    tired: 'images/girl_tired.webp'
  };

  const MASCOT_ALT = {
    idle: '待机中的运动伙伴',
    happy: '精力充沛的运动伙伴',
    ok: '状态正好的运动伙伴',
    tired: '有点累的运动伙伴'
  };

  /** 按性别选版本：女性用女版；男性或未填性别用男版 */
  function mascotSource(user, stateKey) {
    const map = user && user.gender === 'female' ? MASCOT_GIRL_IMAGES : MASCOT_IMAGES;
    return map[stateKey] || '';
  }

  /** 首页吉祥物：动画挂在外层 wrap，img 只负责展示；缺图回退 SVG */
  function renderMascotHtml(user, avatarState) {
    const stateKey = avatarState || 'idle';
    const src = mascotSource(user, stateKey);

    if (!src) return renderAvatarSvg(user, stateKey);

    return (
      '<div class="mascot-wrap mascot-wrap--' + esc(stateKey) + '">' +
        '<img class="mascot-img" src="' + esc(src) + '" alt="' +
          esc(MASCOT_ALT[stateKey] || '运动伙伴') + '" data-mascot="' + esc(stateKey) +
          '" draggable="false">' +
      '</div>'
    );
  }

  /** 图片加载失败（文件缺失 / 网络问题）时回退 SVG 小人 */
  function bindMascotFallback() {
    const stage = document.querySelector('#home-profile .avatar-stage');
    if (!stage) return;

    const img = stage.querySelector('.mascot-img[data-mascot]');
    if (!img) return; // 已经是 SVG 兜底

    const toSvg = function () {
      if (!stage.isConnected) return;
      stage.innerHTML = renderAvatarSvg(
        currentUser() || state.profile || {},
        img.getAttribute('data-mascot')
      );
    };

    // 缓存中已是失败态时不会再次触发 error，直接回退
    if (img.complete && img.naturalWidth === 0) { toSvg(); return; }
    img.addEventListener('error', toSvg, { once: true });
  }


  /**
   * 首页「今日闭环」进度条：计划 → 训练 → 饮食 → 打卡。
   * 完成状态全部由已保存的数据推导（localStorage），刷新后不会丢失。
   */
  function renderHomeProgress() {
    const today = todayStr();
    const hasPlan = Boolean(state.coaching && state.coaching.trainingPlan);
    const trained = (state.trainingSessions || []).some(function (item) {
      return item.date === today;
    });
    const ate = Boolean(state.dietLogs && state.dietLogs[today]);
    const checked = (state.checkins || []).some(function (item) {
      return item.date === today;
    });

    const steps = [
      { label: '计划', emoji: '📋', done: hasPlan },
      { label: '训练', emoji: '🏋️', done: trained },
      { label: '饮食', emoji: '🍎', done: ate },
      { label: '打卡', emoji: '📊', done: checked }
    ];

    const doneCount = steps.filter(function (step) {
      return step.done;
    }).length;
    const percent = Math.round((doneCount / steps.length) * 100);

    return (
      '<div class="card home-progress">' +
        '<div class="progress-head">' +
          '<b>今日闭环</b>' +
          '<span data-count-to="' + doneCount +
            '" data-count-suffix="/' + steps.length + ' 完成">' +
            doneCount + '/' + steps.length + ' 完成</span>' +
        '</div>' +
        '<div class="progress-steps">' +
          steps.map(function (step) {
            return '<span class="progress-step' +
              (step.done ? ' is-done' : ' is-pending') + '">' +
              '<i>' + step.emoji + '</i>' + step.label +
            '</span>';
          }).join('') +
        '</div>' +
        '<div class="progress-bar"><i style="width:' + percent + '%"></i></div>' +
      '</div>'
    );
  }


  /** 个人主页：问候 + 伙伴 + 状态气泡 + 身材信息 + 快捷入口 */
  function renderHomeProfileHtml(user) {
    const nickname = user.nickname || '你';
    const color = AVATAR_COLOR[user.goal] || '#4EC5C1';
    const bmi = calcBmi(user.height, user.weight);
    const avatarState = resolveAvatarState();

    const equipment = (user.equipment || []).length
      ? user.equipment.map(function (key) {
          return (App.EquipmentLabel && App.EquipmentLabel[key]) || key;
        }).join(' / ')
      : '徒手';

    return (
      renderHomeProgress() +
      '<div class="profile-hero card" style="--avatar-color:' + color + '">' +
        '<div class="profile-greeting">' +
          '<div class="profile-hello-row">' +
            '<p class="profile-hello">' + esc(timeGreeting()) + '，' + esc(nickname) + ' 👋</p>' +

          '</div>' +
          '<div class="avatar-bubble">' + esc(AVATAR_STATE_TEXT[avatarState]) + '</div>' +
        '</div>' +
        '<div class="avatar-stage">' + renderMascotHtml(user, avatarState) + '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-head">' +
          '<h2>🧍 身材信息</h2>' +
          '<span class="tag">按目标定制</span>' +
        '</div>' +
        '<div class="profile-stats">' +
          '<div class="profile-stat"><span>📏 身高</span>' +
            '<input class="profile-input" type="number" inputmode="numeric" min="120" max="230" ' +
              'step="1" value="' + esc(user.height || '') + '" data-profile-field="height" ' +
              'aria-label="身高（厘米）">' +
          '</div>' +
          '<div class="profile-stat"><span>⚖️ 体重</span>' +
            '<input class="profile-input" type="number" inputmode="decimal" min="30" max="200" ' +
              'step="0.1" value="' + esc(user.weight || '') + '" data-profile-field="weight" ' +
              'aria-label="体重（公斤）">' +
          '</div>' +
          '<div class="profile-stat"><span>📊 BMI</span>' +
            '<b id="profile-bmi">' + (bmi === null ? '--' : bmi) + '</b></div>' +
          '<div class="profile-stat"><span>🎯 目标</span>' +
            '<select class="profile-input" data-profile-field="goal" aria-label="训练目标">' +
              Object.keys(GOAL_TEXT).map(function (key) {
                return '<option value="' + key + '"' +
                  (user.goal === key ? ' selected' : '') + '>' + GOAL_TEXT[key] + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div class="profile-stat"><span>📅 每周训练</span>' +
            '<select class="profile-input" data-profile-field="daysPerWeek" ' +
              'aria-label="每周训练天数">' +
              [1, 2, 3, 4, 5, 6, 7].map(function (day) {
                return '<option value="' + day + '"' +
                  (Number(user.daysPerWeek) === day ? ' selected' : '') + '>' + day + ' 天</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div class="profile-stat profile-stat--wide"><span>🏋️ 器械</span>' +
            '<div class="profile-equipment">' +
              EQUIPMENT_KEYS.map(function (key) {
                const active = (user.equipment || []).indexOf(key) >= 0;
                const label = (App.EquipmentLabel && App.EquipmentLabel[key]) || key;
                return '<button type="button" class="profile-equip-chip' +
                  (active ? ' is-active' : '') + '" data-profile-equipment="' + esc(key) + '">' +
                  esc(label) + '</button>';
              }).join('') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<p class="hint">身高、体重、目标、天数与器械可直接修改，改完立即保存。</p>' +
      '</div>' +

      renderHomeDashboard(user) +
      '<button type="button" class="about-link" data-nav="about">ℹ️ 关于本应用</button>' +
      '<p class="disclaimer-note">本应用建议仅供参考，不构成医疗建议</p>'
    );
  }

  /** 取今日科普文章（与科普页共用日期种子与「换一篇」状态） */
  function currentScienceArticle() {
    const now = new Date();
    const dayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();

    // 首次渲染或跨天时，按日期种子选文
    if (!scienceInited || scienceDayKey !== dayKey) {
      scienceIndex = todayScienceIndex();
      scienceInited = true;
      scienceDayKey = dayKey;
    }

    return SCIENCE_ARTICLES[scienceIndex] || null;
  }

  /** 首页科普全文：标题 + 小标题分段 + 实用提醒 */
  function renderHomeArticleInner() {
    const article = currentScienceArticle();
    if (!article) {
      return '<p class="muted">暂无科普内容 📚</p>';
    }

    const sections = [
      { emoji: '🌿', label: '为什么重要' },
      { emoji: '✅', label: '怎么做' },
      { emoji: '💡', label: '小提醒' }
    ];

    return (
      '<div class="home-article-head">' +
        '<span class="article-emoji">' + article.emoji + '</span>' +
        '<div class="article-title-group">' +
          '<h3>' + esc(article.title) + '</h3>' +
          '<span class="article-meta">' + esc(article.category) + ' · 预计阅读 ' +
            esc(article.minutes) + ' 分钟</span>' +
        '</div>' +
      '</div>' +
      '<div class="home-article-body">' +
        article.points.map(function (text, index) {
          const section = sections[index] || sections[sections.length - 1];
          return (
            '<section class="article-section">' +
              '<h4>' + section.emoji + ' ' + section.label + '</h4>' +
              '<p>' + esc(text) + '</p>' +
            '</section>'
          );
        }).join('') +
        '<p class="article-tip">💡 ' + esc(article.tip) + '</p>' +
      '</div>'
    );
  }

  /** 首页「换一篇」：随机换一篇并原位替换正文，不跳页 */
  function shuffleHomeArticle() {
    if (SCIENCE_ARTICLES.length < 2) return;

    let next = scienceIndex;
    while (next === scienceIndex) {
      next = Math.floor(Math.random() * SCIENCE_ARTICLES.length);
    }

    scienceIndex = next;
    scienceInited = true;

    const box = $('#home-article');
    if (box) box.innerHTML = renderHomeArticleInner();

    showToast('已换一篇 📖');
  }

  /** 本月迷你日历：有打卡的日期打绿点，今天高亮 */
  function renderMiniCalendar() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const today = now.getDate();
    // 周一作为一个星期的第一天
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const checked = {};
    (state.checkins || []).forEach(function (item) {
      checked[item.date] = true;
    });

    let cells = '';
    for (let i = 0; i < firstWeekday; i += 1) {
      cells += '<span class="mini-day is-empty"></span>';
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateKey = year + '-' + pad(month + 1) + '-' + pad(day);
      const classes = ['mini-day'];

      if (checked[dateKey]) classes.push('has-checkin');
      if (day === today) classes.push('is-today');

      cells += '<span class="' + classes.join(' ') + '">' + day + '</span>';
    }

    return (
      '<div class="mini-calendar">' +
        '<div class="mini-week">' +
          ['一', '二', '三', '四', '五', '六', '日'].map(function (name) {
            return '<span>' + name + '</span>';
          }).join('') +
        '</div>' +
        '<div class="mini-grid">' + cells + '</div>' +
      '</div>'
    );
  }

  /** 首页聚合卡片：今日训练 / 今日饮食 / 打卡复盘 / 健康科普 / 训练日历 */
  function renderHomeDashboard(user) {
    const now = new Date();
    const dayIndex = (now.getDay() + 6) % 7;
    const plan = state.coaching ? state.coaching.trainingPlan : null;
    const dayPlan = plan && plan.weeklyPlan ? plan.weeklyPlan[dayIndex] : null;

    /* 今日训练摘要 */
    let trainingText = '';
    if (!plan) {
      trainingText = '还没有训练计划，先完善档案生成方案 📝';
    } else if (!dayPlan || dayPlan.isRest) {
      trainingText = '今天是休息日，散散步、好好恢复 🌿';
    } else {
      const exercises = dayPlan.exercises || [];
      const names = exercises.slice(0, 3).map(function (item) {
        return exerciseEmoji(item.name) + ' ' + item.name + ' ' +
          (item.sets ? item.sets + ' 组' : (item.reps || ''));
      });
      trainingText = names.join(' · ') +
        (exercises.length > 3 ? ' 等 ' + exercises.length + ' 个动作' : '');
    }

    /* 今日饮食：已吃 vs 目标 */
    const totals = typeof App.calcFoodItems === 'function'
      ? App.calcFoodItems(state.dietDraft.items).totals
      : { calories: 0 };
    const targets = resolveDietTargets();
    const targetCalories = targets ? targets.calories : 0;
    const eaten = Math.round(totals.calories || 0);
    const percent = targetCalories > 0
      ? Math.min(100, Math.round((eaten / targetCalories) * 100))
      : 0;

    /* 今日喝水进度 */
    const today = todayStr();
    const water = Number(state.waterLogs[today]) || 0;
    const waterPercent = Math.min(100, Math.round((water / WATER_TARGET) * 100));

    /* 打卡与复盘摘要 */
    const todayCheckin = (state.checkins || []).find(function (item) {
      return item.date === today;
    });
    const feelingLabels = { easy: '轻松', ok: '合适', tired: '太累' };
    const checkinText = todayCheckin
      ? '✅ 已打卡 · 感受：' + (feelingLabels[todayCheckin.feeling] || '合适')
      : '今天还没有打卡，练完花 10 秒记一下 📊';

    const review = state.lastReview;
    const reviewText = review && Array.isArray(review.highlights) && review.highlights.length
      ? review.highlights[0]
      : '';

    /* 今日科普 */
    const article = SCIENCE_ARTICLES[todayScienceIndex()];
    const articleText = article
      ? article.title + ' · ' + article.points[0]
      : '今天也来学一点健康小知识 📚';

    return (
      '<div class="dash-list">' +

        '<section class="dash-card">' +
          '<div class="dash-head"><span class="dash-emoji">🏋️</span><b>今日训练</b></div>' +
          '<p class="dash-text">' + esc(trainingText) + '</p>' +
          '<button type="button" class="btn-primary dash-btn" data-nav="training" ' +
            'data-mode="plan">▶ 开始训练</button>' +
        '</section>' +

        '<section class="dash-card">' +
          '<div class="dash-head"><span class="dash-emoji">🍎</span><b>今日饮食</b></div>' +
          '<p class="dash-text">已吃 <b>' + eaten + '</b> / 目标 ' +
            (targetCalories || '--') + ' kcal</p>' +
          '<div class="diet-progress"><i style="width:' + percent + '%"></i></div>' +
          '<p class="dash-hint">' +
            (targetCalories
              ? percent + '% · 还剩 ' + Math.max(0, targetCalories - eaten) + ' kcal'
              : '生成营养方案后可对照每日目标') +
          '</p>' +
          '<div class="diet-progress diet-progress--water">' +
            '<i style="width:' + waterPercent + '%"></i></div>' +
          '<p class="dash-hint">💧 喝水 ' + water + ' / ' + WATER_TARGET + ' ml</p>' +
          '<button type="button" class="btn-secondary dash-btn" data-nav="diet">' +
            '＋ 记录饮食</button>' +
        '</section>' +

        '<section class="dash-card">' +
          '<div class="dash-head"><span class="dash-emoji">📊</span><b>打卡复盘</b></div>' +
          '<p class="dash-text">' + esc(checkinText) + '</p>' +
          (reviewText ? '<p class="dash-hint">💡 ' + esc(reviewText) + '</p>' : '') +
          '<button type="button" class="btn-secondary dash-btn" data-nav="review">查看复盘</button>' +
        '</section>' +

        '<section class="dash-card">' +

          '<div class="dash-head"><span class="dash-emoji">📅</span><b>训练日历</b></div>' +
          renderMiniCalendar() +
          '<button type="button" class="btn-secondary dash-btn" data-nav="calendar">' +
            '查看日历详情</button>' +
        '</section>' +

        '<section class="dash-card home-article-card">' +
          '<div class="dash-head"><span class="dash-emoji">📚</span><b>健康科普</b></div>' +
          '<div id="home-article">' + renderHomeArticleInner() + '</div>' +
          '<div class="dash-actions">' +
            '<button type="button" class="btn-secondary dash-btn" data-shuffle-home>' +
              '🔄 换一篇</button>' +
            '<button type="button" class="btn-secondary dash-btn" data-nav="science" ' +
              'data-quiz="1">🎯 健康小测试</button>' +
          '</div>' +
        '</section>' +

      '</div>'
    );
  }

  /** 保存当前用户档案字段（身高 / 体重 / 目标 / 天数 / 器械） */
  function updateProfileField(field, value, options) {
    if (!store) return;

    const user = currentUser();
    if (!user) return;

    const next = Object.assign({}, user, { updatedAt: new Date().toISOString() });
    next[field] = value;

    // 同步用户列表与当前用户的 profile 数据
    store.saveUsers(getUsers().map(function (item) {
      return item.id === next.id ? next : item;
    }));

    state.profile = Object.assign({}, state.profile || {});
    state.profile[field] = value;
    store.saveData('profile', state.profile);

    if (!(options && options.silent)) {
      showToast('已保存');
    }

    // 身材信息变更后自动重算：
    // 目标 / 天数 / 器械 / 伤病 → 训练计划 + 饮食全部重生成；身高 / 体重 → 只重算饮食目标
    if (!(options && options.noRegen)) {
      if (field === 'goal' || field === 'daysPerWeek' ||
        field === 'equipment' || field === 'injuries') {
        scheduleCoachingRegen('full');
      } else if (field === 'height' || field === 'weight') {
        scheduleCoachingRegen('diet');
      }
    }
  }

  /* ---------- 身材信息变更 → 自动重算方案 ---------- */
  let coachingRegenTimer = null;
  let coachingRegenBusy = false;
  let coachingRegenPending = null;

  /** 方案变更后的统一重绘：首页（BMI/进度）、训练、饮食、日历（本周计划与部位标注） */
  function refreshAfterCoachingChange() {
    updateUserEntry();
    renderHomeState();
    renderPageTags();
    renderTrainingPage();
    renderPlanGuides();
    renderDietDraft();
    renderDietHistory();
    renderCalendar();
  }

  /** 合并连续操作（如连续点选器械）：训练相关变更优先，只跑最后一次 */
  function scheduleCoachingRegen(mode) {
    if (mode === 'full') coachingRegenPending = 'full';
    else if (coachingRegenPending !== 'full') coachingRegenPending = 'diet';

    clearTimeout(coachingRegenTimer);
    coachingRegenTimer = setTimeout(runCoachingRegen, 600);
  }

  /** 按变更类型重新生成方案，并刷新所有依赖它的页面 */
  async function runCoachingRegen() {
    if (coachingRegenBusy || !coachingRegenPending) return;

    const mode = coachingRegenPending;
    coachingRegenPending = null;
    coachingRegenBusy = true;

    try {
      if (mode === 'diet') {
        const plan = state.coaching ? state.coaching.trainingPlan : null;
        const dietPlan = await regenerateDiet(state.profile, plan);

        if (!dietPlan) throw new Error('饮食方案生成失败');

        updateCoachingPlans(plan, dietPlan);
        renderHomeState();
        renderDietHistory();
        renderCalendar();
        showToast('已更新 BMI 与今日饮食目标 ✨', 2600);
      } else {
        const result = await App.coachAgent(state.profile);

        if (!result || !result.trainingPlan || !result.nutritionPlan) {
          throw new Error('方案生成失败');
        }

        state.coaching = result;
        persistState();
        refreshAfterCoachingChange();
        showToast('已为你更新！训练计划和日历已同步 ✨', 2600);
      }
    } catch (error) {
      console.error('[main] 身材信息更新后重算失败', error);
      showToast('方案更新失败，请稍后重试');
    } finally {
      coachingRegenBusy = false;
      if (coachingRegenPending) scheduleCoachingRegen(coachingRegenPending);
    }
  }

  /** 身高 / 体重变化时实时刷新 BMI 显示 */
  function refreshBmiPreview() {
    const heightInput = document.querySelector('[data-profile-field="height"]');
    const weightInput = document.querySelector('[data-profile-field="weight"]');
    const bmiEl = $('#profile-bmi');
    if (!heightInput || !weightInput || !bmiEl) return;

    const bmi = calcBmi(Number(heightInput.value), Number(weightInput.value));
    bmiEl.textContent = bmi === null ? '--' : bmi;
  }

  /** 身材信息实时编辑：输入即存、选择即存、器械点选即存 */
  function bindProfileEditor() {
    // 身高 / 体重：输入时实时更新 BMI，合法值立即写入本地存储
    document.addEventListener('input', function (event) {
      const input = event.target.closest('[data-profile-field]');
      if (!input) return;

      const field = input.getAttribute('data-profile-field');
      if (field !== 'height' && field !== 'weight') return;

      refreshBmiPreview();

      const value = Number(input.value);
      const valid = field === 'height'
        ? value >= 120 && value <= 230
        : value >= 30 && value <= 200;

      if (valid) updateProfileField(field, value, { silent: true });
    });

    // 目标 / 每周天数：选择后立即保存
    document.addEventListener('change', function (event) {
      const control = event.target.closest('select[data-profile-field]');
      if (!control) return;

      const field = control.getAttribute('data-profile-field');

      if (field === 'goal') {
        updateProfileField('goal', control.value, { silent: true });
        renderHomeState();
        return;
      }

      if (field === 'daysPerWeek') {
        updateProfileField('daysPerWeek', Number(control.value), { silent: true });
        renderHomeState();
      }
    });

    // 器械：点选切换，至少保留一种
    document.addEventListener('click', function (event) {
      const chip = event.target.closest('[data-profile-equipment]');
      if (!chip) return;

      const user = currentUser();
      if (!user) return;

      const key = chip.getAttribute('data-profile-equipment');
      const list = (user.equipment || []).slice();
      const index = list.indexOf(key);

      if (index >= 0) list.splice(index, 1);
      else list.push(key);

      if (!list.length) {
        showToast('至少保留一种器械哦');
        return;
      }

      updateProfileField('equipment', list, { silent: true });
      renderHomeState();

    });
  }

  /** 首页双状态：无当前用户显示录入表单，有用户显示个人主页 */
  function renderHomeState() {
    const user = currentUser();
    const form = $('#profile-form');
    const result = $('#home-result');
    const profileBox = $('#home-profile');

    // 顶部总控栏标题：未添加用户时引导填写，已有用户时给一句鼓励
    const heroTitle = $('#home-hero-title');
    if (heroTitle) {
      heroTitle.textContent = user && !state.addingUser
        ? '⚡ 今天也要一起变强！'
        : '📝 请先告诉我你的情况';
    }

    if (!user || state.addingUser) {
      if (profileBox) {
        profileBox.hidden = true;
        profileBox.innerHTML = '';
      }
      if (form) form.hidden = false;
      if (result) result.hidden = false;
      return;
    }

    if (form) form.hidden = true;
    // 个人主页用快捷入口替代冗长的方案摘要
    if (result) result.hidden = true;
    if (profileBox) {
      profileBox.hidden = false;
      profileBox.innerHTML = renderHomeProfileHtml(user);
      bindMascotFallback();
      animateCounters(profileBox);
    }
  }

  /** 各页面顶部的「为 X 定制」标签 */
  function renderPageTags() {
    const user = currentUser();
    const text = user ? '为 ' + (user.nickname || '你') + ' 定制' : '';

    ['#tag-training', '#tag-review', '#tag-diet', '#tag-calendar'].forEach(function (selector) {
      const el = $(selector);
      if (!el) return;
      el.hidden = !user;
      el.textContent = text;
    });
  }

  /* ============================ 首页：信息收集 ============================ */

  function selectDays(days) {
    $$('#days-chips .chip').forEach(function (chip) {
      chip.classList.toggle('is-active', Number(chip.getAttribute('data-days')) === days);
    });
    const hidden = $('#daysPerWeek');
    if (hidden) hidden.value = String(days);
  }

  function collectProfile() {
    const form = $('#profile-form');
    const data = new FormData(form);
    const nicknameInput = $('#nickname');
    return {
      nickname: nicknameInput ? nicknameInput.value.trim() : '',
      goal: data.get('goal'),
      gender: data.get('gender'),
      age: toPositiveNumber(data.get('age')),
      height: toPositiveNumber(data.get('height')),
      weight: toPositiveNumber(data.get('weight')),
      daysPerWeek: toPositiveNumber($('#daysPerWeek').value),
      equipment: data.getAll('equipment').map(String),
      injuries: App.normalizeStringArray($('#injuries').value, [])
    };
  }

  function fillFormFromState() {
    const profile = state.profile;
    if (!profile) return;

    const setValue = function (selector, value) {
      const el = $(selector);
      if (el && value !== undefined && value !== null) el.value = value;
    };

    setValue('#goal', profile.goal);
    setValue('#nickname', profile.nickname || '');
    setValue('#gender', profile.gender);
    setValue('#age', profile.age);
    setValue('#height', profile.height);
    setValue('#weight', profile.weight);
    setValue('#injuries', (profile.injuries || []).join('，'));
    selectDays(profile.daysPerWeek);

    $$('#equipment-chips input[name="equipment"]').forEach(function (input) {
      const checked = (profile.equipment || []).indexOf(input.value) >= 0;
      input.checked = checked;
      input.closest('.chip').classList.toggle('is-active', checked);
    });
  }

  function bindHome() {
    const form = $('#profile-form');
    if (!form) return;

    form.addEventListener('submit', handleGenerate);

    // 首页答疑对话框
    bindQaForm('#home-qa-form');

    $$('#days-chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        selectDays(Number(chip.getAttribute('data-days')));
      });
    });

    $$('#equipment-chips input[name="equipment"]').forEach(function (input) {
      input.addEventListener('change', function () {
        input.closest('.chip').classList.toggle('is-active', input.checked);
      });
    });
  }

  async function handleGenerate(event) {
    event.preventDefault();

    if (typeof App.coachAgent !== 'function') {
      showToast('Agent 脚本未加载，请检查 index.html 的脚本顺序');
      return;
    }

    const profile = collectProfile();
    if (!profile.nickname) {
      showToast('请先填写昵称');
      return;
    }
    if (!profile.equipment.length) {
      showToast('请至少选择一种器械；没有器械请选择「徒手」');
      return;
    }

    if (!store) {
      showToast('存储模块未加载，无法保存用户');
      return;
    }

    const button = $('#generate-btn');
    setBusy(button, true, '教练 Agent 正在调度…');
    renderSkeleton();

    const trace = runAgentTrace(AGENT_STEPS);

    try {
      // ① 先落用户档案：新用户直接建档并切换过去，原有用户数据完整保留
      const existing = currentUser();
      const now = new Date().toISOString();
      let user;

      if (existing && !state.addingUser) {
        user = Object.assign({}, existing, profile, { updatedAt: now });
        store.saveUsers(getUsers().map(function (item) {
          return item.id === user.id ? user : item;
        }));
      } else {
        user = Object.assign({ id: store.createUserId(), createdAt: now }, profile);
        const users = getUsers();
        users.push(user);
        store.saveUsers(users);
        store.setCurrentUserId(user.id);
      }

      // ② 保存后自动生成训练计划与营养方案，不再需要单独点生成
      const result = await App.coachAgent(profile);

      // 让调度可视化至少完整展示一轮，再补「已汇总」收尾
      await trace;
      await finishAgentTrace(true);

      state.profile = Object.assign({}, result.profile || {}, {
        nickname: profile.nickname
      });
      state.coaching = result;
      persistState();

      // ③ 刷新个人主页与各页面数据
      state.addingUser = false;
      updateUserEntry();
      renderHomeState();
      renderPageTags();
      renderTrainingPage();
      renderPlanGuides();
      renderDietDraft();
      fillFormFromState();

      showToast(
        result.errors && result.errors.length
          ? '已创建「' + profile.nickname + '」，部分方案生成失败'
          : '已创建「' + profile.nickname + '」并生成训练计划 🎉'
      );
    } catch (error) {
      finishAgentTrace(false);
      console.error('[main] coachAgent 调用失败', error);
      renderGenerateError(error);
      showToast('生成失败：' + (error && error.message ? error.message : error));
    } finally {
      setBusy(button, false, '✨ 生成我的方案');
    }
  }

  /* ============================ 首页：结果渲染 ============================ */

  function renderSkeleton() {
    const root = $('#home-result');
    if (!root) return;
    root.innerHTML =
      '<div class="card skeleton-card">' +
      '<div class="skeleton w40"></div>' +
      '<div class="skeleton w80"></div>' +
      '<div class="skeleton w60"></div>' +
      '</div>' +
      '<div class="card skeleton-card">' +
      '<div class="skeleton w30"></div>' +
      '<div class="skeleton w90"></div>' +
      '</div>';
  }

  function renderGenerateError(error) {
    const root = $('#home-result');
    if (!root) return;
    root.innerHTML =
      '<div class="card empty">' +
      '<p class="empty-title">方案生成失败</p>' +
      '<p class="muted">' + esc(error && error.message ? error.message : error) + '</p>' +
      '</div>';
  }

  function renderCoachingResult(result) {
    const root = $('#home-result');
    if (!root) return;

    if (!result || (!result.trainingPlan && !result.nutritionPlan)) {
      renderGenerateError(new Error('训练计划与营养方案均为空，请重试'));
      return;
    }

    const profile = result.profile || App.normalizeUserProfile({});
    const plan = result.trainingPlan;
    const diet = result.nutritionPlan;
    const errors = result.errors || [];
    const dispatcher = (result._meta && result._meta.dispatcher) || [];

    const profileLine = [
      App.GoalLabel[profile.goal] || profile.goal,
      profile.height + ' cm',
      profile.weight + ' kg',
      '每周 ' + profile.daysPerWeek + ' 天',
      (profile.equipment || []).map(function (key) {
        return App.EquipmentLabel[key] || key;
      }).join(' / ')
    ].join(' · ');

    const errorsHtml = errors.length
      ? '<div class="alert">' + errors.map(function (item) {
          return '<b>' + esc(item.agent) + '</b>：' + esc(item.message);
        }).join('<br>') + '</div>'
      : '';

    const trainingHtml = plan
      ? renderTrainingCard(plan)
      : '<div class="card"><p class="muted">训练计划生成失败</p></div>';

    const dietHtml = diet
      ? renderDietCard(diet)
      : '<div class="card"><p class="muted">营养方案生成失败</p></div>';

    const planIsReal = plan && plan._meta && plan._meta.placeholder === false;
    const dietIsReal = diet && diet._meta && diet._meta.placeholder === false;
    const resultBadge =
      planIsReal && dietIsReal
        ? '规则生成'
        : planIsReal || dietIsReal
          ? '部分占位数据'
          : '占位数据';

    root.innerHTML =
      '<div class="card result-head">' +
        '<div class="card-head">' +
          '<h2>' + esc(plan ? plan.title : '你的专属方案') + '</h2>' +
          '<span class="badge badge-warn">' + resultBadge + '</span>' +
        '</div>' +
        '<p class="muted">' + esc(profileLine) + '</p>' +
        '<p class="meta-line">planId：' + esc(result.planId) + ' · 调度耗时 ' +
          esc(result.elapsedMs || 0) + ' ms · 子 Agent：' + esc(dispatcher.join(' + ')) + '</p>' +
        errorsHtml +
      '</div>' +
      '<div class="result-grid">' + trainingHtml + dietHtml + '</div>' +
      '<div class="card">' +
        '<div class="card-head"><h3>Agent 调度链路</h3><span class="tag">架构说明</span></div>' +
        '<div class="flow">' +
          '<span>用户档案</span><i>→</i><span>CoachAgent</span><i>→</i>' +
          '<span>TrainingAgent</span><i>+</i><span>DietAgent</span>' +
        '</div>' +
        '<p class="hint">后续填充实现时，只需替换各 Agent 内部逻辑，本页面无需改动。</p>' +
      '</div>';
  }

  function renderTrainingCard(plan) {
    const daysHtml = plan.weeklyPlan.map(function (day) {
      const isRest = Boolean(day.isRest);
      const meta = isRest
        ? '恢复'
        : day.durationMin + ' 分钟 · ' + (INTENSITY_LABEL[day.intensity] || '');
      return (
        '<li class="day-item ' + (isRest ? 'is-rest' : 'is-train') + '">' +
          '<span class="day-name">' + (DAY_NAMES[day.dayIndex - 1] || '第' + day.dayIndex + '天') + '</span>' +
          '<span class="day-focus">' + esc(day.focus) + '</span>' +
          '<span class="day-meta">' + esc(meta) + '</span>' +
        '</li>'
      );
    }).join('');

    const detailHtml = plan.weeklyPlan
      .filter(function (day) {
        return !day.isRest;
      })
      .map(function (day) {
        const dailyWarmup =
          day.warmup && day.warmup.items && day.warmup.items.length
            ? renderPlanBlock('热身 ' + day.warmup.durationMin + ' 分钟', day.warmup.items)
            : '';
        const dailyCooldown =
          day.cooldown && day.cooldown.items && day.cooldown.items.length
            ? renderPlanBlock('拉伸 ' + day.cooldown.durationMin + ' 分钟', day.cooldown.items)
            : '';
        return (
          '<details class="day-detail">' +
            '<summary>' + (DAY_NAMES[day.dayIndex - 1] || '') + ' · ' + esc(day.focus) + '</summary>' +
            dailyWarmup +
            renderExerciseList(day.exercises) +
            dailyCooldown +
          '</details>'
        );
      })
      .join('');

    // 每日计划已带热身 / 拉伸时，不再重复展示顶层通用版本
    const hasDailyRoutine = plan.weeklyPlan.some(function (day) {
      return day.warmup && day.warmup.items && day.warmup.items.length;
    });

    const generalRoutine =
      hasDailyRoutine || !plan.warmup
        ? ''
        : renderPlanBlock('通用热身 ' + plan.warmup.durationMin + ' 分钟', plan.warmup.items) +
          renderPlanBlock('通用拉伸 ' + plan.cooldown.durationMin + ' 分钟', plan.cooldown.items);

    return (
      '<div class="card">' +
        '<div class="card-head"><h3>一周训练计划</h3><span class="tag">TrainingAgent</span></div>' +
        '<ul class="day-list">' + daysHtml + '</ul>' +
        detailHtml +
        generalRoutine +
        renderPlanBlock('注意事项', plan.notes) +
      '</div>'
    );
  }

  function renderPlanBlock(title, items) {
    return (
      '<div class="mini-block">' +
        '<h4>' + esc(title) + '</h4>' +
        '<ul class="dot-list">' + (items || []).map(function (item) {
          return '<li>' + esc(item) + '</li>';
        }).join('') + '</ul>' +
      '</div>'
    );
  }

  function renderExerciseList(exercises) {
    if (!exercises || !exercises.length) return '<p class="muted">休息日</p>';
    return (
      '<ul class="exercise-list">' + exercises.map(function (item) {
        const spec = item.durationMin
          ? esc(item.reps)
          : esc(item.sets) + ' 组 × ' + esc(item.reps) + ' · 休息 ' + esc(item.restSec) + 's';
        return (
          '<li>' +
            '<span class="ex-name">' + exerciseEmoji(item.name) + ' ' + esc(item.name) + '</span>' +
            '<span class="ex-spec">' + spec + '</span>' +
            '<span class="ex-target">' + esc(item.target) + '</span>' +
            (item.note ? '<span class="ex-note">' + esc(item.note) + '</span>' : '') +
          '</li>'
        );
      }).join('') + '</ul>'
    );
  }

  function renderDietCard(diet) {
    const macros = diet.macros || { protein: 0, carbs: 0, fat: 0 };
    const percent = diet.macroPercent || {};
    const hydration = diet.hydration || null;
    const trainingDay = diet.trainingDay || null;
    const restDay = diet.restDay || null;

    const goalAdjust = Number(diet.goalAdjust) || 0;
    const adjustText = (goalAdjust > 0 ? '+' : '') + goalAdjust;
    const formulaText = diet.meta && diet.meta.formula ? diet.meta.formula : '规则公式';

    const energyHtml =
      '<div class="macro-row">' +
        '<div class="macro"><span>🔥 基础代谢</span><b>' + esc(diet.bmr || '--') + '</b><em>kcal</em></div>' +
        '<div class="macro"><span>⚡ 活动系数</span><b>' + esc(diet.activityFactor || '--') + '</b><em>倍</em></div>' +
        '<div class="macro"><span>🔥 每日总消耗</span><b>' + esc(diet.tdee || '--') + '</b><em>kcal</em></div>' +
      '</div>';

    const macroHtml =
      '<div class="macro-row">' +
        '<div class="macro"><span>🥩 蛋白质</span><b>' + esc(macros.protein) + ' g</b><em>' +
          esc(percent.protein || 0) + '%</em></div>' +
        '<div class="macro"><span>🍚 碳水</span><b>' + esc(macros.carbs) + ' g</b><em>' +
          esc(percent.carbs || 0) + '%</em></div>' +
        '<div class="macro"><span>🥑 脂肪</span><b>' + esc(macros.fat) + ' g</b><em>' +
          esc(percent.fat || 0) + '%</em></div>' +
      '</div>';

    const dayEnergyHtml =
      trainingDay && restDay
        ? '<div class="day-energy">' +
            '<div class="day-energy-item">' +
              '<span class="day-energy-label">训练日</span>' +
              '<b>' + esc(trainingDay.calories) + ' kcal</b>' +
              '<span class="day-energy-note">碳水 +' + esc(trainingDay.carbsExtraGrams || 0) + ' g</span>' +
            '</div>' +
            '<div class="day-energy-item is-rest">' +
              '<span class="day-energy-label">休息日</span>' +
              '<b>' + esc(restDay.calories) + ' kcal</b>' +
              '<span class="day-energy-note">蛋白质不变 · 主食减少</span>' +
            '</div>' +
          '</div>' +
          '<p class="hint">' + esc(trainingDay.note || '') + '</p>'
        : '';

    const hydrationHtml = hydration
      ? renderPlanBlock(
          '补水建议 · 日常 ' + hydration.dailyLiters + ' L / 训练日 ' +
            hydration.trainingDayLiters + ' L',
          hydration.tips
        )
      : '';

    return (
      '<div class="card">' +
        '<div class="card-head"><h3>营养方案</h3><span class="tag">DietAgent</span></div>' +
        '<div class="kcal"><b>' + esc(diet.targetCalories) + '</b><span>kcal / 日目标</span></div>' +
        '<p class="meta-line">目标调整 ' + adjustText + ' kcal · ' + esc(formulaText) + '</p>' +
        energyHtml +
        macroHtml +
        dayEnergyHtml +
        '<ul class="meal-list">' + (diet.meals || []).map(function (meal) {
          return (
            '<li>' +
              '<div class="meal-head"><b>' + esc(meal.name) + '</b>' +
                '<span>' + esc(meal.time) + ' · ' + esc(meal.calories) + ' kcal</span></div>' +
              '<p class="meal-foods">' + (meal.foods || []).map(function (food) {
                return esc(food.food) + ' ' + esc(food.amount);
              }).join(' · ') + '</p>' +
            '</li>'
          );
        }).join('') + '</ul>' +
        hydrationHtml +
        renderPlanBlock('饮食建议', diet.tips) +
        '<p class="disclaimer-note">饮食建议仅供参考，特殊疾病人群请咨询医生或营养师</p>' +
      '</div>'
    );
  }

  /* ============================ 训练模式 ============================ */

  function renderTrainingPage() {
    const root = $('#today-training');
    if (!root) return;

    const plan = state.coaching && state.coaching.trainingPlan;
    if (!plan) {
      // 未生成训练计划：给出统一空状态引导，而不是只显示一行灰字
      root.innerHTML =
        '<div class="empty-guide">' +
          '<p class="empty-guide-title">请先在首页生成训练计划 📝</p>' +
          '<p class="muted">填写目标与身体信息后，训练 Agent 会生成一周计划，这里会自动读取今天的安排。</p>' +
          '<button type="button" class="btn-secondary" data-go-home>去首页生成</button>' +
        '</div>';
      return;
    }

    const dayIndex = (new Date().getDay() + 6) % 7;
    const day = plan.weeklyPlan[dayIndex];

    if (!day || day.isRest) {
      root.innerHTML =
        personaHtml('training', 'intro') +
        '<div class="day-item is-rest">' +
          '<span class="day-name">今天</span>' +
          '<span class="day-focus">休息 / 主动恢复</span>' +
          '<span class="day-meta">第 ' + (dayIndex + 1) + ' 天</span>' +
        '</div>' +
        '<p class="hint">建议散步 20~30 分钟，保证睡眠。</p>' +
        personaHtml('training', 'outro');
      return;
    }

    root.innerHTML =
      personaHtml('training', 'intro') +
      '<div class="day-item is-train">' +
        '<span class="day-name">今天</span>' +
        '<span class="day-focus">' + esc(day.focus) + '</span>' +
        '<span class="day-meta">' + esc(day.durationMin) + ' 分钟 · ' +
          esc(INTENSITY_LABEL[day.intensity] || '') + '</span>' +
      '</div>' +
      renderExerciseList(day.exercises) +
      personaHtml('training', 'outro');
  }

  /* ============================ 训练模式 / 姿势评测 ============================ */

  let postureDetector = null;
  let trainer = null;

  /** 姿势能力清单 */
  function renderPostureCapabilities() {
    const root = $('#posture-capabilities');
    if (!root) return;

    const caps = {
      camera: true,
      poseDetection: true,
      repCounting: true,
      voiceCoaching: true,
      holdTimer: true
    };

    const items = [
      ['camera', '摄像头画面'],
      ['poseDetection', '33 个骨架关键点'],
      ['repCounting', '9 个动作计数'],
      ['voiceCoaching', '语音纠正'],
      ['holdTimer', '平板支撑计时']
    ];

    root.innerHTML = items.map(function (pair) {
      const enabled = Boolean(caps[pair[0]]);
      return (
        '<li class="' + (enabled ? 'is-on' : 'is-off') + '">' +
          '<span class="dot"></span>' + esc(pair[1]) +
          '<span class="cap-state">' + (enabled ? '已接入' : '待接入') + '</span>' +
        '</li>'
      );
    }).join('');
  }

  /** 更新画面上方的状态角标与占位提示 */
  function updatePostureStatus(stateName, message) {
    const badge = $('#posture-status');
    const placeholder = $('#posture-placeholder');

    if (badge) {
      const labels = {
        idle: '未开始',
        loading: '加载模型',
        running: '检测中',
        error: '启动失败'
      };
      badge.textContent =
        stateName === 'idle' && message ? message : labels[stateName] || message || stateName;
      badge.classList.toggle('is-active', stateName === 'running');
      badge.classList.toggle('is-error', stateName === 'error');
    }

    if (placeholder) {
      const hidden = stateName === 'running' || stateName === 'loading';
      placeholder.classList.toggle('is-hidden', hidden);

      if (stateName === 'error') {
        placeholder.textContent = message || '启动失败，请重试';
      } else if (stateName === 'idle' && message) {
        placeholder.textContent = '已停止，点击「开始训练」可重新启动';
      } else {
        placeholder.textContent = '点击下方「开始训练」启动摄像头';
      }
    }
  }

  /** 更新关键点数量角标 */
  function updatePostureCount(visible, total) {
    const count = $('#posture-count');
    if (count) count.textContent = '关键点 ' + (visible || 0) + ' / ' + (total || 33);
  }

  /** 更新计数 / 计时角标 */
  function updatePostureReps(count, unit) {
    const reps = $('#posture-reps');
    if (!reps) return;

    if (unit === '秒') {
      reps.textContent = '坚持 ' + (count || 0) + ' 秒';
    } else {
      reps.textContent = '计数 ' + (count || 0) + ' 次';
    }
  }

  /** 当前选中的动作 id */
  function selectedExerciseId() {
    const active = $('#exercise-picker .chip.is-active');
    return active ? active.getAttribute('data-exercise') : 'squat';
  }

  /** 切换动作：更新按钮、提示，并重置检测器状态 */
  function selectExercise(id) {
    const config = window.PostureDetector ? window.PostureDetector.getExercise(id) : null;
    const targetId = config ? config.id : id;

    $$('#exercise-picker .chip').forEach(function (chip) {
      chip.classList.toggle('is-active', chip.getAttribute('data-exercise') === targetId);
    });

    const hint = $('#posture-exercise-hint');
    if (hint) hint.textContent = config ? config.hint : '';

    if (postureDetector) postureDetector.setExercise(targetId);

    updatePostureReps(0, config && config.mode === 'hold' ? '秒' : '次');
  }

  /** 开始训练：请求摄像头并启动 Pose 检测 */
  async function startPosture() {
    const startButton = $('#posture-start');
    const stopButton = $('#posture-stop');

    if (!window.PostureDetector) {
      showToast('js/posture.js 未加载');
      return;
    }

    if (!postureDetector) {
      const video = $('#posture-video');
      const canvas = $('#posture-canvas');
      if (!video || !canvas) {
        showToast('视频元素未找到');
        return;
      }

      postureDetector = window.PostureDetector.create({
        video: video,
        canvas: canvas,
        alertRoot: $('#posture-alert'),
        alertText: $('#posture-alert-text'),
        alertCanvas: $('#posture-alert-canvas'),
        alertClose: $('#posture-alert-close'),
        onStatus: updatePostureStatus,
        onCount: updatePostureCount,
        onReps: function (count, unit) {
          updatePostureReps(count, unit);
          // 训练流程开启时，把实时计数转发给 Trainer
          if (trainer) trainer.handleReps(count, unit);
        }
      });

      postureDetector.setExercise(selectedExerciseId());
    }

    setBusy(startButton, true, '启动中…');
    updatePostureStatus('loading', '正在请求摄像头权限…');

    const result = await postureDetector.start();

    setBusy(startButton, false, '开始训练');

    if (!result.ok) {
      showToast(result.message || '姿势检测启动失败');
      updatePostureCount(0, 33);
      return;
    }

    if (startButton) startButton.hidden = true;
    if (stopButton) stopButton.hidden = false;

    // 语音能力自检：缺少中文语音包时明确告知，而不是静默无声
    if (window.PostureDetector && typeof window.PostureDetector.getSpeechDiagnostics === 'function') {
      const speech = window.PostureDetector.getSpeechDiagnostics();
      if (!speech.supported) {
        showToast('当前浏览器不支持语音播报，计数会改用提示音');
      } else if (!speech.chineseVoice) {
        showToast('未检测到中文语音包，报数可能无声；可在系统设置中添加中文语音');
      }
    }
  }

  /** 停止训练：关闭摄像头并清理画面 */
  async function stopPosture() {
    if (!postureDetector) return;

    await postureDetector.stop();

    const startButton = $('#posture-start');
    const stopButton = $('#posture-stop');
    if (startButton) startButton.hidden = false;
    if (stopButton) stopButton.hidden = true;
  }

  function bindTrainingPage() {
    const startButton = $('#posture-start');
    const stopButton = $('#posture-stop');

    if (startButton) {
      startButton.addEventListener('click', function () {
        confirmTrainingSafety(startPosture);
      });
    }
    if (stopButton) stopButton.addEventListener('click', stopPosture);

    // 动作选择：默认深蹲
    $$('#exercise-picker .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        selectExercise(chip.getAttribute('data-exercise'));
      });
    });

    // 今日训练流程按钮
    const trainerStart = $('#trainer-start');
    const trainerStop = $('#trainer-stop');
    const trainerComplete = $('#trainer-complete-set');

    if (trainerStart) {
      trainerStart.addEventListener('click', function () {
        confirmTrainingSafety(startTrainer);
      });
    }
    if (trainerStop) trainerStop.addEventListener('click', stopTrainer);
    if (trainerComplete) {
      trainerComplete.addEventListener('click', function () {
        if (trainer) trainer.completeCurrentSet();
      });
    }

    // 自由训练 / 计划训练切换
    $$('#training-mode-switch .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        setTrainingMode(chip.getAttribute('data-training-mode'));
      });
    });

    renderPostureCapabilities();
    updatePostureStatus('idle');
    updatePostureCount(0, 33);
    selectExercise('squat');
    setTrainingMode('free');
    renderTrainerState({ phase: 'idle' });

    // 切到其他 Tab 时关闭摄像头并停止训练流程
    window.addEventListener('hashchange', function () {
      if (currentTab() !== 'training') {
        if (trainer && trainer.isRunning()) stopTrainer();
        else if (postureDetector && postureDetector.isRunning()) stopPosture();
      }
    });
  }

  /* ============================ 今日训练流程 ============================ */

  /** 当前训练模式：free 自由训练 / plan 计划训练 */
  let trainingMode = 'free';

  /** 切换自由训练 / 计划训练 */
  function setTrainingMode(mode) {
    const target = mode === 'plan' ? 'plan' : 'free';
    trainingMode = target;

    $$('#training-mode-switch .chip').forEach(function (chip) {
      chip.classList.toggle(
        'is-active',
        chip.getAttribute('data-training-mode') === target
      );
    });

    const freePanel = $('#free-training-panel');
    const freeActions = $('#posture-actions');
    const planPanel = $('#plan-training-panel');
    const planHint = $('#plan-training-hint');
    const modeHint = $('#training-mode-hint');

    if (freePanel) freePanel.hidden = target !== 'free';
    if (freeActions) freeActions.hidden = target !== 'free';
    if (planPanel) planPanel.hidden = target !== 'plan';
    if (planHint) planHint.hidden = target !== 'plan';

    if (modeHint) {
      modeHint.textContent = target === 'free'
        ? '自由训练：手动选择动作并开始评测。'
        : '计划训练：读取今日计划，自动切换动作、计数并语音引导。';
    }

    // 切换模式时停止另一种模式的运行状态
    if (target === 'plan') {
      if (postureDetector && postureDetector.isRunning()) stopPosture();
      renderTrainerState({ phase: 'idle' });
    } else if (trainer) {
      const trainerState = trainer.getState ? trainer.getState() : { phase: 'idle' };
      if (trainer.isRunning() || trainerState.phase === 'finished') {
        stopTrainer();
      }
    }
  }

  /** 取今日训练计划（按周一到周日映射） */
  function getTodayPlan() {
    if (!state.coaching || !state.coaching.trainingPlan) return null;

    const todayIndex = (new Date().getDay() + 6) % 7;
    return state.coaching.trainingPlan.weeklyPlan[todayIndex] || null;
  }

  /**
   * 训练流程语音：统一走姿势评测 Agent 的语音管理器。
   * high 计数报数最优先；normal / low 在忙时排队。
   */
  function speakTrainer(text, priority) {
    if (!text) return;

    if (window.PostureDetector && typeof window.PostureDetector.speak === 'function') {
      window.PostureDetector.speak(text, priority || 'normal');
      return;
    }

    // 兜底：库未加载时直接使用浏览器语音
    if (!('speechSynthesis' in window)) return;

    const synth = window.speechSynthesis;
    try {
      // 语音引擎被挂起时先唤醒，否则播报无声
      if (synth.paused) synth.resume();

      // cancel 与 speak 不能在同一 tick，Chrome 会把新语音一起丢弃
      if (priority === 'high') synth.cancel();

      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = priority === 'high' ? 1.3 : 1.05;
      utterance.volume = 1;

      const delay = priority === 'high' ? 90 : 0;
      setTimeout(function () {
        try {
          synth.speak(utterance);
        } catch (error) {
          console.warn('[trainer] 语音播报失败', error);
        }
      }, delay);
    } catch (error) {
      console.warn('[trainer] 语音播报失败', error);
    }
  }

  // 首次点击 / 触摸时唤醒语音引擎：部分浏览器空闲后会挂起语音，导致后续播报静音
  window.addEventListener('pointerdown', function warmUpSpeech() {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.getVoices();
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    } catch (error) {
      /* 忽略唤醒失败 */
    }
  }, { once: true });

  /** 渲染训练流程进度与按钮状态 */
  function renderTrainerState(snapshot) {
    const data = snapshot || { phase: 'idle' };
    const phase = data.phase || 'idle';

    const status = $('#trainer-status');
    const progress = $('#trainer-progress');
    const startButton = $('#trainer-start');
    const stopButton = $('#trainer-stop');
    const completeButton = $('#trainer-complete-set');

    if (startButton) {
      startButton.hidden = phase === 'work' || phase === 'rest' || phase === 'transition';
    }
    if (stopButton) stopButton.hidden = phase === 'idle' || phase === 'finished';
    if (progress) progress.hidden = phase === 'idle';

    if (status) {
      status.classList.toggle('is-rest', phase === 'rest');

      if (phase === 'idle') {
        status.textContent = '点击「开始今日训练」，会按计划逐组引导并自动计数。';
      } else if (phase === 'finished') {
        status.innerHTML = '<strong>今日训练已完成</strong>，结果已写入打卡复盘。';
      } else if (phase === 'transition') {
        status.innerHTML = '正在切换动作，准备下一项…';
      } else if (phase === 'rest') {
        status.innerHTML = '组间休息：<strong>' + (data.restRemaining || 0) +
          ' 秒</strong>，放松呼吸，准备下一组。';
      } else {
        const unit = data.unit === '秒' ? '秒' : '次';
        status.innerHTML = '正在训练：<strong>' + esc(data.exerciseName || '') +
          '</strong> · 第 ' + ((data.setIndex || 0) + 1) + ' / ' + (data.setTotal || 0) +
          ' 组 · 本组目标 ' + (data.targetReps || 0) + ' ' + unit;
      }
    }

    if (phase !== 'idle') {
      const exercise = $('#trainer-exercise');
      const exerciseIndex = $('#trainer-exercise-index');
      const set = $('#trainer-set');
      const reps = $('#trainer-reps');
      const rest = $('#trainer-rest');

      if (exercise) exercise.textContent = data.exerciseName || '--';
      if (exerciseIndex) {
        exerciseIndex.textContent =
          ((data.exerciseIndex || 0) + 1) + ' / ' + (data.exerciseTotal || 0);
      }
      if (set) {
        set.textContent = ((data.setIndex || 0) + 1) + ' / ' + (data.setTotal || 0);
      }
      if (reps) {
        reps.textContent = (data.reps || 0) + ' / ' + (data.targetReps || 0) +
          ' ' + (data.unit === '秒' ? '秒' : '次');
      }
      if (rest) {
        rest.textContent = phase === 'rest' ? (data.restRemaining || 0) + ' 秒' : '--';
        rest.classList.toggle('is-rest', phase === 'rest');
      }
    }

    if (completeButton) {
      const detectorReady = postureDetector && postureDetector.isRunning();
      const needManual = phase === 'work' && (!data.auto || !detectorReady);
      completeButton.hidden = !needManual;
    }
  }

  /** 开始今日训练：启动摄像头 → 创建 Trainer → 执行计划 */
  async function startTrainer() {
    if (!window.Trainer) {
      showToast('js/trainer.js 未加载');
      return;
    }

    const dayPlan = getTodayPlan();
    if (!dayPlan) {
      speakTrainer('请先在首页生成训练计划', 'normal');
      showToast('还没有今日训练计划，请先在首页生成方案');
      return;
    }
    if (dayPlan.isRest) {
      speakTrainer('今天是休息日，好好恢复', 'normal');
      showToast('今天是休息日，好好恢复');
      return;
    }
    if (!dayPlan.exercises || !dayPlan.exercises.length) {
      speakTrainer('今日计划没有训练动作', 'normal');
      showToast('今日计划没有训练动作');
      return;
    }

    // 自动计数依赖摄像头，未启动时先尝试启动
    if (!postureDetector || !postureDetector.isRunning()) {
      await startPosture();
    }

    if (!trainer) {
      trainer = window.Trainer.create({
        getDetector: function () { return postureDetector; },
        speak: speakTrainer,
        onChange: renderTrainerState,
        onComplete: handleTrainingComplete
      });
    }

    const result = trainer.start(dayPlan);
    if (!result.ok) {
      showToast(result.message || '训练启动失败');
      return;
    }

    if (!postureDetector || !postureDetector.isRunning()) {
      showToast('摄像头未启动，支持自动计数的动作请用「完成本组（手动）」推进');
    }
  }

  /** 停止训练流程并关闭摄像头 */
  function stopTrainer() {
    if (trainer) trainer.stop();
    if (postureDetector && postureDetector.isRunning()) stopPosture();
    renderTrainerState({ phase: 'idle' });
  }

  /** 训练全部完成：写入训练会话与打卡复盘 */
  function handleTrainingComplete(summary) {
    const today = todayStr();
    const existing = state.checkins.find(function (item) {
      return item.date === today;
    });

    const exercises = summary && Array.isArray(summary.exercises)
      ? summary.exercises
      : [];
    const done = exercises.filter(function (item) {
      return !item.skipped;
    });
    const summaryText = done.map(function (item) {
      return item.name + ' ' + item.completedSets + '组×' + item.targetReps + item.unit;
    }).join('；');

    // 详细完成情况写入本地存储，供打卡复盘页使用
    state.trainingSessions.push({
      date: today,
      startedAt: summary ? summary.startedAt : '',
      finishedAt: summary ? summary.finishedAt : new Date().toISOString(),
      exercises: exercises
    });
    state.trainingSessions = state.trainingSessions.slice(-30);

    const checkin = {
      date: today,
      completed: true,
      completionRate: 1,
      feeling: existing && existing.feeling ? existing.feeling : 'ok',
      rpe: existing && existing.rpe ? existing.rpe : 6,
      sleepHours: existing ? existing.sleepHours : undefined,
      bodyWeight: existing ? existing.bodyWeight : undefined,
      note: '完成今日训练流程' + (summaryText ? '：' + summaryText : '')
    };

    // 先合并本次训练的姿势纠正次数，让复盘统计能读到
    if (postureDetector && typeof postureDetector.getCorrectionStats === 'function') {
      const stats = postureDetector.getCorrectionStats();
      Object.keys(stats).forEach(function (name) {
        state.correctionStats[name] = (state.correctionStats[name] || 0) + stats[name];
      });
    }

    saveCheckinRecord(checkin);

    if (postureDetector && postureDetector.isRunning()) {
      stopPosture();
    }

    // 训练完成后弹出提示，引导用户去查看复盘
    openTrainingCompleteModal();
  }

  /** 训练完成弹层：提示「训练完成！去查看复盘报告」 */
  function openTrainingCompleteModal() {
    const modal = $('#training-complete-modal');
    if (!modal) return;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    celebrateConfetti();
  }

  function closeTrainingCompleteModal() {
    const modal = $('#training-complete-modal');
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }

  /** 绑定完成弹层：关闭 / 去查看复盘 */
  function bindTrainingCompleteModal() {
    const modal = $('#training-complete-modal');
    if (!modal) return;

    modal.addEventListener('click', function (event) {
      if (event.target.closest('[data-close-complete]')) {
        closeTrainingCompleteModal();
        return;
      }

      if (event.target.closest('[data-go-review]')) {
        closeTrainingCompleteModal();
        pendingReviewFocus = 'report';
        if (location.hash === '#review') switchTab('review');
        else location.hash = 'review';
      }
    });
  }

  /* ============================ 训练前安全提示 ============================ */

  /** 安全确认后要执行的动作（自由训练 / 计划训练） */
  let safetyPendingAction = null;

  function openSafetyModal() {
    const modal = $('#training-safety-modal');
    if (!modal) return;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeSafetyModal() {
    const modal = $('#training-safety-modal');
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }

  /** 训练前确认：已记住则直接开始，否则先弹安全提示 */
  function confirmTrainingSafety(action) {
    let remembered = false;

    try {
      remembered = localStorage.getItem(SAFETY_KEY) === '1';
    } catch (error) {
      remembered = false;
    }

    if (remembered) {
      action();
      return;
    }

    safetyPendingAction = action;
    openSafetyModal();
  }

  /** 绑定安全提示弹窗：取消 / 确认（可记住） */
  function bindSafetyModal() {
    const modal = $('#training-safety-modal');
    if (!modal) return;

    modal.addEventListener('click', function (event) {
      if (event.target.closest('[data-close-safety]')) {
        safetyPendingAction = null;
        closeSafetyModal();
        return;
      }

      if (!event.target.closest('#safety-confirm')) return;

      const rememberInput = $('#safety-remember');
      if (rememberInput && rememberInput.checked) {
        try {
          localStorage.setItem(SAFETY_KEY, '1');
        } catch (error) {
          /* 忽略存储失败，本次仍继续 */
        }
      }

      closeSafetyModal();

      const action = safetyPendingAction;
      safetyPendingAction = null;
      if (typeof action === 'function') action();
    });

    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && modal.classList.contains('is-open')) {
        safetyPendingAction = null;
        closeSafetyModal();
      }
    });
  }

  /* ============================ 打卡复盘 ============================ */

  function bindRange(inputSelector, outputSelector, suffix) {
    const input = $(inputSelector);
    const output = $(outputSelector);
    if (!input || !output) return;
    const sync = function () {
      output.textContent = input.value + (suffix || '');
    };
    input.addEventListener('input', sync);
    sync();
  }

  /* ============================ 打卡复盘 ============================ */

  /** 解析 YYYY-MM-DD 为本地日期对象 */
  function parseLocalDate(dateText) {
    const match = String(dateText || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /** 日期 → 周几文案 */
  function weekdayLabel(dateText) {
    const date = parseLocalDate(dateText);
    if (!date) return '';
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  }

  /** 同步 range 的数值显示（弹层回填时使用） */
  function syncRangeOutput(inputSelector, outputSelector, suffix) {
    const input = $(inputSelector);
    const output = $(outputSelector);
    if (input && output) output.textContent = input.value + (suffix || '');
  }

  /** 切换训练感受选中态 */
  function selectFeeling(feeling) {
    $$('#feeling-chips .chip').forEach(function (chip) {
      chip.classList.toggle(
        'is-active',
        chip.getAttribute('data-feeling') === feeling
      );
    });
  }

  /** 打开今日打卡弹层，并回填当天已有记录 */
  function openCheckinModal() {
    const modal = $('#checkin-modal');
    if (!modal) return;

    const todayRecord = state.checkins.find(function (item) {
      return item.date === todayStr();
    });

    const completionInput = $('#completion-rate');
    const rpeInput = $('#rpe');
    const sleepInput = $('#sleep-hours');
    const weightInput = $('#body-weight');
    const noteInput = $('#checkin-note');

    const completionRate = todayRecord ? Number(todayRecord.completionRate) : NaN;
    if (completionInput) {
      completionInput.value = Number.isFinite(completionRate)
        ? String(Math.round(completionRate * 100))
        : '100';
    }
    if (rpeInput) rpeInput.value = todayRecord && todayRecord.rpe ? String(todayRecord.rpe) : '6';
    if (sleepInput) {
      sleepInput.value = todayRecord && todayRecord.sleepHours
        ? String(todayRecord.sleepHours)
        : '7.5';
    }
    if (weightInput) {
      weightInput.value = todayRecord && todayRecord.bodyWeight
        ? String(todayRecord.bodyWeight)
        : '';
    }
    if (noteInput) noteInput.value = todayRecord && todayRecord.note ? todayRecord.note : '';

    syncRangeOutput('#completion-rate', '#completion-output', '%');
    syncRangeOutput('#rpe', '#rpe-output', '');

    selectFeeling(todayRecord && todayRecord.feeling ? todayRecord.feeling : 'ok');

    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }

  /** 关闭弹层并恢复页面滚动 */
  function closeCheckinModal() {
    const modal = $('#checkin-modal');
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }

  function bindReviewPage() {
    const openButton = $('#open-checkin');
    if (openButton) openButton.addEventListener('click', openCheckinModal);

    // 遮罩与关闭按钮共用 data-close-checkin
    $$('[data-close-checkin]').forEach(function (element) {
      element.addEventListener('click', closeCheckinModal);
    });

    const form = $('#checkin-form');
    if (form) form.addEventListener('submit', handleCheckin);

    bindRange('#completion-rate', '#completion-output', '%');
    bindRange('#rpe', '#rpe-output', '');

    // 训练感受三选一：轻松 / 合适 / 太累
    $$('#feeling-chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        selectFeeling(chip.getAttribute('data-feeling'));
      });
    });

    // ESC 关闭弹层
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeCheckinModal();
    });
  }

  function selectedFeeling() {
    const active = $('#feeling-chips .chip.is-active');
    return active ? active.getAttribute('data-feeling') : 'ok';
  }

  /**
   * 调用复盘 Agent 的 generateReview(checkins, plan)。
   * 没有打卡记录时返回 null，页面展示空状态。
   */
  function buildReviewReport() {
    if (!state.checkins.length) return null;

    const plan = state.coaching ? state.coaching.trainingPlan : null;

    if (typeof App.generateReview === 'function') {
      return App.generateReview(state.checkins, plan, {
        sessions: state.trainingSessions,
        correctionStats: state.correctionStats,
        totalCheckins: state.totalCheckins
      });
    }

    return state.lastReview || null;
  }

  /** 更新今日打卡入口的文案与状态 */
  function renderCheckinEntry() {
    const button = $('#open-checkin');
    const status = $('#checkin-status');
    const todayRecord = state.checkins.find(function (item) {
      return item.date === todayStr();
    });

    if (button) button.textContent = todayRecord ? '更新今日打卡' : '记录今日打卡';
    if (!status) return;

    if (!todayRecord) {
      status.textContent = '还没有记录，花 10 秒记下今天的训练感受。';
      return;
    }

    const labels = { easy: '轻松', ok: '合适', tired: '太累' };
    status.textContent =
      '今天已打卡：' + (labels[todayRecord.feeling] || '合适') +
      ' · 完成 ' + Math.round((Number(todayRecord.completionRate) || 0) * 100) + '%';
  }

  /**
   * 今日闭环横幅：完成今日打卡后在复盘页顶部显示。
   * 状态由已保存的打卡记录推导，刷新后仍然有效。
   */
  function renderReviewComplete() {
    const el = $('#review-complete');
    if (!el) return;

    const today = todayStr();
    const checked = (state.checkins || []).some(function (item) {
      return item.date === today;
    });

    el.hidden = !checked;
    el.textContent = checked ? '今日闭环完成 🎉' : '';
  }

  /**
   * 未生成训练计划时，在打卡复盘页显示与训练页一致的空状态引导。
   * 生成计划后自动隐藏，不干扰正常内容。
   */
  function renderPlanGuides() {
    const reviewGuide = $('#review-guide');
    if (!reviewGuide) return;

    const hasPlan = Boolean(state.coaching && state.coaching.trainingPlan);
    if (hasPlan) {
      reviewGuide.hidden = true;
      reviewGuide.innerHTML = '';
      return;
    }

    reviewGuide.hidden = false;
    reviewGuide.innerHTML =
      '<div class="card empty-guide">' +
        '<p class="empty-guide-title">请先在首页生成训练计划 📝</p>' +
        '<p class="muted">生成计划后，这里会显示今日打卡、复盘报告与饮食目标对照。</p>' +
        '<button type="button" class="btn-secondary" data-go-home>去首页生成</button>' +
      '</div>';
  }

  /** 渲染打卡历史列表（按日期倒序） */
  function renderCheckinHistory() {
    const root = $('#checkin-history');
    const countEl = $('#checkin-count');
    if (countEl) countEl.textContent = state.checkins.length + ' 条';
    if (!root) return;

    if (!state.checkins.length) {
      root.innerHTML =
        '<p class="muted">还没有打卡记录，点击上方按钮完成第一次打卡。</p>';
      return;
    }

    const feelingMeta = {
      easy: { label: '轻松', cls: 'badge--up' },
      ok: { label: '合适', cls: 'badge--ok' },
      tired: { label: '太累', cls: 'badge--tired' }
    };

    const sorted = state.checkins.slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });

    root.innerHTML = '<ul class="checkin-list">' + sorted.map(function (item) {
      const meta = feelingMeta[item.feeling] || feelingMeta.ok;
      const dateText = String(item.date || '');
      const details = [];

      if (Number.isFinite(Number(item.completionRate))) {
        details.push('完成 ' + Math.round(Number(item.completionRate) * 100) + '%');
      }
      if (item.rpe) details.push('RPE ' + item.rpe);
      if (item.sleepHours) details.push('睡眠 ' + item.sleepHours + ' h');

      return (
        '<li class="checkin-item">' +
          '<div class="checkin-date">' +
            '<b>' + esc(dateText.slice(5) || '--') + '</b>' +
            '<span>' + esc(weekdayLabel(dateText)) + '</span>' +
          '</div>' +
          '<div class="checkin-main">' +
            '<span class="badge ' + meta.cls + '">' + meta.label + '</span>' +
            '<span class="checkin-meta">' + esc(details.join(' · ') || '已打卡') + '</span>' +
            (item.note ? '<p class="checkin-note">' + esc(item.note) + '</p>' : '') +
          '</div>' +
          (item.bodyWeight
            ? '<span class="checkin-weight">' + esc(item.bodyWeight) + ' kg</span>'
            : '') +
        '</li>'
      );
    }).join('') + '</ul>';
  }

  /**
   * 写入一条打卡记录，并刷新复盘报告与日历。
   * 手动打卡和训练流程完成都复用这里。
   */
  function saveCheckinRecord(checkin) {
    // 同一天重复打卡覆盖旧记录，最多保留最近 60 天
    const existed = state.checkins.some(function (item) {
      return item.date === checkin.date;
    });

    state.checkins = state.checkins.filter(function (item) {
      return item.date !== checkin.date;
    });
    state.checkins.push(checkin);

    // 只有首次打卡才累加，用于里程碑成就
    if (!existed) state.totalCheckins = (state.totalCheckins || 0) + 1;
    state.checkins.sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date));
    });
    state.checkins = state.checkins.slice(-60);

    // 调用复盘 Agent
    state.lastReview = buildReviewReport();

    // 同步旧版复盘历史，便于日历兼容旧数据
    if (state.lastReview) {
      state.reviewHistory = state.reviewHistory.filter(function (item) {
        return item.date !== checkin.date;
      });
      state.reviewHistory.push({
        date: checkin.date,
        score: state.lastReview.score,
        intensity: state.lastReview.nextDay.intensity,
        advice: state.lastReview.advice
      });
      state.reviewHistory.sort(function (a, b) {
        return b.date.localeCompare(a.date);
      });
      state.reviewHistory = state.reviewHistory.slice(0, 60);
    }

    persistState();
    renderCheckinEntry();
    renderCheckinHistory();
    // 打卡感受变化后，首页的伙伴状态与气泡需要同步刷新
    renderHomeState();
    renderReviewComplete();
    renderReviewReport(state.lastReview);
    renderCalendar();
  }


  /**
   * 手动打卡：读取表单后写入本地存储。
   */
  function handleCheckin(event) {
    event.preventDefault();

    const completionRate = Number($('#completion-rate').value) / 100;
    const bodyWeight = toPositiveNumber($('#body-weight').value);
    const checkin = {
      date: todayStr(),
      completed: completionRate >= 0.5,
      completionRate: completionRate,
      feeling: selectedFeeling(),
      rpe: Number($('#rpe').value),
      sleepHours: toPositiveNumber($('#sleep-hours').value),
      bodyWeight: bodyWeight,
      note: $('#checkin-note').value.trim()
    };

    // 每日体重同步回档案：BMI 与每日饮食目标随之重算
    if (bodyWeight && bodyWeight >= 30 && bodyWeight <= 200 &&
      Number(state.profile && state.profile.weight) !== bodyWeight) {
      updateProfileField('weight', bodyWeight, { silent: true });
    }

    // 体重下降判断：对比今天之前最近一条记录（保存前取，避免与今天比较）
    const previousWeights = (state.checkins || []).filter(function (item) {
      return item.date !== todayStr() && Number(item.bodyWeight);
    });
    const lastWeight = previousWeights.length
      ? Number(previousWeights[previousWeights.length - 1].bodyWeight)
      : null;

    saveCheckinRecord(checkin);
    closeCheckinModal();

    celebrateConfetti();
    if (bodyWeight && lastWeight && bodyWeight < lastWeight) {
      showToast('体重下降啦，继续保持 ✨');
    } else {
      showToast('今日打卡已保存');
    }
  }

  /* ============================ 饮食食物打卡 ============================ */

  /** 手动输入食物名称时，由 App.findFoodByName 做模糊匹配 */

  /** 今日饮食目标热量：按训练日 / 休息日取 */
  function resolveDietTargetCalories() {
    const nutritionPlan = state.coaching ? state.coaching.nutritionPlan : null;
    if (!nutritionPlan) return null;

    const plan = state.coaching.trainingPlan;
    const todayIndex = (new Date().getDay() + 6) % 7;
    const todayPlan = plan ? plan.weeklyPlan[todayIndex] : null;
    const isTraining = Boolean(todayPlan && !todayPlan.isRest);

    if (isTraining && nutritionPlan.trainingDay) {
      return nutritionPlan.trainingDay.calories;
    }
    if (!isTraining && nutritionPlan.restDay) {
      return nutritionPlan.restDay.calories;
    }
    return nutritionPlan.targetCalories || null;
  }

  /**
   * 今日营养目标：热量按训练日 / 休息日取，三大营养素取营养方案。
   * 训练日碳水额外加 carbsExtraGrams（与 DietAgent 的热量分配规则一致）。
   */
  function resolveDietTargets() {
    const nutritionPlan = state.coaching ? state.coaching.nutritionPlan : null;
    if (!nutritionPlan) return null;

    const macros = nutritionPlan.macros || {};
    const plan = state.coaching.trainingPlan;
    const todayIndex = (new Date().getDay() + 6) % 7;
    const todayPlan = plan ? plan.weeklyPlan[todayIndex] : null;
    const isTraining = Boolean(todayPlan && !todayPlan.isRest);

    const extraCarbs = isTraining && nutritionPlan.trainingDay
      ? Number(nutritionPlan.trainingDay.carbsExtraGrams) || 0
      : 0;

    return {
      calories: resolveDietTargetCalories() || 0,
      protein: Number(macros.protein) || 0,
      carbs: (Number(macros.carbs) || 0) + extraCarbs,
      fat: Number(macros.fat) || 0
    };
  }

  /** 从已保存的今日饮食记录恢复草稿 */
  function loadDietDraftFromState() {
    const saved = state.dietLogs[todayStr()];
    state.dietDraft = {
      items: saved && Array.isArray(saved.items) ? saved.items.slice() : [],
      photo: saved && saved.photo ? saved.photo : null,
      selectedFood: null,
      keyword: '',
      meal: guessMeal()
    };

    const noteInput = $('#diet-note');
    if (noteInput) noteInput.value = saved && saved.note ? saved.note : '';

    const searchInput = $('#food-search');
    if (searchInput) searchInput.value = '';

    renderFoodSearch();
    renderFoodPicked();
    renderDietReport();
    renderDietReportHistory();
    renderDietRecommend();
  }

  /**
   * 渲染今日目标对照：热量与三大营养素的进度条、剩余额度与达标提醒。
   */
  function renderDietIntakeStatus(totals) {
    const root = $('#diet-intake-status');
    if (!root) return;

    const targets = resolveDietTargets();
    if (!targets) {
      root.innerHTML =
        '<p class="intake-tip">还没有营养方案，先在首页生成方案即可对照每日目标。</p>';
      return;
    }

    const metrics = typeof App.evaluateIntake === 'function'
      ? App.evaluateIntake(totals, targets)
      : null;

    if (!metrics) {
      root.innerHTML = '';
      return;
    }

    const rows = [metrics.calories, metrics.protein, metrics.carbs, metrics.fat]
      .map(function (item) {
        const width = Math.max(0, Math.min(100, item.percent));
        const cls = item.over ? 'is-over' : item.percent >= 90 ? 'is-near' : '';
        const diff = Math.round((item.eaten - item.target) * 10) / 10;
        const remainText = item.over ? '超出 ' + Math.abs(diff) : '还剩 ' + item.remaining;

        return (
          '<div class="intake-row">' +
            '<span>' + nutrientEmoji(item.key) + ' ' + esc(item.label) + '</span>' +
            '<span class="intake-bar ' + cls + '"><i style="width:' + width + '%"></i></span>' +
            '<span class="intake-value">' + esc(item.eaten) + '/' + esc(item.target) + ' ' +
              esc(item.unit) + ' · ' + esc(remainText) + '</span>' +
          '</div>'
        );
      }).join('');

    const alerts = metrics.alerts.length
      ? '<div class="intake-alerts">' + metrics.alerts.map(function (item) {
          return '<p class="intake-alert ' +
            (item.level === 'over' ? 'is-over' : '') + '">' + esc(item.text) + '</p>';
        }).join('') + '</div>'
      : '';

    root.innerHTML = rows + alerts;
  }

  /**
   * 计算草稿热量，并保留 calcFoodItems 不返回的餐次字段。
   * calcFoodItems 只输出营养字段，这里按输入顺序把 meal 回填回去，
   * 否则所有食物都会被归到默认的「午餐」，早餐 / 晚餐分区永远是空的。
   */
  function calcDraftResult() {
    if (typeof App.calcFoodItems !== 'function') {
      return {
        items: [],
        totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        percent: { protein: 0, carbs: 0, fat: 0 }
      };
    }

    const source = state.dietDraft.items || [];
    const result = App.calcFoodItems(source);

    result.items.forEach(function (item, index) {
      const origin = source[index];
      item.meal = (origin && origin.meal) || 'lunch';
    });

    return result;
  }

  /** 食物分类 emoji：紧凑条目标左边的图标 */
  const FOOD_EMOJI = {
    主食: '🍚',
    肉蛋: '🥩',
    水产: '🐟',
    蔬菜: '🥬',
    水果: '🍎',
    常见菜品: '🍲',
    饮品: '🥛',
    坚果油脂: '🥜',
    豆制品: '🫘'
  };

  function foodEmoji(category) {
    return FOOD_EMOJI[category] || '🍽️';
  }

  /** 渲染食物草稿（按餐次分区）、热量与营养占比、目标对照、照片预览 */
  function renderDietDraft() {
    const root = $('#diet-draft');
    if (!root) return;

    const result = calcDraftResult();

    const totals = result.totals;
    const percent = result.percent;

    /* 按餐次分组：每餐展示小计与食物列表 */
    const groups = MEALS.map(function (meal) {
      const entries = result.items.map(function (item, index) {
        return { item: item, index: index };
      }).filter(function (entry) {
        return (entry.item.meal || 'lunch') === meal.key;
      });

      const mealCalories = entries.reduce(function (sum, entry) {
        return sum + (Number(entry.item.calories) || 0);
      }, 0);

      const listHtml = entries.length
        ? '<ul class="food-list">' + entries.map(function (entry) {
            const item = entry.item;
            const index = entry.index;

            return (
              '<li class="food-item food-item--compact">' +
                '<span class="food-emoji" aria-hidden="true">' +
                  foodEmoji(item.category) + '</span>' +
                '<span class="food-name" title="' + esc(item.name) + ' · 蛋白 ' +
                  esc(item.protein) + 'g · 碳水 ' + esc(item.carbs) + 'g · 脂肪 ' +
                  esc(item.fat) + 'g">' + esc(item.name) + '</span>' +
                '<input class="food-grams-edit" type="text" inputmode="decimal" ' +
                  'value="' + esc(item.grams) + '" data-grams-index="' + index + '" ' +
                  'aria-label="' + esc(item.name) + ' 分量（克）">' +
                '<span class="food-unit">g</span>' +
                '<span class="food-kcal">' + esc(item.calories) + ' kcal</span>' +
                '<button type="button" class="food-remove" data-remove-food="' + index +
                  '" aria-label="删除 ' + esc(item.name) + '">×</button>' +
              '</li>'
            );
          }).join('') + '</ul>'
        : '<p class="muted meal-empty">还没有记录</p>';

      return (
        '<section class="meal-group">' +
          '<div class="meal-title">' +
            '<span>' + meal.emoji + ' ' + meal.label + '</span>' +
            '<em>' + Math.round(mealCalories) + ' kcal</em>' +
          '</div>' +
          listHtml +
        '</section>'
      );
    }).join('');

    const photoHtml = state.dietDraft.photo
      ? '<div class="photo-preview">' +
          '<img src="' + esc(state.dietDraft.photo) + '" alt="饮食记录配图">' +
          '<button type="button" class="photo-remove" data-remove-photo>移除照片</button>' +
        '</div>'
      : '';

    root.innerHTML =
      personaHtml('diet', 'intro') +
      groups +
      '<div class="diet-total">' +
        '<div class="kcal"><b>' + esc(totals.calories) + '</b>' +
          '<span>kcal / 今日已记录</span></div>' +
      '</div>' +
      '<div class="macro-row">' +
        '<div class="macro"><span>🥩 蛋白质</span><b>' + esc(totals.protein) + ' g</b></div>' +
        '<div class="macro"><span>🍚 碳水</span><b>' + esc(totals.carbs) + ' g</b></div>' +
        '<div class="macro"><span>🥑 脂肪</span><b>' + esc(totals.fat) + ' g</b></div>' +
      '</div>' +
      '<p class="hint">供能占比：蛋白 ' + esc(percent.protein) + '% · 碳水 ' +
        esc(percent.carbs) + '% · 脂肪 ' + esc(percent.fat) + '%</p>' +
      photoHtml +
      personaHtml('diet', 'outro');

    renderMealTabs();
    renderWaterCard();
    renderDietRecommend();
    renderDietIntakeStatus(totals);
  }

  /** 餐次切换 chips */
  function renderMealTabs() {
    const root = $('#diet-meal-tabs');
    if (!root) return;

    const current = state.dietDraft.meal || 'lunch';

    root.innerHTML = MEALS.map(function (meal) {
      return '<button type="button" class="meal-tab' +
        (meal.key === current ? ' is-active' : '') + '" data-diet-meal="' + meal.key + '">' +
        meal.emoji + ' ' + meal.label + '</button>';
    }).join('');
  }

  /** 喝水记录卡：点一次水杯 +250ml */
  function renderWaterCard() {
    const root = $('#diet-water');
    if (!root) return;

    const today = todayStr();
    const water = Number(state.waterLogs[today]) || 0;
    const percent = Math.min(100, Math.round((water / WATER_TARGET) * 100));

    root.innerHTML =
      '<div class="water-card">' +
        '<div class="water-head">' +
          '<b>💧 喝水记录</b>' +
          '<span data-count-to="' + water + '" data-count-suffix=" / ' + WATER_TARGET +
            ' ml">' + water + ' / ' + WATER_TARGET + ' ml</span>' +
        '</div>' +
        '<div class="water-bar"><i style="width:' + percent + '%"></i></div>' +
        '<button type="button" class="btn-secondary water-btn" data-drink-water>' +
          '🥤 喝一杯（+250 ml）</button>' +
        '<p class="hint">' + (water >= WATER_TARGET
          ? '今天的水喝够啦，很棒 💧'
          : '还差 ' + (WATER_TARGET - water) + ' ml，随手补一杯吧 💧') + '</p>' +
      '</div>';

    animateCounters(root);
  }

  /** 记录喝水：写入当天并同步首页 */
  function drinkWater() {
    const today = todayStr();
    const current = Number(state.waterLogs[today]) || 0;
    state.waterLogs[today] = current + WATER_STEP;

    persistState();
    renderWaterCard();
    renderHomeState();

    const total = state.waterLogs[today];
    showToast(total >= WATER_TARGET ? '喝水达标啦 💧' : '已记录 ' + total + ' ml 💧');
  }

  /** 计算各餐次热量小计 */
  function buildMealCalories(items) {
    const result = {};
    MEALS.forEach(function (meal) {
      result[meal.key] = (items || []).reduce(function (sum, item) {
        return (item.meal || 'lunch') === meal.key
          ? sum + (Number(item.calories) || 0)
          : sum;
      }, 0);
    });
    return result;
  }

  /** 今日训练摘要：动作数 / 组数 / 次数，用于估算训练消耗 */
  function getTodayTrainingSummary() {
    const today = todayStr();
    const sessions = (state.trainingSessions || []).filter(function (session) {
      return session && session.date === today;
    });

    let sets = 0;
    let exercises = 0;
    let reps = 0;

    sessions.forEach(function (session) {
      (session.exercises || []).forEach(function (item) {
        if (!item || item.skipped) return;

        exercises += 1;
        const completed = Number(item.completedSets) || 0;
        sets += completed;
        reps += completed * (Number(item.targetReps) || 0);
      });
    });

    const checked = (state.checkins || []).some(function (item) {
      return item.date === today && item.completed;
    });

    return {
      trained: sessions.length > 0 || checked,
      sets: sets,
      exercises: exercises,
      reps: reps
    };
  }

  /**
   * 今日训练部位：从训练计划的 parts 推断营养策略分组。
   * 返回 legs / chest_back / shoulders_arms / core / rest。
   */
  function getTodayTrainingPart() {
    const plan = state.coaching ? state.coaching.trainingPlan : null;
    if (!plan || !Array.isArray(plan.weeklyPlan)) return 'rest';

    const dayIndex = (new Date().getDay() + 6) % 7;
    const day = plan.weeklyPlan[dayIndex];
    if (!day || day.isRest) return 'rest';

    const parts = Array.isArray(day.parts) ? day.parts : [];

    if (parts.indexOf('legs') >= 0) return 'legs';
    if (parts.indexOf('chest') >= 0 || parts.indexOf('back') >= 0) return 'chest_back';
    if (parts.indexOf('shoulders') >= 0 || parts.indexOf('arms') >= 0 ||
        parts.indexOf('biceps') >= 0 || parts.indexOf('triceps') >= 0) {
      return 'shoulders_arms';
    }
    if (parts.indexOf('core') >= 0 || parts.indexOf('cardio') >= 0) return 'core';

    return 'rest';
  }

  /** 最近一次推荐结果：供「一键加入」使用 */
  let lastRecommendation = null;

  /** 推荐签名：同一天、同样的训练量与目标下复用同一批食谱，避免频繁换菜 */
  let recommendSignature = '';

  /** 渲染今日推荐食谱（饮食页最顶部） */
  function renderDietRecommend() {
    const root = $('#diet-recommend');
    if (!root) return;

    if (typeof App.buildPartMealPlan !== 'function') {
      root.innerHTML = '';
      return;
    }

    const targets = resolveDietTargets();
    if (!targets) {
      root.innerHTML =
        '<div class="card recommend-card">' +
          '<p class="hint">生成营养方案后，这里会按今天的训练部位推荐三餐 🍽️</p>' +
        '</div>';
      return;
    }

    const part = getTodayTrainingPart();
    const summary = getTodayTrainingSummary();
    const signature = [
      todayStr(),
      part,
      summary.trained ? 1 : 0,
      summary.sets,
      summary.exercises,
      targets.calories
    ].join('|');

    // 部位 / 训练量 / 日期变化时才重新生成，普通重绘保持同一份三餐
    if (!lastRecommendation || recommendSignature !== signature) {
      lastRecommendation = App.buildPartMealPlan(targets, {
        part: part,
        trained: summary.trained,
        sets: summary.sets,
        exercises: summary.exercises
      });
      recommendSignature = signature;
    }

    renderRecommendHtml(lastRecommendation);
  }

  /** 渲染推荐卡 HTML：类型标签 + 推荐语 + 食物与营养 */
  function renderRecommendHtml(recommend) {
    const root = $('#diet-recommend');
    if (!root || !recommend) return;

    const burnText = recommend.burn > 0
      ? '基础目标 ' + recommend.baseCalories + ' kcal + 训练消耗约 ' + recommend.burn +
        ' kcal → 今日调整后 ' + recommend.adjustedCalories + ' kcal'
      : '基础目标 ' + recommend.baseCalories + ' kcal（休息日不额外增加）';

    const mealsHtml = recommend.meals.map(function (meal) {
      const itemsHtml = meal.items.map(function (item) {
        const food = (App.foodLibrary || []).find(function (entry) {
          return entry.id === item.foodId;
        });

        return '<span class="recommend-item">' + foodEmoji(food ? food.category : '') +
          ' ' + esc(item.name) + ' ' + esc(item.grams) + 'g</span>';
      }).join('');

      return (
        '<div class="recommend-meal">' +
          '<div class="recommend-meal-head">' +
            '<span class="recommend-tag">' + esc(meal.emoji || '🍽️') + ' ' +
              esc(meal.label || '推荐') + '</span>' +
            '<em>' + esc(meal.totals.calories) + ' kcal</em>' +
          '</div>' +
          '<b class="recommend-name">' + esc(meal.name) + '</b>' +
          (meal.say ? '<p class="recommend-say">' + esc(meal.say) + '</p>' : '') +
          '<div class="recommend-items">' + itemsHtml + '</div>' +
          '<p class="recommend-macros">蛋白 ' + esc(meal.totals.protein) + 'g · 碳水 ' +
            esc(meal.totals.carbs) + 'g · 脂肪 ' + esc(meal.totals.fat) + 'g</p>' +
        '</div>'
      );
    }).join('');

    root.innerHTML =
      '<div class="card recommend-card">' +
        '<div class="card-head">' +
          '<h2>🍽️ 今日推荐食谱</h2>' +
          '<span class="tag">' + esc(recommend.title) + '</span>' +
        '</div>' +
        '<p class="recommend-line">' + esc(burnText) + '</p>' +
        '<p class="recommend-text">' + esc(recommend.text) + '</p>' +
        mealsHtml +
        '<button type="button" class="btn-primary recommend-apply" data-apply-recommend>' +
          '＋ 一键加入今日饮食</button>' +
        '<p class="hint">三餐会分别加入早 / 午 / 晚餐，加入后可再手动调整克数</p>' +
      '</div>';
  }

  /** 一键把推荐食谱加入当前餐次 */
  function applyRecommendedMeals() {
    if (!lastRecommendation) renderDietRecommend();
    if (!lastRecommendation || !lastRecommendation.meals.length) {
      showToast('还没有可加入的推荐 🍽️');
      return;
    }

    let added = 0;

    lastRecommendation.meals.forEach(function (meal) {
      // 三餐分别写入对应餐次：早餐→早餐、午餐→午餐、晚餐→晚餐
      const mealKey = meal.key || state.dietDraft.meal;

      meal.items.forEach(function (item) {
        const food = (App.foodLibrary || []).find(function (entry) {
          return entry.id === item.foodId;
        });
        if (!food) return;

        const result = appendFoodItem(food, item.grams, mealKey);
        if (result) added += 1;
      });
    });

    if (!added) {
      showToast('推荐食谱未能加入，请手动选择食物');
      return;
    }

    renderDietDraft();
    showToast('已加入 ' + added + ' 种食物到当前餐次 🎉');
  }

  /** 下一餐建议：记录完一餐后自动刷新 */
  function renderMealSuggestion(mealKey) {
    const root = $('#diet-suggestion');
    if (!root) return;

    if (typeof App.suggestNextMeal !== 'function' ||
        typeof App.calcFoodItems !== 'function') {
      root.innerHTML = '';
      return;
    }

    const totals = App.calcFoodItems(state.dietDraft.items).totals;
    const targets = resolveDietTargets();
    if (!targets) {
      root.innerHTML = '';
      return;
    }

    const suggestion = App.suggestNextMeal(totals, targets, { mealType: mealKey });
    if (!suggestion || !suggestion.text) {
      root.innerHTML = '';
      return;
    }

    root.innerHTML =
      '<div class="card meal-suggestion-card">' +
        '<div class="card-head">' +
          '<h2>🍽️ 下一餐建议</h2>' +
          '<span class="tag">营养饮食 Agent</span>' +
        '</div>' +
        '<p class="suggestion-text">' + esc(suggestion.text) + '</p>' +
      '</div>';
  }

  /** 报告内容渲染（支持指定日期回看） */
  function renderDietReportContent(root, report) {
    if (!root || !report) return;

    function row(label, emoji, percent, value, target, unit) {
      const width = Math.max(0, Math.min(100, Number(percent) || 0));
      return (
        '<div class="report-row">' +
          '<span>' + emoji + ' ' + label + '</span>' +
          '<span class="report-bar"><i style="width:' + width + '%"></i></span>' +
          '<em>' + value + ' / ' + target + ' ' + unit + '</em>' +
        '</div>'
      );
    }

    root.innerHTML =
      '<div class="report-card">' +
        row('热量', '🔥', report.caloriePercent,
          report.calories, report.caloriesTarget, 'kcal') +
        row('蛋白质', '🥩', report.proteinPercent,
          Math.round((Number(report.totals.protein) || 0) * 10) / 10,
          report.targets.protein || 0, 'g') +
        row('喝水', '💧', report.waterPercent, report.water, report.waterTarget, 'ml') +
        '<p class="report-line">🥗 ' + esc(report.advice) + '</p>' +
        '<p class="report-comment">' + esc(report.comment) + '</p>' +
        '<p class="disclaimer-note">饮食建议仅供参考，特殊疾病人群请咨询医生或营养师</p>' +
      '</div>';
  }

  /** 渲染今日报告 */
  function renderDietReport() {
    const root = $('#diet-report');
    if (!root) return;

    const report = state.dietReports[todayStr()];
    if (!report) {
      root.innerHTML = '<p class="hint">记录完今天的饮食后，点上方按钮生成营养师点评 📋</p>';
      return;
    }

    renderDietReportContent(root, report);
  }

  /** 报告历史：最近 7 天，点击回看 */
  function renderDietReportHistory() {
    const root = $('#diet-report-history');
    if (!root) return;

    const dates = Object.keys(state.dietReports).sort().reverse();
    if (!dates.length) {
      root.innerHTML = '';
      return;
    }

    root.innerHTML = '<div class="report-history">' + dates.slice(0, 7).map(function (date) {
      const report = state.dietReports[date] || {};
      return (
        '<button type="button" class="report-history-item" data-report-date="' + esc(date) + '">' +
          '<b>' + esc(date) + '</b>' +
          '<em>' + esc(report.caloriePercent || 0) + '% 热量</em>' +
        '</button>'
      );
    }).join('') + '</div>';
  }

  /** 回看指定日期的报告 */
  function showDietReport(dateKey) {
    const root = $('#diet-report');
    const report = state.dietReports[dateKey];
    if (!root || !report) return;

    renderDietReportContent(root, report);
    showToast('正在查看 ' + dateKey + ' 的报告 📋');
  }

  /** 生成今日饮食报告 */
  function generateDietReport() {
    const today = todayStr();

    if (!state.dietDraft.items.length) {
      showToast('先记录今天的饮食，再生成报告哦 📝');
      return;
    }
    if (typeof App.buildDailyDietReport !== 'function' ||
        typeof App.calcFoodItems !== 'function') {
      showToast('营养模块未加载');
      return;
    }

    const result = App.calcFoodItems(state.dietDraft.items);
    const targets = resolveDietTargets() || { calories: 0, protein: 0, carbs: 0, fat: 0 };

    const report = App.buildDailyDietReport({
      totals: result.totals,
      targets: targets,
      water: Number(state.waterLogs[today]) || 0,
      waterTarget: WATER_TARGET,
      mealCalories: buildMealCalories(state.dietDraft.items),
      date: today
    });

    state.dietReports[today] = report;
    persistState();
    renderDietReport();
    renderDietReportHistory();
    showToast('今日饮食报告已生成 📋');
  }

  /** 渲染搜索结果列表（空关键字时展示常见食物推荐） */
  function renderFoodSearch() {
    const root = $('#food-search-results');
    const hint = $('#food-search-hint');
    if (!root) return;

    if (typeof App.searchFoods !== 'function') {
      root.innerHTML = '';
      return;
    }

    const keyword = state.dietDraft.keyword || '';
    const foods = App.searchFoods(keyword, keyword ? 20 : 6);

    if (!foods.length) {
      root.innerHTML = '<p class="food-search-empty">没有找到「' + esc(keyword) +
        '」，试试 鸡胸肉 / 米饭 / 西红柿</p>';
      return;
    }

    root.innerHTML = foods.map(function (food) {
      const active = state.dietDraft.selectedFood &&
        state.dietDraft.selectedFood.id === food.id;

      return (
        '<button type="button" class="food-search-item' + (active ? ' is-active' : '') +
          '" data-food-id="' + esc(food.id) + '" role="option">' +
          '<span>' + esc(food.name) + '</span>' +
          '<em>' + esc(food.per100g.calories) + ' kcal / 100g</em>' +
        '</button>'
      );
    }).join('');

    if (hint) {
      hint.textContent = keyword
        ? '找到 ' + foods.length + ' 种食物，点选后填写分量'
        : '常见食物推荐，输入关键字可继续筛选';
    }
  }

  /** 展示当前选中的食物 */
  function renderFoodPicked() {
    const el = $('#food-picked');
    if (!el) return;

    const food = state.dietDraft.selectedFood;
    if (food) {
      el.textContent = '已选：' + food.name + '（' + food.per100g.calories + ' kcal / 100g）';
      el.classList.add('is-active');
    } else {
      el.textContent = '未选择食物';
      el.classList.remove('is-active');
    }
  }

  /** 点选搜索结果中的食物：高亮并聚焦分量输入 */
  function selectFood(foodId) {
    const library = App.foodLibrary || [];
    const food = library.find(function (item) {
      return item.id === foodId;
    });
    if (!food) return;

    state.dietDraft.selectedFood = food;
    renderFoodSearch();
    renderFoodPicked();

    const gramsInput = $('#food-grams');
    if (gramsInput) {
      if (!gramsInput.value) gramsInput.value = '100';
      gramsInput.focus();
    }
  }

  /**
   * 把食物按克数加入草稿；同名食物合并克数，避免列表出现重复条目。
   *
   * @param {Object} food 食物库条目
   * @param {number} grams 克数
   * @returns {{item:Object, merged:boolean}|null}
   */
  function appendFoodItem(food, grams, mealKey) {
    if (!food) return null;
    if (typeof App.calcFoodItems !== 'function') return null;

    const weight = Number(grams);
    if (!Number.isFinite(weight) || weight <= 0) return null;
    const safeGrams = Math.round(Math.min(weight, 5000));
    const meal = mealKey || state.dietDraft.meal || 'lunch';

    // 同名食物且同一餐次才合并，不同餐次分开记录
    const existingIndex = state.dietDraft.items.findIndex(function (entry) {
      return entry.id === food.id && (entry.meal || 'lunch') === meal;
    });

    if (existingIndex >= 0) {
      const mergedGrams = Math.round(
        (Number(state.dietDraft.items[existingIndex].grams) || 0) + safeGrams
      );
      const merged = App.calcFoodItems([{ foodId: food.id, grams: mergedGrams }]).items[0];
      if (!merged) return null;

      merged.meal = meal;
      state.dietDraft.items[existingIndex] = merged;
      return { item: merged, merged: true };
    }

    const item = App.calcFoodItems([{ foodId: food.id, grams: safeGrams }]).items[0];
    if (!item) return null;

    item.meal = meal;
    state.dietDraft.items.push(item);
    return { item: item, merged: false };
  }

  /** 添加一条食物到草稿（选中的食物 + 分量，同名合并克数） */
  function addFoodToDraft() {
    const gramsInput = $('#food-grams');
    const food = state.dietDraft.selectedFood;

    if (!food) {
      showToast('请先在上方搜索并选择食物');
      return;
    }
    if (typeof App.calcFoodItems !== 'function') {
      showToast('热量计算未加载');
      return;
    }
    if (!gramsInput) return;

    const raw = gramsInput.value.trim();
    const grams = Number(raw);

    if (!raw || !Number.isFinite(grams) || grams <= 0) {
      showToast('请输入有效的分量（g）');
      return;
    }
    if (grams > 5000) {
      showToast('分量超过 5000 g，请检查克数');
      return;
    }

    const result = appendFoodItem(food, grams, state.dietDraft.meal);
    if (!result) {
      showToast('该食物未在食物库中');
      return;
    }

    gramsInput.value = '';
    renderDietDraft();
    showToast(result.merged
      ? '已合并：' + result.item.name + ' ' + result.item.grams + ' g'
      : '已添加 ' + result.item.name + ' ' + result.item.grams + ' g');
  }

  /** 保存今日饮食记录到 localStorage */
  function saveDietDraft() {
    if (!state.dietDraft.items.length) {
      showToast('请先添加至少一种食物');
      return;
    }
    if (typeof App.calcFoodItems !== 'function') {
      showToast('热量计算未加载');
      return;
    }

    const result = calcDraftResult();
    const today = todayStr();
    const noteInput = $('#diet-note');
    // 保存当时的目标快照，历史记录里可还原"当天还剩多少额度"
    const targets = resolveDietTargets();

    state.dietLogs[today] = {
      date: today,
      items: result.items,
      totals: result.totals,
      percent: result.percent,
      calories: result.totals.calories,
      protein: result.totals.protein,
      carbs: result.totals.carbs,
      fat: result.totals.fat,
      targets: targets,
      meals: buildMealCalories(state.dietDraft.items),
      water: Number(state.waterLogs[today]) || 0,
      note: noteInput ? noteInput.value.trim() : '',
      photo: state.dietDraft.photo || null,
      updatedAt: new Date().toISOString()
    };

    // 只保留最近 30 天，控制 localStorage 体积
    const dates = Object.keys(state.dietLogs).sort();
    dates.slice(0, Math.max(0, dates.length - 30)).forEach(function (date) {
      delete state.dietLogs[date];
    });

    persistState();
    renderDietDraft();
    renderDietHistory();
    renderCalendar();
    // 同步首页「今日饮食」卡片与闭环进度，避免保存后首页仍显示旧数据
    renderHomeState();
    // 记录完一餐后给下一餐建议，并刷新报告区
    renderMealSuggestion(state.dietDraft.meal);
    renderDietReport();
    renderDietReportHistory();

    showToast('饮食记录已保存');

    // 晚餐时段提醒生成当日报告
    if (new Date().getHours() >= 20 && !state.dietReports[today]) {
      setTimeout(function () {
        showToast('今天吃得差不多啦，可以生成饮食报告 📋');
      }, 1200);
    }
  }

  /**
   * 渲染饮食历史：热量、三大营养素、食物清单与配图一起展示。
   * 今天的记录在上方「饮食记录」实时展示，历史只列往期，避免重复。
   */
  function renderDietHistory() {
    const root = $('#diet-history');
    const countEl = $('#diet-history-count');
    if (!root) return;

    const today = todayStr();
    const dates = Object.keys(state.dietLogs).filter(function (date) {
      return date !== today;
    }).sort().reverse();

    if (countEl) countEl.textContent = dates.length + ' 条';

    if (!dates.length) {
      root.innerHTML = '<p class="muted">还没有往期记录；今天的数据保存后会进入历史。</p>';
      return;
    }

    root.innerHTML = '<ul class="diet-history-list">' + dates.slice(0, 30).map(function (date) {
      const log = state.dietLogs[date] || {};
      const totals = log.totals || { calories: 0, protein: 0, carbs: 0, fat: 0 };
      const items = Array.isArray(log.items) ? log.items : [];
      const foodText = items.map(function (item) {
        return item.name + ' ' + item.grams + 'g';
      }).join('、');

      return (
        '<li class="diet-history-item">' +
          '<div class="diet-history-head">' +
            '<b>' + esc(date) + '</b>' +
            '<span>' + esc(totals.calories) + ' kcal</span>' +
          '</div>' +
          '<p class="diet-history-macros">蛋白 ' + esc(totals.protein) + ' g · 碳水 ' +
            esc(totals.carbs) + ' g · 脂肪 ' + esc(totals.fat) + ' g' +
            (log.note ? ' · ' + esc(log.note) : '') + '</p>' +
          (foodText ? '<p class="diet-history-foods">' + esc(foodText) + '</p>' : '') +
          (log.photo
            ? '<img class="diet-history-photo" src="' + esc(log.photo) +
              '" alt="饮食记录配图" loading="lazy">'
            : '') +
        '</li>'
      );
    }).join('') + '</ul>';
  }

  /** 压缩图片，避免照片过大撑爆 localStorage */
  function compressImage(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type || '')) {
        resolve(null);
        return;
      }

      const reader = new FileReader();
      reader.onload = function () {
        const image = new Image();
        image.onload = function () {
          const maxSide = 720;
          const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));

          const context = canvas.getContext('2d');
          if (!context) {
            resolve(null);
            return;
          }

          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          try {
            resolve(canvas.toDataURL('image/jpeg', 0.68));
          } catch (error) {
            resolve(null);
          }
        };
        image.onerror = function () { resolve(null); };
        image.src = String(reader.result);
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  /** 拍照 / 选择照片：仅作为这条饮食记录的配图保存，不参与热量计算 */
  async function handleDietPhoto(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) return;

    const dataUrl = await compressImage(file);
    if (!dataUrl) {
      showToast('照片处理失败，请换一张试试');
      input.value = '';
      return;
    }

    state.dietDraft.photo = dataUrl;
    renderDietDraft();
    showToast('照片已添加为饮食记录配图');
    input.value = '';
  }

  /** 绑定饮食记录交互：搜索筛选、点选高亮、分量添加、克数编辑、删除与保存 */
  function bindDietPage() {
    const searchInput = $('#food-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        state.dietDraft.keyword = searchInput.value.trim();
        renderFoodSearch();
      });
    }

    const resultsRoot = $('#food-search-results');
    if (resultsRoot) {
      resultsRoot.addEventListener('click', function (event) {
        const button = event.target.closest('[data-food-id]');
        if (!button) return;
        selectFood(button.getAttribute('data-food-id'));
      });
    }

    const addButton = $('#add-food');
    if (addButton) addButton.addEventListener('click', addFoodToDraft);

    // 分量输入框按回车也能添加
    const gramsInput = $('#food-grams');
    if (gramsInput) {
      gramsInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          addFoodToDraft();
        }
      });
    }

    const draftRoot = $('#diet-draft');
    if (draftRoot) {
      draftRoot.addEventListener('click', function (event) {
        const removeFood = event.target.closest('[data-remove-food]');
        if (removeFood) {
          const index = Number(removeFood.getAttribute('data-remove-food'));
          if (Number.isInteger(index) && index >= 0) {
            state.dietDraft.items.splice(index, 1);
            renderDietDraft();
          }
          return;
        }

        if (event.target.closest('[data-remove-photo]')) {
          state.dietDraft.photo = null;
          renderDietDraft();
        }
      });

      // 修改已添加食物的克数：实时重算并刷新汇总
      draftRoot.addEventListener('change', function (event) {
        const input = event.target.closest('[data-grams-index]');
        if (!input) return;
        if (typeof App.calcFoodItems !== 'function') return;

        const index = Number(input.getAttribute('data-grams-index'));
        const item = state.dietDraft.items[index];
        if (!item) return;

        const grams = Number(input.value);
        if (!Number.isFinite(grams) || grams <= 0 || grams > 5000) {
          input.value = item.grams;
          showToast('分量需在 1~5000 g 之间');
          return;
        }

        const recomputed = App.calcFoodItems([{ foodId: item.id, grams: grams }]).items[0];
        if (!recomputed) return;

        state.dietDraft.items[index] = recomputed;
        renderDietDraft();
      });
    }

    // 餐次切换：先选餐次再添加食物
    const mealTabs = $('#diet-meal-tabs');
    if (mealTabs) {
      mealTabs.addEventListener('click', function (event) {
        const tab = event.target.closest('[data-diet-meal]');
        if (!tab) return;

        state.dietDraft.meal = tab.getAttribute('data-diet-meal');
        renderMealTabs();

        const target = MEALS.find(function (item) {
          return item.key === state.dietDraft.meal;
        });
        showToast('已切换到「' + (target ? target.label : '加餐') + '」');
      });
    }

    // 喝水记录
    const waterRoot = $('#diet-water');
    if (waterRoot) {
      waterRoot.addEventListener('click', function (event) {
        if (event.target.closest('[data-drink-water]')) drinkWater();
      });
    }

    // 今日推荐食谱：一键加入当前餐次
    const recommendRoot = $('#diet-recommend');
    if (recommendRoot) {
      recommendRoot.addEventListener('click', function (event) {
        if (event.target.closest('[data-apply-recommend]')) applyRecommendedMeals();
      });
    }

    // 饮食报告：生成与历史回看
    const reportCard = $('#diet-report-card');
    if (reportCard) {
      reportCard.addEventListener('click', function (event) {
        if (event.target.closest('#generate-diet-report')) {
          generateDietReport();
          return;
        }

        const item = event.target.closest('[data-report-date]');
        if (item) showDietReport(item.getAttribute('data-report-date'));
      });
    }

    const photoInput = $('#diet-photo');
    if (photoInput) photoInput.addEventListener('change', handleDietPhoto);

    const saveButton = $('#save-diet');
    if (saveButton) saveButton.addEventListener('click', saveDietDraft);
  }

  function renderReviewReport(report) {
    const root = $('#review-result');
    if (!root) return;

    const data = report || state.lastReview;
    if (!data) {
      root.innerHTML =
        '<div class="card empty">' +
          '<p class="empty-title">还没有复盘记录 📊</p>' +
          '<p class="muted">完成一次今日打卡后，复盘 Agent 会给出报告和明日强度建议。</p>' +
        '</div>';
      return;
    }

    const intensityMap = {
      increase: { label: '加量', cls: 'badge--up' },
      keep: { label: '维持', cls: 'badge--ok' },
      decrease: { label: '降量', cls: 'badge--down' }
    };
    const intensity = intensityMap[data.nextDay.intensity] || intensityMap.keep;
    const delta = data.nextDay.volumeDelta || 0;

    const completion = data.completion || null;
    const feelings = data.feelings || null;

    const completionHtml = completion
      ? '<div class="stats-grid">' +
          '<div class="stat-item"><span>本周出勤</span><b>' +
            esc(completion.completedDays) + ' 天</b></div>' +
          '<div class="stat-item"><span>计划训练</span><b>' +
            (completion.plannedDays > 0 ? esc(completion.plannedDays) + ' 天' : '--') + '</b></div>' +
          '<div class="stat-item"><span>完成度</span><b>' +
            (completion.rate === null ? '--' : Math.round(completion.rate * 100) + '%') + '</b></div>' +
        '</div>'
      : '';

    const feelingsHtml = feelings
      ? '<div class="stats-grid">' +
          '<div class="stat-item is-easy"><span>轻松</span><b>' + esc(feelings.easy) + ' 天</b></div>' +
          '<div class="stat-item"><span>合适</span><b>' + esc(feelings.ok) + ' 天</b></div>' +
          '<div class="stat-item is-tired"><span>太累</span><b>' + esc(feelings.tired) + ' 天</b></div>' +
        '</div>'
      : '';

    const adjustParts = [];
    if (data.nextDay.setsDelta) {
      adjustParts.push('组数 ' + (data.nextDay.setsDelta > 0 ? '+' : '') + data.nextDay.setsDelta);
    }
    if (data.nextDay.repsDelta) {
      adjustParts.push('次数 ' + (data.nextDay.repsDelta > 0 ? '+' : '') + data.nextDay.repsDelta);
    }
    const adjustText = adjustParts.length ? adjustParts.join(' / ') : '维持原计划';

    const rangeText = data.weekRange
      ? esc(data.weekRange.start) + ' ~ ' + esc(data.weekRange.end)
      : esc(data.date);

    /* 本周统计：训练天数 / 总组数 / 最常见动作 / 高频易错动作 */
    const stats = data.stats || null;
    const statsHtml = stats
      ? '<div class="stats-grid">' +
          '<div class="stat-item"><span>训练天数</span><b>' +
            esc(stats.trainedDays) + ' 天</b></div>' +
          '<div class="stat-item"><span>总组数</span><b>' +
            esc(stats.totalSets) + ' 组</b></div>' +
          '<div class="stat-item"><span>最常见动作</span><b>' +
            (stats.topExercise
              ? exerciseEmoji(stats.topExercise) + ' ' + esc(stats.topExercise)
              : '--') + '</b></div>' +
          '<div class="stat-item"><span>易错动作</span><b>' +
            (stats.topIssue ? '⚠️ ' + esc(stats.topIssue) : '暂无明显问题') + '</b></div>' +
        '</div>'
      : '';

    /* 简易柱状图：每天训练量 */
    const chartHtml = stats && stats.dailyVolume && stats.maxVolume > 0
      ? '<div class="week-chart" role="img" aria-label="本周每日训练量柱状图">' +
          stats.dailyVolume.map(function (item) {
            const height = Math.max(6, Math.round((item.value / stats.maxVolume) * 64));
            return (
              '<div class="chart-col">' +
                '<span class="chart-value">' + (item.value ? item.value : '') + '</span>' +
                '<i class="chart-bar" style="height:' + height + 'px"></i>' +
                '<span class="chart-label">' + esc(item.label) + '</span>' +
              '</div>'
            );
          }).join('') +
        '</div>'
      : '';

    /* 里程碑成就徽章 */
    const achievements = Array.isArray(data.achievements) ? data.achievements : [];
    const achievementHtml = achievements.length
      ? '<div class="achievements">' + achievements.map(function (item) {
          return (
            '<span class="achievement' + (item.earned ? ' is-earned' : '') + '" ' +
              'title="累计打卡 ' + item.count + ' 次">' +
              '<b>' + item.emoji + '</b>' + esc(item.title) +
            '</span>'
          );
        }).join('') + '</div>'
      : '';

    const encouragementHtml = data.encouragement
      ? '<p class="encouragement">' + esc(data.encouragement) + '</p>'
      : '';

    root.innerHTML =
      '<div class="card">' +
        '<div class="card-head">' +
          '<h3>📊 本周复盘</h3>' +
          '<span class="badge ' + intensity.cls + '">明日' + intensity.label + '</span>' +
        '</div>' +
        '<p class="meta-line">统计区间 ' + rangeText + ' · 基于 ' +
          esc(completion ? completion.totalRecords : 0) + ' 条打卡' +
          (data.meta && data.meta.latestWeight
            ? ' · 最近体重 ' + esc(data.meta.latestWeight) + ' kg'
            : '') + '</p>' +
        personaHtml('review', 'intro') +
        '<div class="score-row">' +
          '<span class="score">' + esc(data.score) + '</span>' +
          '<span class="muted">/ 100</span>' +
          '<span class="badge badge-warn">ReviewAgent 规则生成</span>' +
        '</div>' +
        completionHtml +
        statsHtml +
        '<p class="hint">📈 本周每日训练量</p>' +
        chartHtml +
        '<p class="hint">训练感受汇总</p>' +
        feelingsHtml +
        achievementHtml +
        encouragementHtml +
        '<div class="two-col">' +
          renderPlanBlock('做得好', data.highlights) +
          renderPlanBlock('待改进', data.issues) +
        '</div>' +
        '<p class="advice">' + esc(data.report || data.advice) + '</p>' +
        '<div class="mini-block">' +
          '<h4>明日强度调整</h4>' +
          '<p class="muted">' + esc(adjustText) + ' · 训练量 ' +
            (delta > 0 ? '+' : '') + esc(delta) + '%</p>' +
          '<p class="hint">' + esc(data.nextDay.reason) + '</p>' +
        '</div>' +
        personaHtml('review', 'outro') +
        '<p class="disclaimer-note">复盘建议基于打卡数据生成，仅供参考</p>' +
      '</div>';
  }

  /* ============================ 训练日历 ============================ */

  /** 取某天对应的训练计划（周一为一周起点） */
  function planForDate(dateStr) {
    const plan = state.coaching ? state.coaching.trainingPlan : null;
    if (!plan || !Array.isArray(plan.weeklyPlan)) return null;

    const date = parseLocalDate(dateStr);
    if (!date) return null;

    return plan.weeklyPlan[(date.getDay() + 6) % 7] || null;
  }

  /** 部位简称：用于日历格子的小标签 */
  const PART_SHORT = {
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

  /** 日历格子的计划标签：训练日取前两个部位，休息日显示「休」 */
  function shortPlanTag(dayPlan) {
    if (!dayPlan) return '';
    if (dayPlan.isRest) return '休';

    const parts = Array.isArray(dayPlan.parts) ? dayPlan.parts : [];
    const names = [];

    parts.forEach(function (key) {
      const label = PART_SHORT[key];
      if (label && names.indexOf(label) < 0) names.push(label);
    });

    if (!names.length) return dayPlan.focus ? '训练' : '';
    return names.slice(0, 2).join('·');
  }

  /* ---------- 日历状态 emoji 与图例 ---------- */
  /** 打卡感受 → 状态 emoji（配置驱动，新增感受只需加一项） */
  const STATUS_EMOJI = { easy: '😄', ok: '😊', tired: '😅' };

  /** 日历图例：与 STATUS_EMOJI 共用同一套 emoji，避免两处不一致 */
  const STATUS_LEGEND = [
    { emoji: STATUS_EMOJI.easy, label: '轻松' },
    { emoji: STATUS_EMOJI.ok, label: '合适' },
    { emoji: STATUS_EMOJI.tired, label: '太累' },
    { emoji: '📋', label: '待训练' },
    { emoji: '🌿', label: '休息日' }
  ];

  /** 日历格子的动作文字：练胸 / 练背 / 练腿 / 休息，窄格子只取第一个部位 */
  function partActionLabel(dayPlan) {
    if (!dayPlan) return '';
    if (dayPlan.isRest) return '休息';

    const parts = Array.isArray(dayPlan.parts) ? dayPlan.parts : [];
    const first = parts.find(function (key) {
      return Boolean(PART_SHORT[key]);
    });

    if (first) return '练' + PART_SHORT[first];
    return dayPlan.focus ? '训练' : '';
  }

  /**
   * 某天的训练状态 emoji：
   * 已打卡按感受显示；旧版打卡无感受时按「合适」；
   * 未打卡则训练日 📋、休息日 🌿；无计划且未打卡返回空串。
   */
  function dayStatusEmoji(dayPlan, checkin, hasLog) {
    if (checkin) {
      return STATUS_EMOJI[checkin.feeling] || STATUS_EMOJI.ok;
    }
    if (hasLog) return STATUS_EMOJI.ok;
    if (dayPlan && dayPlan.isRest) return '🌿';
    if (dayPlan) return '📋';
    return '';
  }

  /** 日历下方小图例：说明每个状态 emoji 的含义 */
  function renderCalendarLegend() {
    const root = $('#calendar-legend');
    if (!root) return;

    root.innerHTML = STATUS_LEGEND.map(function (item) {
      return (
        '<span><span class="legend-emoji" aria-hidden="true">' + item.emoji + '</span>' +
          esc(item.label) + '</span>'
      );
    }).join('');
  }

  /** 部位 emoji：本周计划列表用 */
  function partEmoji(dayPlan) {
    if (!dayPlan || dayPlan.isRest) return '🌿';

    const parts = Array.isArray(dayPlan.parts) ? dayPlan.parts : [];
    if (parts.indexOf('legs') >= 0) return '🦵';
    if (parts.indexOf('chest') >= 0) return '🦾';
    if (parts.indexOf('back') >= 0) return '🧗';
    if (parts.indexOf('shoulders') >= 0 || parts.indexOf('arms') >= 0) return '💪';
    if (parts.indexOf('core') >= 0 || parts.indexOf('cardio') >= 0) return '🧘';

    return '🏋️';
  }

  /** 本周计划展开区：紧凑动作行（动作名 + 组数 × 次数，一行一条） */
  function renderCompactExerciseList(exercises) {
    if (!exercises || !exercises.length) {
      return '<p class="ex-compact-empty">暂无动作</p>';
    }

    return '<ul class="ex-compact">' + exercises.map(function (item) {
      const spec = item.durationMin
        ? esc(item.reps)
        : esc(item.sets) + ' 组 × ' + esc(item.reps);

      return (
        '<li>' +
          '<span class="ex-compact-name">' + exerciseEmoji(item.name) + ' ' + esc(item.name) + '</span>' +
          '<span class="ex-compact-spec">' + spec + '</span>' +
        '</li>'
      );
    }).join('') + '</ul>';
  }

  /** 热身 / 拉伸压缩成一行文字 */
  function compactBlockLine(label, block) {
    if (!block) return '';

    const items = Array.isArray(block.items) ? block.items : [];
    return (
      '<p class="ex-compact-line">' +
        '<b>' + esc(label) + (block.durationMin ? ' ' + esc(block.durationMin) + ' 分钟' : '') + '</b>' +
        (items.length ? ' · ' + esc(items.join('、')) : '') +
      '</p>'
    );
  }

  /** 单日展开内容：训练日显示紧凑概要 + 热身 + 动作 + 拉伸，休息日显示恢复提示 */
  function weekDetailHtml(dayPlan, isRest) {
    if (isRest) {
      return '<p class="hint">休息日，好好恢复 🌿</p>';
    }

    return (
      '<p class="week-detail-meta">' +
        esc(dayPlan.focus || '训练') +
        (dayPlan.durationMin ? ' · ' + esc(dayPlan.durationMin) + ' 分钟' : '') +
        (INTENSITY_LABEL[dayPlan.intensity] ? ' · ' + esc(INTENSITY_LABEL[dayPlan.intensity]) : '') +
      '</p>' +
      compactBlockLine('热身', dayPlan.warmup) +
      renderCompactExerciseList(dayPlan.exercises) +
      compactBlockLine('拉伸', dayPlan.cooldown)
    );
  }

  /** 点击某天：展开该天；再点同一天收起；点其他天则自动收起上一天 */
  function toggleWeekPlan(index) {
    state.weekPlanOpen = state.weekPlanOpen === index ? null : index;
    applyWeekPlanOpen();
  }

  /** 展开状态同步：箭头方向、aria-expanded、内容显隐 */
  function applyWeekPlanOpen() {
    const root = $('#week-plan');
    if (!root) return;

    $$('#week-plan .week-item').forEach(function (item) {
      const index = Number(item.getAttribute('data-day'));
      const isOpen = state.weekPlanOpen === index;
      const row = item.querySelector('.week-row');
      const detail = item.querySelector('.week-detail');
      const arrow = item.querySelector('.week-arrow');

      item.classList.toggle('is-open', isOpen);
      if (row) row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (detail) detail.hidden = !isOpen;
      if (arrow) arrow.textContent = isOpen ? '▾' : '▸';
    });
  }

  /** 本周计划列表：周一 ~ 周日，每天一行，点击展开/收起当天计划 */
  function renderWeekPlan() {
    const root = $('#week-plan');
    if (!root) return;

    const plan = state.coaching ? state.coaching.trainingPlan : null;
    if (!plan || !Array.isArray(plan.weeklyPlan)) {
      root.innerHTML =
        '<div class="card">' +
          '<p class="hint">生成训练计划后，这里会显示本周安排 📅</p>' +
        '</div>';
      state.weekPlanOpen = null;
      return;
    }

    const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    const rows = labels.map(function (label, index) {
      const dayPlan = plan.weeklyPlan[index];
      const isRest = !dayPlan || dayPlan.isRest;
      const exercises = dayPlan && Array.isArray(dayPlan.exercises)
        ? dayPlan.exercises
        : [];

      return (
        '<div class="week-item" data-day="' + index + '">' +
          '<button type="button" class="week-row' + (isRest ? ' is-rest' : '') +
            '" data-day="' + index + '" aria-expanded="false">' +
            '<span class="week-day">' + label + '</span>' +
            '<span class="week-emoji">' + partEmoji(dayPlan) + '</span>' +
            '<span class="week-focus">' +
              esc(isRest ? '休息 / 主动恢复' : (dayPlan.focus || '训练')) + '</span>' +
            '<span class="week-meta">' +
              (isRest ? '好好恢复' : exercises.length + ' 个动作') + '</span>' +
            '<span class="week-arrow" aria-hidden="true">▸</span>' +
          '</button>' +
          '<div class="week-detail" data-day="' + index + '" hidden>' +
            weekDetailHtml(dayPlan, isRest) +
          '</div>' +
        '</div>'
      );
    }).join('');

    root.innerHTML =
      '<div class="card">' +
        '<div class="card-head">' +
          '<h2>🗓️ 本周计划</h2>' +
          '<span class="tag">点击查看详情</span>' +
        '</div>' +
        rows +
      '</div>';

    // 事件委托：只绑定一次，展开时同步「同时只开一天」
    if (!root.dataset.weekBound) {
      root.dataset.weekBound = '1';
      root.addEventListener('click', function (event) {
        const row = event.target.closest('.week-row');
        if (!row) return;

        const index = Number(row.getAttribute('data-day'));
        if (!Number.isFinite(index)) return;

        toggleWeekPlan(index);
      });
    }

    applyWeekPlanOpen();
  }

  function renderCalendar() {
    const grid = $('#calendar-grid');
    const title = $('#calendar-title');
    if (!grid) return;

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    if (title) title.textContent = year + ' 年 ' + (month + 1) + ' 月';

    const firstWeekday = new Date(year, month, 1).getDay();
    const offset = (firstWeekday + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = todayStr();
    const selected = state.calendarSelected || today;

    // 打卡日期集合：以 checkins 为准，兼容旧版 reviewHistory
    const logMap = {};
    state.reviewHistory.forEach(function (item) {
      if (item && item.date) logMap[item.date] = true;
    });
    state.checkins.forEach(function (item) {
      if (item && item.date) logMap[item.date] = true;
    });

    // 打卡详情索引：用于取当天感受（轻松 / 合适 / 太累）
    const checkinMap = {};
    state.checkins.forEach(function (item) {
      if (item && item.date) checkinMap[item.date] = item;
    });

    const cells = [];
    ['一', '二', '三', '四', '五', '六', '日'].forEach(function (label) {
      cells.push('<div class="cal-dow">' + label + '</div>');
    });
    for (let i = 0; i < offset; i += 1) {
      cells.push('<div class="cal-cell is-blank"></div>');
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateStr = year + '-' + pad(month + 1) + '-' + pad(day);
      const hasLog = Boolean(logMap[dateStr]);

      const dayPlan = planForDate(dateStr);
      const planLabel = partActionLabel(dayPlan);
      const statusEmoji = dayStatusEmoji(dayPlan, checkinMap[dateStr], hasLog);
      const isRestDay = Boolean(dayPlan && dayPlan.isRest);

      cells.push(
        '<button type="button" class="cal-cell' +
          (dateStr === today ? ' is-today' : '') +
          (dateStr === selected ? ' is-selected' : '') +
          (hasLog ? ' has-log' : '') +
          '" data-date="' + dateStr + '" aria-label="' + dateStr + '">' +
          (hasLog ? '<span class="check-mark" aria-hidden="true">✓</span>' : '') +
          '<span class="cal-day">' + day + '</span>' +
          (planLabel || statusEmoji
            ? '<span class="cal-tag' + (isRestDay ? ' is-rest' : '') + '">' +
                (planLabel
                  ? '<span class="cal-plan-text">' + esc(planLabel) + '</span>'
                  : '') +
                (statusEmoji
                  ? '<span class="cal-status" aria-hidden="true">' + statusEmoji + '</span>'
                  : '') +
              '</span>'
            : '') +
        '</button>'
      );
    }

    grid.innerHTML = cells.join('');

    $$('#calendar-grid .cal-cell[data-date]').forEach(function (cell) {
      cell.addEventListener('click', function () {
        state.calendarSelected = cell.getAttribute('data-date');

        // 只更新选中态，避免整块重绘
        $$('#calendar-grid .cal-cell[data-date]').forEach(function (item) {
          item.classList.toggle('is-selected', item === cell);
        });

        renderCalendarDetail(state.calendarSelected);
      });
    });

    renderCalendarDetail(selected);
    renderCalendarLegend();
    renderWeekPlan();
  }

  /** 点击日期后展示当天训练计划、打卡记录与饮食热量记录 */
  function renderCalendarDetail(dateStr) {
    const root = $('#calendar-detail');
    if (!root) return;

    const date = parseLocalDate(dateStr);
    if (!date) {
      root.innerHTML = '';
      return;
    }

    const plan = state.coaching ? state.coaching.trainingPlan : null;
    const nutritionPlan = state.coaching ? state.coaching.nutritionPlan : null;
    const weekdayIndex = (date.getDay() + 6) % 7;
    const dayPlan = plan ? plan.weeklyPlan[weekdayIndex] : null;
    const checkin = state.checkins.find(function (item) {
      return item.date === dateStr;
    });
    const feelingLabels = { easy: '轻松', ok: '合适', tired: '太累' };

    let planHtml = '';
    if (!plan) {
      planHtml = '<p class="muted">还没有训练计划，请先在「首页」生成方案。</p>';
    } else if (!dayPlan || dayPlan.isRest) {
      planHtml =
        '<div class="day-item is-rest">' +
          '<span class="day-name">休息日</span>' +
          '<span class="day-focus">休息 / 主动恢复</span>' +
          '<span class="day-meta">散步 20~30 分钟</span>' +
        '</div>';
    } else {
      planHtml =
        '<div class="day-item is-train">' +
          '<span class="day-name">' + esc(weekdayLabel(dateStr)) + '</span>' +
          '<span class="day-focus">' + esc(dayPlan.focus) + '</span>' +
          '<span class="day-meta">' + esc(dayPlan.durationMin) + ' 分钟 · ' +
            esc(INTENSITY_LABEL[dayPlan.intensity] || '') + '</span>' +
        '</div>' +
        (dayPlan.warmup
          ? renderPlanBlock('热身 ' + dayPlan.warmup.durationMin + ' 分钟', dayPlan.warmup.items)
          : '') +
        renderExerciseList(dayPlan.exercises) +
        (dayPlan.cooldown
          ? renderPlanBlock('拉伸 ' + dayPlan.cooldown.durationMin + ' 分钟', dayPlan.cooldown.items)
          : '');
    }

    const checkinHtml = checkin
      ? '<p class="hint">当天打卡：' + esc(feelingLabels[checkin.feeling] || '合适') +
        ' · 完成 ' + Math.round((Number(checkin.completionRate) || 0) * 100) + '%' +
        (checkin.note ? ' · ' + esc(checkin.note) : '') + '</p>'
      : '<p class="hint">当天暂无打卡记录。</p>';

    // ---------- 当天饮食简记 ----------
    const isTrainingDay = Boolean(dayPlan && !dayPlan.isRest);
    const targetCalories = nutritionPlan
      ? isTrainingDay
        ? (nutritionPlan.trainingDay
            ? nutritionPlan.trainingDay.calories
            : nutritionPlan.targetCalories)
        : (nutritionPlan.restDay
            ? nutritionPlan.restDay.calories
            : nutritionPlan.targetCalories)
      : null;

    const dietLog = state.dietLogs[dateStr] || null;
    const dietHtml =
      '<div class="mini-block"><h4>🍽️ 饮食简记</h4></div>' +
      renderDietBrief(dietLog, targetCalories);

    root.innerHTML =
      '<div class="card">' +
        '<div class="card-head">' +
          '<h3>' + esc(dateStr) + ' · ' + esc(weekdayLabel(dateStr)) + '</h3>' +
          '<span class="badge ' + (checkin ? 'badge--up' : 'badge--ok') + '">' +
            (checkin ? '已打卡' : '未打卡') + '</span>' +
        '</div>' +
        checkinHtml +
        '<div class="mini-block"><h4>当天训练安排</h4></div>' +
        planHtml +
        dietHtml +
      '</div>';

    }

  /** 日历详情「饮食简记」：按餐次一行一条，只列食物名与该餐热量 */
  function renderDietBrief(dietLog, targetCalories) {
    const items = dietLog && Array.isArray(dietLog.items) ? dietLog.items : [];
    const hasLog = Boolean(dietLog) && Number.isFinite(Number(dietLog && dietLog.calories));
    const actualCalories = hasLog
      ? Number(dietLog.calories)
      : items.length
        ? items.reduce(function (sum, item) {
            return sum + (Number(item.calories) || 0);
          }, 0)
        : null;

    const targetText = targetCalories === null || targetCalories === undefined
      ? '目标 --'
      : '目标 ' + Math.round(Number(targetCalories) || 0) + ' kcal';
    const actualText = actualCalories === null ? '实际 --' : '实际 ' + actualCalories + ' kcal';

    const head =
      '<p class="diet-brief-sum">' + actualText + ' / ' + targetText + '</p>';

    if (!items.length) {
      return (
        '<div class="diet-brief">' + head +
          '<p class="diet-brief-empty">' +
            (hasLog ? '只记了总热量，没有食物明细' : '当天暂无饮食记录') +
          '</p>' +
        '</div>'
      );
    }

    const rows = MEALS.map(function (meal) {
      const mealItems = items.filter(function (item) {
        return (item.meal || 'lunch') === meal.key;
      });
      if (!mealItems.length) return '';

      const kcal = mealItems.reduce(function (sum, item) {
        return sum + (Number(item.calories) || 0);
      }, 0);
      const names = mealItems.map(function (item) {
        return esc(item.name || '食物');
      }).join('、');

      return (
        '<li class="diet-brief-row">' +
          '<span class="diet-brief-emoji">' + meal.emoji + '</span>' +
          '<span class="diet-brief-name">' + names + '</span>' +
          '<span class="diet-brief-kcal">' + kcal + ' kcal</span>' +
        '</li>'
      );
    }).join('');

    return (
      '<div class="diet-brief">' + head +
        '<ul class="diet-brief-list">' + rows + '</ul>' +
      '</div>'
    );
  }

  /* ============================ 健康科普 ============================ */

  /**
   * 科普文章库（配置驱动）：新增文章只需往数组里追加一项。
   * 每天按日期种子自动选一篇，也可以点「换一篇」随机切换。
   */
  const SCIENCE_ARTICLES = [
    {
      emoji: '🔥',
      title: '热身为什么不能省？',
      category: '训练',
      minutes: 2,
      points: [
        '热身能升高肌肉温度、增加关节活动度，让神经系统提前进入工作状态。',
        '建议 5~10 分钟：低强度有氧 3 分钟 + 目标肌群动态拉伸 2~3 分钟。',
        '正式组前用轻重量做 1~2 组，能明显降低拉伤和动作变形风险。'
      ],
      tip: '今天训练前先做 30 秒原地高抬腿 + 肩绕环，身体会更快进入状态。'
    },
    {
      emoji: '🥩',
      title: '蛋白质怎么吃才够？',
      category: '营养',
      minutes: 2,
      points: [
        '增肌期建议每天每公斤体重 1.6~2.0 g 蛋白质，减脂期可提高到 2.0~2.2 g。',
        '把总量分到 3~4 餐，每餐 25~35 g 更容易被利用。',
        '训练后 30~60 分钟内补充一次，搭配主食效果更好。'
      ],
      tip: '一块手掌大小的鸡胸肉约 100 g，含 24 g 蛋白质，可以先用它来估算。'
    },
    {
      emoji: '💧',
      title: '训练前后怎么补水？',
      category: '补水',
      minutes: 2,
      points: [
        '日常饮水可按每公斤体重 30~40 ml 估算。',
        '训练前 30 分钟补充 300~500 ml，训练中每 15~20 分钟小口补水。',
        '训练超过 60 分钟或出汗量大时，可适当补充电解质。'
      ],
      tip: '尿液呈浅黄色，通常说明补水基本充足。'
    },
    {
      emoji: '😴',
      title: '睡眠不足会毁掉训练吗？',
      category: '恢复',
      minutes: 2,
      points: [
        '睡眠不足会降低力量表现、延长恢复时间，也会让食欲和情绪更不稳定。',
        '尽量保证 7~9 小时睡眠，固定入睡时间比周末补觉更有效。',
        '连续熬夜时，优先降低训练量，而不是硬撑完成计划。'
      ],
      tip: '今晚睡前 30 分钟放下手机，入睡会明显更快。'
    },
    {
      emoji: '🧍',
      title: '常见错误姿势：深蹲 / 俯卧撑 / 硬拉',
      category: '动作',
      minutes: 2,
      points: [
        '深蹲：膝盖与脚尖方向一致，避免内扣；重心落在全脚掌。',
        '俯卧撑：身体保持一条直线，手肘与躯干约呈 45 度，不要塌腰耸肩。',
        '硬拉：杠铃贴近身体，背部中立，先屈髋再屈膝，不要弓背起杠。'
      ],
      tip: '训练模式里的姿势评测会实时提示这些要点，可以先侧面拍摄自己。'
    },
    {
      emoji: '🧘',
      title: '训练后的恢复清单',
      category: '恢复',
      minutes: 2,
      points: [
        '训练后 10 分钟低强度拉伸，帮助心率平稳回落。',
        '同一肌群高强度训练后，建议间隔 48 小时再练。',
        '睡眠、蛋白质与补水是恢复的三块基石，缺一块都会拖慢进度。'
      ],
      tip: '把拉伸安排在训练结束后立刻做，比拖到睡前更容易坚持。'
    },
    {
      emoji: '⚖️',
      title: '三个常见减脂误区',
      category: '减脂',
      minutes: 2,
      points: [
        '局部减脂并不存在，减脂是全身性的，腹部脂肪要靠整体热量缺口。',
        '过度节食会掉肌肉、降低基础代谢，反而更难维持。',
        '只做有氧不练力量，减下来的体型往往松垮。'
      ],
      tip: '每天 300~500 kcal 的温和热量缺口，比极端节食更容易长期坚持。'
    },
    {
      emoji: '🍚',
      title: '增肌期的饮食重点',
      category: '增肌',
      minutes: 2,
      points: [
        '在维持热量基础上小幅盈余（约 200~300 kcal），避免脂肪增长过快。',
        '碳水化合物是训练的主要燃料，训练前后都要保证摄入。',
        '蛋白质均匀分配到各餐，比集中在晚餐更有利于合成。'
      ],
      tip: '增肌期每周体重上涨 0.2~0.4 kg 是较合理的速度。'
    }
  ];

  /** 健康小测试题库：answer 为正确选项下标，explain 为答后科普解析 */
  const QUIZ_QUESTIONS = [
    {
      question: '正式训练前，热身建议安排多长时间？',
      options: ['不需要热身', '5~10 分钟动态热身', '30 分钟以上'],
      answer: 1,
      explain: '身体就像冷启动的车，先低强度动一动、把关节“热开”，正式组才不容易拉伤。5~10 分钟刚刚好 🚗💨'
    },
    {
      question: '增肌期每天每公斤体重的蛋白质建议范围是？',
      options: ['0.5~0.8 g', '1.6~2.0 g', '3~4 g'],
      answer: 1,
      explain: '肌肉修复需要“砖块”，每公斤体重 1.6~2.0 g 是常见区间。分到 3~4 餐吃，比一顿猛塞更有效 🧱'
    },
    {
      question: '睡眠对训练效果的影响是？',
      options: ['几乎没有影响', '只影响情绪', '影响恢复与运动表现'],
      answer: 2,
      explain: '深睡时身体才忙着修肌肉、补糖原。睡不够，第二天的力量和专注力都会打折 😴'
    },
    {
      question: '训练前补水，比较合适的做法是？',
      options: ['等口渴再喝', '提前 30 分钟喝 300~500 ml', '训练中一口不喝'],
      answer: 1,
      explain: '别等口渴才想起喝水。提前补一点，训练中每 15~20 分钟小口喝，状态会更稳 💧'
    },
    {
      question: '做深蹲时，膝盖应该朝哪个方向？',
      options: ['与脚尖方向一致', '尽量向内夹', '随意，怎么舒服怎么来'],
      answer: 0,
      explain: '膝盖跟着脚尖走，力量才顺。内扣会让膝关节压力变大，慢慢蹲、稳住重心就好 🦵'
    },
    {
      question: '想减掉肚子上的脂肪，最有效的是？',
      options: ['每天狂做卷腹', '整体制造热量缺口', '只瘦肚子的局部训练'],
      answer: 1,
      explain: '局部减脂并不存在，脂肪是全身一起掉的。卷腹练的是腹肌，想瘦腰还得靠整体热量缺口 ⚖️'
    },
    {
      question: '同一肌群高强度训练后，建议间隔多久再练？',
      options: ['第二天就能再练', '48 小时左右', '一周都不用练'],
      answer: 1,
      explain: '肌肉是在休息时变强的。连着两天猛练同一部位，反而容易疲劳、进步变慢 🧘'
    },
    {
      question: '训练结束后，比较理想的补充时机是？',
      options: ['30~60 分钟内补蛋白 + 碳水', '等睡前再说', '只喝白水就够了'],
      answer: 0,
      explain: '练完身体正“饿着”，这时候补蛋白质和主食，修复效率更高，也更不容易掉肌肉 🍚'
    },
    {
      question: '减脂期还需要做力量训练吗？',
      options: ['不需要，只做有氧就行', '需要，能帮你留住肌肉', '看心情，做不做都一样'],
      answer: 1,
      explain: '力量训练帮你留住肌肉，基础代谢才不会越减越低。只做有氧，体型容易松垮 🏋️'
    },
    {
      question: '判断自己补水是否充足，简单的方法是？',
      options: ['看尿液颜色是否浅黄', '感觉不渴就行', '看体重变化'],
      answer: 0,
      explain: '身体缺水时尿液会变深。浅黄色通常说明补水差不多够了，简单又实用 🚻'
    },
    {
      question: '增肌期每天的热量盈余，建议控制在？',
      options: ['越多越好', '200~300 kcal 小幅盈余', '完全不吃主食'],
      answer: 1,
      explain: '吃太多容易长脂肪，吃太少又难长肌肉。小幅盈余、慢慢加，才是稳稳变强的路 📈'
    },
    {
      question: '训练前更适合做哪种拉伸？',
      options: ['长时间静态拉伸', '动态拉伸唤醒身体', '不需要任何拉伸'],
      answer: 1,
      explain: '训练前做动态拉伸，把身体叫醒；长时间静态拉伸放在训练后更合适 🌿'
    },
    {
      question: '刚开始健身的新手，每周练几次比较合适？',
      options: ['每天都练', '2~3 次', '一周一次就够'],
      answer: 1,
      explain: '新手先让身体适应，每周 2~3 次全身训练，恢复得过来才容易坚持 🌱'
    },
    {
      question: '新手更适合哪种训练安排？',
      options: ['全身训练', '一天只练一个部位', '只练手臂'],
      answer: 0,
      explain: '全身训练每个部位都能练到，频率高、学习动作快，是新手最划算的选择 🧩'
    },
    {
      question: '单次力量训练，比较合适的时间是？',
      options: ['10 分钟速战速决', '45~60 分钟', '3 小时以上'],
      answer: 1,
      explain: '45~60 分钟足够完成有效训练，时间太长反而容易疲劳、动作变形 ⏱️'
    },
    {
      question: '「渐进超负荷」的意思是？',
      options: ['每次都练到吐', '逐步增加重量或次数', '一直换新动作'],
      answer: 1,
      explain: '身体需要一点点新刺激才会变强。重量或次数慢慢加，比猛练一次更靠谱 📈'
    },
    {
      question: '什么时候适合给动作加重量？',
      options: ['动作还不稳定时', '能稳定完成目标次数后', '心情好的时候'],
      answer: 1,
      explain: '先把动作做稳，再谈重量。稳定完成目标次数后再加一点，进步才安全 🏋️'
    },
    {
      question: '每组训练都必须练到力竭吗？',
      options: ['必须，不然没效果', '不必，留 1~2 次余力就好', '越早力竭越好'],
      answer: 1,
      explain: '每组都力竭会很累、恢复变慢。留一点余力，反而能练得更多、更稳 💪'
    },
    {
      question: '硬拉时，背部应该保持什么状态？',
      options: ['弓背发力', '中立位', '随意扭转'],
      answer: 1,
      explain: '背部保持中立、杠铃贴近身体，力量才能顺畅传到杠上，腰也更安全 🧍'
    },
    {
      question: '卧推时肩胛骨应该？',
      options: ['后缩下沉贴紧凳面', '耸肩向上', '完全放松'],
      answer: 0,
      explain: '肩胛后缩下沉能把肩关节稳住，推起来更有力，也更不容易伤肩 🦾'
    },
    {
      question: '做划船类动作，第一步应该？',
      options: ['先耸肩再拉', '先沉肩再拉', '直接甩起来'],
      answer: 1,
      explain: '先沉肩固定肩胛，再用手肘往后拉，背部的发力感会明显很多 🔥'
    },
    {
      question: '做弓步蹲时，前腿膝盖应该？',
      options: ['与脚尖方向一致', '尽量内扣', '完全锁死不弯'],
      answer: 0,
      explain: '膝盖跟着脚尖走，重心稳、膝盖压力小，动作也更顺 🦵'
    },
    {
      question: '平板支撑时，身体应该？',
      options: ['塌腰下沉', '保持一条直线', '屁股撅高'],
      answer: 1,
      explain: '核心收紧、身体一条线，才是真正练到核心；塌腰会让腰先累 🧘'
    },
    {
      question: '还做不了引体向上，应该先练什么？',
      options: ['直接硬拉上去', '高位下拉或辅助引体', '只练手臂'],
      answer: 1,
      explain: '先用高位下拉或辅助引体积累力量，再挑战标准引体，进步更快 🧗'
    },
    {
      question: '做肩上推举时，最需要注意的是？',
      options: ['过度挺腰', '收紧核心、不要塌腰', '憋气到底'],
      answer: 1,
      explain: '推举时核心收紧、肋骨别外翻，腰才不会被顶得难受 🔥'
    },
    {
      question: '做哑铃弯举时，手肘应该？',
      options: ['固定在身体两侧', '跟着手臂前后甩', '完全抬起'],
      answer: 0,
      explain: '手肘固定，只让前臂发力，肱二头肌才真正吃到力；甩起来就变成借力了 💪'
    },
    {
      question: '练核心时，呼吸应该？',
      options: ['一直憋气', '发力时呼气', '随意大口喘'],
      answer: 1,
      explain: '发力呼气、还原吸气，核心会更稳，也不容易憋得头晕 🫁'
    },
    {
      question: '每周中等强度有氧，推荐累计多长时间？',
      options: ['30 分钟', '150 分钟左右', '10 小时以上'],
      answer: 1,
      explain: '每周 150 分钟中等强度有氧，是兼顾心肺与恢复的常见推荐 🏃'
    },
    {
      question: 'HIIT 训练，每周安排几次比较合适？',
      options: ['每天', '2~3 次', '一周 10 次'],
      answer: 1,
      explain: 'HIIT 强度高、恢复慢，每周 2~3 次就很好，多了反而影响状态 ⚡'
    },
    {
      question: '最大心率的简单估算方法是？',
      options: ['220 减去年龄', '年龄乘以 2', '固定 200'],
      answer: 0,
      explain: '220 - 年龄是常见估算，用来大致划分训练强度区间就够用了 ❤️'
    },
    {
      question: '常见的「燃脂心率区间」大约是最大心率的？',
      options: ['30%~40%', '60%~70%', '95% 以上'],
      answer: 1,
      explain: '60%~70% 属于能说话但有点喘的强度，脂肪供能比例较高，也更容易坚持 🔥'
    },
    {
      question: '空腹有氧是减脂的必需品吗？',
      options: ['是，必须空腹', '不是，看个人习惯', '空腹越久越好'],
      answer: 1,
      explain: '空腹有氧不是必须的，总热量缺口才是关键。选自己能坚持的方式最重要 ☀️'
    },
    {
      question: '同一次训练里，力量和有氧应该怎么排？',
      options: ['先有氧再力量', '先力量再有氧', '随便，没区别'],
      answer: 1,
      explain: '先做力量，能用最好的状态推重量；有氧放后面，减脂和体能也都能兼顾 🏋️'
    },
    {
      question: '有氧做太多会影响增肌吗？',
      options: ['完全不会', '过量时可能影响恢复与增肌', '有氧越多越增肌'],
      answer: 1,
      explain: '适量有氧有益心肺，但量太大、恢复跟不上时，确实会拖慢增肌 🏃'
    },
    {
      question: '日常想增加活动量，每天步数目标可以定在？',
      options: ['1000 步', '7000~10000 步', '5 万步'],
      answer: 1,
      explain: '7000~10000 步是比较好坚持的区间，对日常消耗和心肺都有帮助 👟'
    },
    {
      question: '碳水化合物最主要的作用是？',
      options: ['提供训练能量', '直接变成脂肪', '没有任何作用'],
      answer: 0,
      explain: '碳水是训练的主要燃料，吃够才有力气练，恢复也更快 🍚'
    },
    {
      question: '碳水放在什么时候吃更合适？',
      options: ['训练前后', '只在睡前', '完全不吃'],
      answer: 0,
      explain: '训练前后补碳水，能量和恢复都能兼顾，不用刻意躲着主食 🍠'
    },
    {
      question: '脂肪在饮食中的作用是？',
      options: ['完全没必要', '参与激素合成与吸收脂溶性维生素', '只能长胖'],
      answer: 1,
      explain: '适量脂肪参与激素合成，还能帮助吸收维生素 A、D、E、K，别一刀切 🥑'
    },
    {
      question: '每天膳食纤维的建议摄入量大约是？',
      options: ['5 g', '25~30 g', '100 g'],
      answer: 1,
      explain: '25~30 g 膳食纤维能帮助肠道和饱腹感，蔬菜、全谷物、水果都是好来源 🥬'
    },
    {
      question: '一天吃几餐更有利于控制饮食？',
      options: ['必须只吃一餐', '3~5 餐都可以', '越多越好'],
      answer: 1,
      explain: '餐次没有绝对标准，3~5 餐只要总热量合适、自己好坚持就行 🍽️'
    },
    {
      question: '训练前的一餐，建议提前多久吃？',
      options: ['1~2 小时', '训练前一分钟', '训练后再说'],
      answer: 0,
      explain: '提前 1~2 小时吃，既不会饿着练，也不容易顶着饱腹感难受 ⏰'
    },
    {
      question: '蛋白粉是增肌的必需品吗？',
      options: ['是，不喝就练不出来', '不是，食物够就不用', '只能用蛋白粉补蛋白'],
      answer: 1,
      explain: '蛋白粉只是方便的补充方式。日常饮食蛋白够，就完全不需要额外买 🥤'
    },
    {
      question: '吃鸡蛋时，只吃蛋白更好吗？',
      options: ['是，蛋黄没用', '全蛋营养更全面', '蛋黄会立刻长胖'],
      answer: 1,
      explain: '蛋黄里有维生素和健康脂肪，健康人每天吃全蛋完全没问题 🥚'
    },
    {
      question: '吃红肉时，比较推荐的做法是？',
      options: ['选瘦肉、适量吃', '每天大量吃肥肉', '完全不吃'],
      answer: 0,
      explain: '瘦牛肉、瘦猪肉是不错的蛋白来源，适量吃、注意烹饪方式就好 🥩'
    },
    {
      question: '深海鱼对健身人群的好处主要是？',
      options: ['提供优质蛋白和 Omega-3', '只有脂肪', '没有好处'],
      answer: 0,
      explain: '三文鱼、鲈鱼等能提供优质蛋白和 Omega-3，对恢复和心血管都友好 🐟'
    },
    {
      question: '维生素 D 的主要来源之一是？',
      options: ['晒太阳', '只靠喝水', '只靠米饭'],
      answer: 0,
      explain: '适度晒太阳有助于合成维生素 D，日照不足时可以咨询后补充 ☀️'
    },
    {
      question: '补钙比较方便的食物来源是？',
      options: ['奶制品', '可乐', '白米饭'],
      answer: 0,
      explain: '牛奶、酸奶、豆制品都是不错的钙来源，骨骼健康别忽视 🥛'
    },
    {
      question: '女性健身者更容易缺哪种矿物质？',
      options: ['铁', '钠', '氟'],
      answer: 0,
      explain: '女性因生理周期更容易缺铁，红肉、动物肝脏、豆类都可以帮忙补 🩸'
    },
    {
      question: '训练前喝咖啡，比较合适的量是？',
      options: ['越多越有劲', '适量即可', '训练后喝才有效'],
      answer: 1,
      explain: '适量咖啡因能提神、提升表现，但过量会心慌、影响睡眠，别贪杯 ☕'
    },
    {
      question: '训练后大量喝酒，会怎样？',
      options: ['帮助恢复', '影响恢复与睡眠', '完全没影响'],
      answer: 1,
      explain: '酒精会影响肌肉修复和睡眠质量，训练日更建议少喝或不喝 🍺'
    },
    {
      question: '想喝果汁时，更推荐？',
      options: ['直接吃完整水果', '大量喝果汁', '用果汁代替所有水'],
      answer: 0,
      explain: '完整水果有纤维、饱腹感更强；果汁糖分集中，容易一不小心喝多 🍎'
    },
    {
      question: '减脂时，每天的热量缺口建议控制在？',
      options: ['1000 kcal 以上', '300~500 kcal', '不需要缺口'],
      answer: 1,
      explain: '300~500 kcal 的温和缺口更容易坚持，也不容易掉肌肉 ⚖️'
    },
    {
      question: '体重每天上下浮动 1~2 斤，通常是因为？',
      options: ['一夜长胖了', '水分和食物残留的正常波动', '肌肉暴涨'],
      answer: 1,
      explain: '体重受水分、盐分、排便影响很大，看一周趋势比看单日更靠谱 📉'
    },
    {
      question: '减脂遇到平台期，比较合理的做法是？',
      options: ['直接放弃', '微调热量或训练量并观察两周', '立刻断食'],
      answer: 1,
      explain: '平台期很常见，先微调热量或增加活动量，给身体一点时间再评估 🔍'
    },
    {
      question: '长期用代餐代替正餐，主要问题是？',
      options: ['营养不全面、难坚持', '会变成肌肉', '完全没有问题'],
      answer: 0,
      explain: '代餐方便但营养单一，长期替代正餐容易缺营养，也更难坚持 🥣'
    },
    {
      question: '过度节食减脂，最可能的结果是？',
      options: ['只掉脂肪', '掉肌肉、代谢下降', '越吃越壮'],
      answer: 1,
      explain: '吃得太少，身体会拆肌肉供能，基础代谢也跟着降，反而更难瘦 📉'
    },
    {
      question: '晚上吃东西一定会长胖吗？',
      options: ['会，晚上吃什么都长肉', '关键看全天总热量', '晚上吃更健康'],
      answer: 1,
      explain: '长胖看的是全天总热量，不是吃饭时间。晚点吃没问题，别额外加太多零食就行 🌙'
    },
    {
      question: '减脂期称体重，比较推荐的做法是？',
      options: ['一天称十次', '每周 1~2 次固定时间', '一个月称一次'],
      answer: 1,
      explain: '固定时间称、看趋势更准，一天内体重波动太大，容易影响心情 ⚖️'
    },
    {
      question: '相比体重，更能反映胖瘦的是？',
      options: ['体脂率', '鞋码', '身高'],
      answer: 0,
      explain: '同样的体重，肌肉多的人看起来更紧致。体脂率和围度比体重更有参考价值 📏'
    },
    {
      question: '每个肌群每周的训练组数，常见推荐是？',
      options: ['1~2 组', '10~20 组', '100 组'],
      answer: 1,
      explain: '每个肌群每周 10~20 组是常见的增肌区间，太少不够、太多恢复不过来 🏋️'
    },
    {
      question: '力量训练时，动作下放阶段应该？',
      options: ['自由落体', '控制 2~3 秒慢慢下放', '越快越好'],
      answer: 1,
      explain: '离心阶段控制住，肌肉受力时间更长，刺激更充分，也更安全 🐢'
    },
    {
      question: '大肌群训练后，组间休息通常建议？',
      options: ['10 秒', '2~3 分钟', '20 分钟'],
      answer: 1,
      explain: '深蹲、硬拉这类大动作休息 2~3 分钟，下一组力量才恢复得过来 ⏳'
    },
    {
      question: '肌肉酸痛说明练到位了吗？',
      options: ['一定练到位了', '不一定，酸痛受很多因素影响', '越痛越好'],
      answer: 1,
      explain: '酸痛不等于有效，动作质量、渐进超负荷才是关键，别拿酸痛当唯一标准 🤔'
    },
    {
      question: '新手增肌，比较合理的速度是？',
      options: ['每月 0.5~1 kg', '每周 5 kg', '越快越好'],
      answer: 0,
      explain: '新手每月涨 0.5~1 kg 已经很不错，涨太快多半是脂肪在凑数 📈'
    },
    {
      question: '新手前几个月进步特别快，主要因为？',
      options: ['神经适应', '肌肉瞬间长大', '吃了蛋白粉'],
      answer: 0,
      explain: '新手先提升的是神经招募能力，动作越来越顺，力量自然涨得快 🧠'
    },
    {
      question: '成年人每晚建议睡多久？',
      options: ['3~4 小时', '7~9 小时', '12 小时以上'],
      answer: 1,
      explain: '7~9 小时是多数成年人的合适区间，恢复、情绪和状态都靠它 😴'
    },
    {
      question: '午睡时间建议控制在？',
      options: ['20~30 分钟', '3 小时', '不睡最好'],
      answer: 0,
      explain: '20~30 分钟的小睡能提神又不影响晚上入睡，睡太久反而更困 💤'
    },
    {
      question: '训练结束后做静态拉伸，主要作用是？',
      options: ['帮助放松、缓解紧张', '立刻增肌', '代替热身'],
      answer: 0,
      explain: '训练后拉伸帮助肌肉放松、恢复活动度，放在练完做最合适 🌿'
    },
    {
      question: '泡沫轴放松时，应该避开？',
      options: ['大腿肌肉', '关节和骨头', '臀部'],
      answer: 1,
      explain: '泡沫轴压肌肉就好，别直接压关节和脊柱，力度以舒服为准 🧴'
    },
    {
      question: '力量训练后立刻泡冷水澡，可能？',
      options: ['更利于增肌', '影响肌肉合成，慎用', '完全没有影响'],
      answer: 1,
      explain: '冷水浴可能抑制部分炎症与合成信号，增肌期不建议每次练完都泡 🚿'
    },
    {
      question: '每周需要安排休息日吗？',
      options: ['不需要，天天练', '需要，恢复同样重要', '只休息一天就够'],
      answer: 1,
      explain: '肌肉在休息时修复生长，安排 1~2 天轻松日或休息日，进步反而更稳 🛌'
    },
    {
      question: '以下哪个是过度训练的常见信号？',
      options: ['睡眠变好', '持续疲劳、失眠、心率偏高', '力量稳步上涨'],
      answer: 1,
      explain: '长期疲劳、睡不好、静息心率升高，可能提示练过头了，该减量休息 ⚠️'
    },
    {
      question: '训练时腰部不适，首先应该？',
      options: ['忍痛继续', '停下评估动作与核心稳定', '直接加重'],
      answer: 1,
      explain: '腰不舒服先停下，检查动作和核心是否稳住；持续疼痛要及时就医 🩺'
    },
    {
      question: '膝盖偶尔不适，训练上可以？',
      options: ['减少冲击类动作、加强腿部力量', '完全不动', '继续跑跳'],
      answer: 0,
      explain: '适当减少跳跃和冲击，配合腿部力量训练，膝盖的稳定性会慢慢变好 🦵'
    },
    {
      question: '肩部不舒服时，通常先减少？',
      options: ['过顶推举类动作', '所有下肢动作', '喝水'],
      answer: 0,
      explain: '过顶动作对肩关节要求高，不舒服时先降重量或换动作，别硬顶 🦾'
    },
    {
      question: '举重腰带主要在什么时候用？',
      options: ['大重量复合动作', '所有训练都戴', '走路时戴'],
      answer: 0,
      explain: '腰带是给深蹲、硬拉这类大重量动作提供腹压支撑，不是全程护身符 🎽'
    },
    {
      question: '力量训练发力时，呼吸应该？',
      options: ['憋住不呼', '发力呼气、还原吸气', '随意大口喘'],
      answer: 1,
      explain: '发力呼气能稳住核心、避免憋气头晕，节奏顺了动作也更稳 🫁'
    },
    {
      question: '训练中突然头晕，可能的原因不包括？',
      options: ['补水不足', '血糖偏低', '肌肉变多了'],
      answer: 2,
      explain: '头晕常见于缺水、低血糖或强度过大，先停下休息、补充水分和糖分 🥤'
    },
    {
      question: '夏天户外训练，最重要的是？',
      options: ['多补水、避开高温时段', '穿厚衣服暴汗', '不喝水'],
      answer: 0,
      explain: '高温下补水、降温、避开正午，能有效降低中暑和脱水风险 ☀️'
    },
    {
      question: '女性做力量训练会变成「金刚芭比」吗？',
      options: ['会，很快变壮', '不会，激素水平决定了增肌速度较慢', '只要练就会'],
      answer: 1,
      explain: '女性睾酮水平较低，力量训练更多带来紧致线条，不会轻易练成夸张肌肉 💃'
    },
    {
      question: '经期还想训练，应该？',
      options: ['必须完全停练', '根据身体感受调整强度', '越练越猛'],
      answer: 1,
      explain: '经期可以练，但要听身体的：难受就休息或降低强度，舒服就正常动一动 🌸'
    },
    {
      question: '老年人做力量训练，好处是？',
      options: ['没有好处', '有助于维持肌肉与骨骼健康', '一定会受伤'],
      answer: 1,
      explain: '适量力量训练能帮助老年人维持肌肉量和骨密度，注意循序渐进即可 👵'
    },
    {
      question: '久坐办公的人，比较推荐？',
      options: ['每小时起身活动几分钟', '一坐一整天', '只在下班后猛练'],
      answer: 0,
      explain: '每小时起身走动、活动肩颈，比久坐后一次性猛练更友好 🪑'
    },
    {
      question: '长期压力大，对训练的影响是？',
      options: ['帮助恢复', '可能影响恢复与状态', '完全没关系'],
      answer: 1,
      explain: '压力大会影响睡眠和激素水平，恢复变慢，训练量可以适当调整 🧠'
    },
    {
      question: '吸烟对健身的影响是？',
      options: ['提升心肺', '影响心肺功能与恢复', '没有影响'],
      answer: 1,
      explain: '吸烟会影响心肺供氧和恢复能力，想练得好，戒烟是最划算的投资 🚭'
    },
    {
      question: '每天饮水量，常见的估算方式是？',
      options: ['每公斤体重 30~40 ml', '每天 200 ml', '越多越好'],
      answer: 0,
      explain: '按体重 30~40 ml/kg 估算比较实用，训练日和出汗多时要再增加 💧'
    },
    {
      question: '记录训练日志的主要好处是？',
      options: ['方便看到进步、安排加重', '显得专业', '没有用处'],
      answer: 0,
      explain: '记下重量和次数，才能知道有没有进步，下次该加多少一目了然 📓'
    },
    {
      question: '做动作时，幅度应该？',
      options: ['只做半程', '在可控范围内做完整幅度', '越大越猛越好'],
      answer: 1,
      explain: '完整幅度能让肌肉充分收缩拉伸，但要在关节舒服、可控的范围内 🔄'
    },
    {
      question: '器械训练和自由重量训练的关系是？',
      options: ['只能选一个', '各有优势，可以搭配', '器械完全没用'],
      answer: 1,
      explain: '器械稳定好学、自由重量更贴近日常发力，按阶段和动作搭配使用最好 🏋️'
    },
    {
      question: '固定器械比较适合？',
      options: ['新手学习发力', '完全替代所有训练', '只给专业选手'],
      answer: 0,
      explain: '固定器械轨迹稳定，新手更容易找到目标肌肉的发力感，是不错的起点 🎯'
    },
    {
      question: '出汗越多，减脂效果越好吗？',
      options: ['是，汗越多越瘦', '不是，出汗主要是散热', '完全没汗才有效'],
      answer: 1,
      explain: '出汗只是身体散热，和脂肪消耗不是一回事，别用暴汗服衡量效果 💦'
    },
    {
      question: '健康人适量吃高蛋白，会伤肾吗？',
      options: ['一定会', '健康人适量通常没问题', '越少越好'],
      answer: 1,
      explain: '健康人群适量高蛋白通常没有肾脏风险；已有肾病则需遵医嘱 🩺'
    },
    {
      question: '「局部塑形」比如只瘦手臂，存在吗？',
      options: ['存在', '不存在，脂肪是全身一起减的', '只练手臂就行'],
      answer: 1,
      explain: '脂肪消耗是全身性的，想瘦某个部位，还是得靠整体热量缺口 ⚖️'
    },
    {
      question: '体重越轻，身材就越好吗？',
      options: ['是', '不一定，体成分更重要', '越瘦越健康'],
      answer: 1,
      explain: '体重低但肌肉少、体脂高，体型未必好看。关注体成分比盯着体重更靠谱 📊'
    },
    {
      question: '只练腹肌，能减掉肚子上的脂肪吗？',
      options: ['能', '不能，需要整体热量缺口', '练得越多减得越快'],
      answer: 1,
      explain: '腹肌训练练的是肌肉，不消耗局部脂肪。想瘦肚子，饮食和整体消耗才是关键 🍽️'
    },
    {
      question: '想进步，必须每天都训练吗？',
      options: ['必须', '不需要，恢复同样重要', '休息会退步'],
      answer: 1,
      explain: '训练给刺激，休息才让身体变强。每周安排休息日，反而进步更稳 🛌'
    },
    {
      question: '训练计划需要定期调整吗？',
      options: ['不需要，一直不变', '需要，根据进步和状态调整', '每天都要大改'],
      answer: 1,
      explain: '身体会适应，计划也要跟着微调。每 4~8 周评估一次，进步才不会停 🔧'
    },
    {
      question: '对大多数人来说，健身最关键的是？',
      options: ['一次练到极限', '长期坚持', '买最贵的装备'],
      answer: 1,
      explain: '能坚持的计划才是好计划，稳稳练下去，比偶尔一次猛练有效得多 🌟'
    },
    {
      question: '训练后什么时候洗澡更合适？',
      options: ['立刻冲冷水', '稍作休息、心率平稳后', '练完不洗'],
      answer: 1,
      explain: '练完先缓几分钟，等呼吸和心率平稳再洗澡，身体会更舒服 🚿'
    },
    {
      question: '训练计划总是执行不下去时，比较有效的做法是？',
      options: ['直接放弃', '把目标拆小、先保证出勤', '一次加练到崩'],
      answer: 1,
      explain: '把目标拆小、先保证每周能去练，习惯建立起来后，强度和时长自然会跟上 🌟'
    }
  ];

  /** 答对时的简短肯定语，随机挑一句 */
  const QUIZ_PRAISES = [
    '答对啦，理解得很到位 👍',
    '漂亮，这题稳稳拿下 ✅',
    '就是这个思路，继续保持 ✨',
    '答对啦，健康知识满格 💪'
  ];

  /** 当前文章下标与日期标记（不持久化） */
  let scienceIndex = 0;
  let scienceInited = false;
  let scienceDayKey = '';

  /** 按当天日期生成文章下标，保证同一天固定展示同一篇 */
  function todayScienceIndex() {
    const now = new Date();
    const seed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    return seed % SCIENCE_ARTICLES.length;
  }

  /** 渲染今日科普文章；传 forceIndex 可指定文章 */
  function renderSciencePage(forceIndex) {
    const list = $('#today-article');
    const dateEl = $('#science-date');
    if (!list) return;
    if (!SCIENCE_ARTICLES.length) return;

    const now = new Date();
    const dayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();

    // 首次进入或跨天时，按日期种子重新选文
    if (!scienceInited || scienceDayKey !== dayKey) {
      scienceIndex = todayScienceIndex();
      scienceInited = true;
      scienceDayKey = dayKey;
    }
    if (typeof forceIndex === 'number') scienceIndex = forceIndex;

    const article = SCIENCE_ARTICLES[scienceIndex];

    if (dateEl) {
      dateEl.textContent = '今日科普 · ' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
    }

    list.innerHTML =
      '<article class="article-card">' +
        '<div class="article-head">' +
          '<span class="article-emoji">' + article.emoji + '</span>' +
          '<div class="article-title-group">' +
            '<h3>' + esc(article.title) + '</h3>' +
            '<span class="article-meta">' + esc(article.category) + ' · 预计阅读 ' +
              esc(article.minutes) + ' 分钟</span>' +
          '</div>' +
        '</div>' +
        '<ul class="article-points">' + article.points.map(function (text) {
          return '<li>' + esc(text) + '</li>';
        }).join('') + '</ul>' +
        '<p class="article-tip">💡 ' + esc(article.tip) + '</p>' +
      '</article>';

    renderQuiz();
  }

  /** 随机换一篇，避免与当前重复 */
  function shuffleArticle() {
    if (SCIENCE_ARTICLES.length < 2) return;

    let next = scienceIndex;
    while (next === scienceIndex) {
      next = Math.floor(Math.random() * SCIENCE_ARTICLES.length);
    }

    renderSciencePage(next);
    showToast('已换一篇 📖');
  }

  /** 小测试运行状态（不持久化） */
  const QUIZ_QUESTIONS_PER_ROUND = 3;
  let quizStep = 0;
  let quizAnswers = [];
  let quizSet = [];
  let quizInited = false;

  /** 初始化小测试：默认只显示引导卡片，不展示题目 */
  function renderQuiz() {
    if (quizInited) return;
    quizInited = true;
    resetQuizView();
  }

  /** 回到「未开始」的引导态 */
  function resetQuizView() {
    quizStep = 0;
    quizAnswers = [];
    quizSet = [];

    const intro = $('#quiz-intro');
    const area = $('#quiz-area');
    const result = $('#quiz-result');

    if (intro) intro.hidden = false;
    if (area) area.hidden = true;
    if (result) {
      result.hidden = true;
      result.innerHTML = '';
    }
  }

  /** 每次开始都从题库随机抽一套题，保证「每次题库不同」 */
  function pickQuizSet(count) {
    const pool = QUIZ_QUESTIONS.slice();
    const picked = [];
    const size = Math.min(count, pool.length);

    while (picked.length < size) {
      const index = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(index, 1)[0]);
    }
    return picked;
  }

  /** 点击「开始测试」：抽一套新题并进入第一题 */
  function startQuiz() {
    quizStep = 0;
    quizAnswers = [];
    quizSet = pickQuizSet(QUIZ_QUESTIONS_PER_ROUND);

    const intro = $('#quiz-intro');
    const area = $('#quiz-area');
    const result = $('#quiz-result');

    if (intro) intro.hidden = true;
    if (result) {
      result.hidden = true;
      result.innerHTML = '';
    }
    if (area) area.hidden = false;

    renderQuizStep();
  }

  /** 渲染当前这一题（未作答前不显示解析与按钮） */
  function renderQuizStep() {
    const root = $('#quiz-questions');
    const progress = $('#quiz-progress');
    const nextBtn = $('#quiz-next');
    const feedback = $('#quiz-feedback');
    if (!root) return;

    const item = quizSet[quizStep];
    if (!item) return;

    if (progress) {
      progress.textContent = '第 ' + (quizStep + 1) + ' / ' + quizSet.length + ' 题';
    }

    root.innerHTML =
      '<fieldset class="quiz-question">' +
        '<legend>' + esc(item.question) + '</legend>' +
        item.options.map(function (option, oIndex) {
          const id = 'quiz-' + quizStep + '-' + oIndex;
          return (
            '<label class="quiz-option" for="' + id + '">' +
              '<input type="radio" id="' + id + '" name="quiz-option" value="' + oIndex + '">' +
              '<span>' + esc(option) + '</span>' +
            '</label>'
          );
        }).join('') +
      '</fieldset>';

    if (feedback) {
      feedback.hidden = true;
      feedback.innerHTML = '';
      feedback.classList.remove('is-wrong');
    }

    if (nextBtn) {
      nextBtn.hidden = true;
      nextBtn.textContent = quizStep === quizSet.length - 1 ? '查看结果' : '下一题';
    }
  }

  /** 选中答案：立即判定并展示科普解析 */
  function handleQuizChoice(event) {
    const input = event.target.closest('input[name="quiz-option"]');
    if (!input) return;
    if (quizAnswers[quizStep] !== undefined) return;

    const item = quizSet[quizStep];
    const selected = Number(input.value);
    const isRight = selected === item.answer;
    quizAnswers[quizStep] = selected;

    // 锁定选项，并标出正确项与错选项
    $$('#quiz-questions input[name="quiz-option"]').forEach(function (radio) {
      radio.disabled = true;

      const label = radio.closest('.quiz-option');
      if (!label) return;

      if (Number(radio.value) === item.answer) label.classList.add('is-correct');
      if (Number(radio.value) === selected && !isRight) label.classList.add('is-wrong');
    });

    const feedback = $('#quiz-feedback');
    if (feedback) {
      feedback.hidden = false;
      feedback.classList.toggle('is-wrong', !isRight);
      feedback.innerHTML = isRight
        ? '<p class="feedback-title">✅ ' + esc(pickQuizPraise()) + '</p>' +
          '<p class="feedback-text">' + esc(item.explain) + '</p>'
        : '<p class="feedback-title">❌ 答错了，正确答案是「' +
            esc(item.options[item.answer]) + '」</p>' +
          '<p class="feedback-text">' + esc(item.explain) + '</p>';
    }

    const nextBtn = $('#quiz-next');
    if (nextBtn) nextBtn.hidden = false;
  }

  /** 随机挑一句答对肯定语 */
  function pickQuizPraise() {
    return QUIZ_PRAISES[Math.floor(Math.random() * QUIZ_PRAISES.length)];
  }

  /** 按得分生成评语 */
  function quizComment(correct, total) {
    if (correct === total) return '满分！基础健康知识掌握得很扎实 🎉';
    if (correct >= Math.ceil(total * 0.6)) return '不错！再复习一下今日科普就更稳了 💪';
    return '别灰心，从今天的科普文章开始补一补 📝';
  }

  /** 进入下一题；最后一题则结算 */
  function nextQuizStep() {
    if (quizAnswers[quizStep] === undefined) {
      showToast('先选一个答案哦 📝');
      return;
    }

    if (quizStep < quizSet.length - 1) {
      quizStep += 1;
      renderQuizStep();
      return;
    }

    finishQuiz();
  }

  /** 结算：得分 + 评语 + 错题复习 + 再来一次 */
  function finishQuiz() {
    const area = $('#quiz-area');
    const result = $('#quiz-result');
    if (area) area.hidden = true;
    if (!result) return;

    let correct = 0;
    const reviewItems = [];

    quizSet.forEach(function (item, index) {
      const chosen = quizAnswers[index];

      if (chosen === item.answer) {
        correct += 1;
        return;
      }

      reviewItems.push(
        '<li class="review-item">' +
          '<p class="review-question">' + esc(item.question) + '</p>' +
          '<p class="review-answer">你的答案：' +
            esc(chosen === undefined ? '未作答' : item.options[chosen]) +
            ' · 正确答案：' + esc(item.options[item.answer]) + '</p>' +
          '<p class="review-explain">💡 ' + esc(item.explain) + '</p>' +
        '</li>'
      );
    });

    const total = quizSet.length;
    const reviewHtml = reviewItems.length
      ? '<div class="quiz-review">' +
          '<h3>📚 错题复习</h3>' +
          '<ul class="review-list">' + reviewItems.join('') + '</ul>' +
        '</div>'
      : '<p class="quiz-perfect">全部答对，今天的健康知识满格！🎉</p>';

    result.hidden = false;
    result.innerHTML =
      '<p class="quiz-score">得分：' + correct + ' / ' + total + '</p>' +
      '<p class="quiz-comment">' + esc(quizComment(correct, total)) + '</p>' +
      reviewHtml +
      '<button type="button" class="btn-secondary" id="quiz-retry">🔁 再来一次</button>';
  }

  /* ============================ 健康科普 / 答疑 ============================ */

  /** 绑定科普页：换一篇、小测试与答疑表单 */
  function bindSciencePage() {
    const shuffle = $('#shuffle-article');
    if (shuffle) shuffle.addEventListener('click', shuffleArticle);

    const startBtn = $('#quiz-start');
    if (startBtn) startBtn.addEventListener('click', startQuiz);

    const nextBtn = $('#quiz-next');
    if (nextBtn) nextBtn.addEventListener('click', nextQuizStep);

    // 选项是动态渲染的，用事件委托在选中时立即显示解析
    const quizQuestions = $('#quiz-questions');
    if (quizQuestions) quizQuestions.addEventListener('change', handleQuizChoice);

    // 「再来一次」由结果区动态渲染，使用事件委托
    const resultBox = $('#quiz-result');
    if (resultBox) {
      resultBox.addEventListener('click', function (event) {
        if (event.target.closest('#quiz-retry')) startQuiz();
      });
    }

    bindQaForm('#qa-form');
  }

  /** 绑定答疑表单：首页与健康科普页共用同一套处理逻辑 */
  function bindQaForm(selector) {
    const form = $(selector);
    if (form) form.addEventListener('submit', handleAskCoach);
  }

  /**
   * 把最新的训练计划 / 饮食建议写回 state 并刷新页面。
   * 任一参数为 null 时沿用已有结果。
   */
  function updateCoachingPlans(trainingPlan, nutritionPlan) {
    const base = state.coaching || {
      planId: App.newId ? App.newId('plan') : 'qa_' + Date.now(),
      errors: [],
      elapsedMs: 0
    };

    state.coaching = Object.assign({}, base, {
      profile: state.profile,
      trainingPlan: trainingPlan || base.trainingPlan || null,
      nutritionPlan: nutritionPlan || base.nutritionPlan || null
    });

    persistState();
    renderCoachingResult(state.coaching);
    renderTrainingPage();
    // 答疑改写营养方案后，同步刷新饮食记录的目标对照
    renderDietDraft();
  }

  /** 兜底：直接调用训练计划 Agent 的 generatePlan */
  function regenerateTraining(profile) {
    if (typeof App.generatePlan === 'function') return App.generatePlan(profile);
    if (App.trainingAgent && typeof App.trainingAgent.generatePlan === 'function') {
      return App.trainingAgent.generatePlan(profile);
    }
    return null;
  }

  /** 兜底：直接调用营养饮食 Agent 的 generateDiet */
  function regenerateDiet(profile, plan) {
    if (typeof App.generateDiet === 'function') return App.generateDiet(profile, plan);
    if (App.dietAgent && typeof App.dietAgent.generateDiet === 'function') {
      return App.dietAgent.generateDiet(profile, plan);
    }
    return null;
  }

  /** 把答疑解析出的调整参数转成可读文案 */
  function describeAdjustments(adjustments) {
    if (!adjustments) return '';
    const parts = [];

    if (adjustments.injuries && adjustments.injuries.length) {
      parts.push('伤病 ' + adjustments.injuries.join('、'));
    }
    if (adjustments.equipment && adjustments.equipment.length) {
      parts.push('器械 ' + adjustments.equipment.map(function (key) {
        return App.EquipmentLabel && App.EquipmentLabel[key]
          ? App.EquipmentLabel[key]
          : key;
      }).join(' / '));
    }
    if (adjustments.daysPerWeek) {
      parts.push('每周 ' + adjustments.daysPerWeek + ' 天');
    }
    if (adjustments.goal) {
      parts.push('目标 ' + (App.GoalLabel && App.GoalLabel[adjustments.goal]
        ? App.GoalLabel[adjustments.goal]
        : adjustments.goal));
    }
    if (adjustments.dietVariety) parts.push('食谱多样化');
    if (adjustments.calorieAdjust) {
      parts.push('热量 ' + (adjustments.calorieAdjust > 0 ? '+' : '') +
        adjustments.calorieAdjust + ' kcal');
    }

    return parts.join('；');
  }

  /** 渲染答疑 Agent 的回复 */
  function renderQaAnswer(result) {
    const targetLabels = { training: '训练计划', diet: '饮食方案' };
    const targets = result.regenerateTargets || [];

    const adjustTag = describeAdjustTag(result.adjustments);
    const targetAgents = targets.map(function (key) {
      return key === 'diet' ? '营养饮食Agent' : '训练计划Agent';
    }).join('、');

    const traceHtml = targets.length
      ? '<div class="agent-trace-inline">' +
          '<span class="agent-trace-emoji">🎯</span>' +
          '<b>答疑调整Agent</b>：识别到「' + esc(adjustTag) + '」需求 → 已通知' +
          esc(targetAgents) + '重新生成' +
        '</div>'
      : '';

    const extra = targets.length
      ? '<p class="hint">🔄 已触发重新生成：' + esc(targets.map(function (key) {
          return targetLabels[key] || key;
        }).join('、')) + '</p>'
      : '<p class="hint">💡 本次只做解答，未触发重新生成。</p>';

    const applied = describeAdjustments(result.adjustments);
    const appliedHtml = applied
      ? '<p class="hint">调整已回写到用户信息：' + esc(applied) + '</p>'
      : '';

    return (
      '<div class="qa-result">' +
        '<span class="tag">💬 QaAgent · ' + esc(result.intentLabel || result.intent) + '</span>' +
        traceHtml +
        '<p>' + esc(result.answer || result.reply || '') + '</p>' +
        appliedHtml +
        extra +
      '</div>'
    );
  }

  async function handleAskCoach(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const input = form.querySelector('textarea');
    const answerId = form.getAttribute('data-answer') || 'qa-answer';
    const root = document.getElementById(answerId);

    if (!input || !root) return;

    const question = input.value.trim();
    if (!question) {
      showToast('请先输入问题');
      return;
    }

    if (typeof App.answerQuery !== 'function') {
      showToast('answerQuery 未加载，请检查 agents/qaAgent.js');
      return;
    }

    root.innerHTML = '<div class="skeleton w80"></div><div class="skeleton w60"></div>';

    const currentPlan = state.coaching ? state.coaching.trainingPlan : null;
    const currentDiet = state.coaching ? state.coaching.nutritionPlan : null;

    try {
      // ① 交给答疑 Agent：识别意图 + 解析调整参数 + 必要时重生成
      const result = await App.answerQuery(
        question,
        state.profile || {},
        currentPlan,
        currentDiet
      );

      // ② 回写用户信息：伤病 / 器械 / 天数等调整必须落到档案里，
      //    否则重新生成的计划不会真正变化
      if (result.updated && result.updated.profile) {
        state.profile = App.normalizeUserProfile(result.updated.profile);
        fillFormFromState();
      }

      // ③ 按意图刷新方案
      if (result.intent === 'training') {
        const trainingPlan = result.updatedPlan || regenerateTraining(state.profile || {});
        const nutritionPlan = result.updatedDiet ||
          regenerateDiet(state.profile || {}, trainingPlan);
        updateCoachingPlans(trainingPlan, nutritionPlan);
      } else if (result.intent === 'diet') {
        const nutritionPlan = result.updatedDiet ||
          regenerateDiet(state.profile || {}, currentPlan);
        updateCoachingPlans(null, nutritionPlan);
      } else {
        // 询问：只保存可能回写的档案，不刷新方案
        persistState();
      }

      // ④ 显示 Agent 回复
      root.innerHTML = renderQaAnswer(result);
    } catch (error) {
      console.error('[main] answerQuery 调用失败', error);
      root.innerHTML = '<div class="alert">答疑失败：' +
        esc(error && error.message ? error.message : error) + '</div>';
    }
  }

  /* ============================ 启动 ============================ */

  function renderAll() {
    if (state.coaching) renderCoachingResult(state.coaching);
    renderTrainingPage();
    renderPlanGuides();
    renderHomeState();
    renderPageTags();
    updateUserEntry();
    renderReviewComplete();
    renderCheckinEntry();
    renderCheckinHistory();

    loadDietDraftFromState();
    renderDietDraft();
    renderDietHistory();
    renderSciencePage();
    state.lastReview = buildReviewReport();
    renderReviewReport(state.lastReview);
    renderCalendar();
  }

  function init() {
    const agentKeys = App.AGENT_KEYS || [];
    const missing = agentKeys.filter(function (key) {
      return typeof App[key] !== 'function';
    });

    if (!agentKeys.length || missing.length) {
      console.error('[main] Agent 未注册：', missing);
      showToast('Agent 加载失败：' + (missing.length ? missing.join('、') : '契约文件未加载'));
      return;
    }

    migrateLegacyState();
    restoreState();
    bindTabs();
    bindGlobalActions();
    bindHome();
    bindTrainingPage();
    bindReviewPage();
    bindDietPage();
    bindSciencePage();
    bindIntro();
    bindUserModal();
    bindTrainingCompleteModal();
    bindSafetyModal();
    bindProfileEditor();

    fillFormFromState();
    applyRoute();
    renderAll();
    maybeShowIntro();
  }

  document.addEventListener('DOMContentLoaded', init);
})();