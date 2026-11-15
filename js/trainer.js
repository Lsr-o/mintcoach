/**
 * ============================================================================
 * js/trainer.js —— 今日训练流程编排（Trainer）
 * ----------------------------------------------------------------------------
 * 职责：
 *   把今日训练计划拆成「动作 → 组 → 次」的执行序列，串联：
 *   语音播报 → 姿势评测自动计数 → 组完成 → 20 秒休息 → 下一组 →
 *   自动切换下一个动作 → 全部完成 → 写入打卡复盘。
 *
 * 依赖注入（由 main.js 提供）：
 *   getDetector()  返回姿势检测实例（需支持 setExercise）
 *   speak(text)    中文语音播报
 *   onChange(state) 渲染进度
 *   onComplete()   全部完成后的落盘回调
 *
 * 用法：
 *   const trainer = Trainer.create({ getDetector, speak, onChange, onComplete });
 *   trainer.start(dayPlan);
 *   trainer.handleReps(count, unit);   // 姿势检测 onReps 转发
 *   trainer.completeCurrentSet();      // 手动完成本组
 *   trainer.stop();
 * ============================================================================
 */
(function (global) {
  'use strict';

  /** 组间休息秒数（需求固定 20 秒） */
  const REST_SECONDS = 20;

  /** 每完成 5 次随机播报的鼓励语 */
  const ENCOURAGEMENTS = ['做得很好', '动作很标准', '加油，继续保持', '稳住节奏'];

  /** 随机取一条鼓励语 */
  function pickEncouragement() {
    return ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)];
  }

  /**
   * 计划动作名 → 姿势评测动作 id。
   * 顺序敏感：先匹配弓步/分腿蹲，避免被“蹲”抢先。
   */
  const EXERCISE_PATTERNS = [
    { id: 'lunge', regex: /弓步|箭步|分腿蹲/ },
    { id: 'squat', regex: /深蹲|蹲/ },
    { id: 'pushup', regex: /俯卧撑|卧推|推胸/ },
    { id: 'jumping_jack', regex: /开合跳/ },
    { id: 'plank', regex: /平板支撑|侧平板|平板/ },
    { id: 'biceps_curl', regex: /弯举/ },
    { id: 'lateral_raise', regex: /侧平举/ },
    { id: 'shoulder_press', regex: /推举|肩推/ },
    { id: 'high_knees', regex: /高抬腿|提膝/ }
  ];

  /** 名字像弯举、但不是手臂弯举的动作，不映射 */
  const EXCLUDE_PATTERNS = /腿弯举|腿屈伸/;

  /** 动作名 → 姿势 id，无匹配返回 null（走手动完成） */
  function mapExercise(name) {
    const text = String(name || '').trim();
    if (!text || EXCLUDE_PATTERNS.test(text)) return null;

    for (let i = 0; i < EXERCISE_PATTERNS.length; i += 1) {
      if (EXERCISE_PATTERNS[i].regex.test(text)) return EXERCISE_PATTERNS[i].id;
    }
    return null;
  }

  /**
   * 解析计划里的次数 / 秒数：
   *   "8-12" → 目标 12 次；"每侧 10" → 10 次；"40 秒" → 40 秒；
   *   "25 分钟"（有氧）→ 手动完成。
   */
  function parseReps(reps) {
    const text = String(reps || '').trim();

    const seconds = text.match(/(\d+)\s*秒/);
    if (seconds) {
      return { target: Number(seconds[1]), unit: '秒', text: seconds[1] + '秒', manual: false };
    }

    if (/分钟/.test(text)) {
      return { target: 0, unit: '次', text: text, manual: true };
    }

    const numbers = (text.match(/\d+/g) || []).map(Number);
    if (!numbers.length) {
      return { target: 10, unit: '次', text: '10次', manual: false };
    }

    return {
      target: Math.max.apply(null, numbers),
      unit: '次',
      text: text,
      manual: false
    };
  }

  function create(options) {
    const getDetector = typeof options.getDetector === 'function'
      ? options.getDetector
      : function () { return null; };
    const speak = typeof options.speak === 'function' ? options.speak : function () {};
    const onChange = typeof options.onChange === 'function' ? options.onChange : function () {};
    const onComplete = typeof options.onComplete === 'function' ? options.onComplete : function () {};

    let state = null;
    let restTimer = null;
    const pendingTimers = [];

    function currentExercise() {
      if (!state) return null;
      return state.exercises[state.index] || null;
    }

    /** 可取消的延时任务，停止训练时统一清除 */
    function later(callback, delay) {
      const id = global.setTimeout(function () {
        const index = pendingTimers.indexOf(id);
        if (index >= 0) pendingTimers.splice(index, 1);
        if (state) callback();
      }, delay);
      pendingTimers.push(id);
      return id;
    }

    function clearPendingTimers() {
      pendingTimers.forEach(function (id) {
        global.clearTimeout(id);
      });
      pendingTimers.length = 0;
    }

    function notify() {
      if (!state) {
        onChange({ phase: 'idle', auto: false });
        return;
      }

      const exercise = currentExercise();
      onChange({
        phase: state.phase,
        exerciseName: exercise ? exercise.name : '',
        exerciseIndex: state.index,
        exerciseTotal: state.exercises.length,
        setIndex: state.setIndex,
        setTotal: exercise ? exercise.sets : 0,
        reps: state.reps,
        targetReps: exercise ? exercise.targetReps : 0,
        unit: exercise ? exercise.unit : '次',
        restRemaining: state.restRemaining,
        auto: Boolean(exercise && exercise.auto)
      });
    }

    /** 播报动作与组数次数，例如：下一个动作：深蹲，4组，每组12次 */
    function announceExercise() {
      const exercise = currentExercise();
      if (!exercise) return;

      const rawReps = exercise.repsText || String(exercise.targetReps);
      // 计划里写“12”时补上单位，读作“每组12次”
      const repsText = /次|秒|分钟/.test(rawReps) ? rawReps : rawReps + exercise.unit;
      speak('下一个动作：' + exercise.name + '，' + exercise.sets + '组，每组' +
        repsText + '，准备开始', 'normal');

      // 进入最后一个动作时额外提示
      if (state.index === state.exercises.length - 1) {
        later(function () {
          speak('最后一个动作，冲刺！', 'normal');
        }, 2200);
      }

      later(function () {
        speak('开始第1组', 'normal');
      }, 1600);
    }

    function beginExercise() {
      const exercise = currentExercise();
      if (!exercise) {
        finish();
        return;
      }

      state.setIndex = 0;
      state.reps = 0;
      state.restRemaining = 0;

      // 动作库没有对应动作 → 语音提示并自动跳过
      if (!exercise.postureId) {
        exercise.skipped = true;
        state.phase = 'transition';
        speak('该动作暂不支持自动评测', 'normal');
        notify();

        later(function () {
          if (!state) return;
          state.index += 1;
          if (state.index >= state.exercises.length) {
            finish();
          } else {
            beginExercise();
          }
        }, 1800);
        return;
      }

      state.phase = 'work';

      const detector = getDetector();
      if (detector) detector.setExercise(exercise.postureId);

      announceExercise();
      notify();
    }

    /** 汇总本次训练完成情况，写入本地存储供打卡复盘使用 */
    function buildSummary() {
      return {
        startedAt: state.startedAt,
        finishedAt: new Date().toISOString(),
        exercises: state.exercises.map(function (item) {
          return {
            name: item.name,
            sets: item.sets,
            targetReps: item.targetReps,
            unit: item.unit,
            completedSets: item.completedSets,
            completedReps: item.completedReps,
            skipped: item.skipped
          };
        })
      };
    }

    function finish() {
      if (!state) return;

      state.phase = 'finished';
      speak('今日训练全部完成，太棒了！', 'normal');
      notify();
      onComplete(buildSummary());
    }

    function startRest(seconds) {
      state.phase = 'rest';
      state.restRemaining = seconds;
      notify();

      if (restTimer) global.clearInterval(restTimer);
      restTimer = global.setInterval(function () {
        if (!state) return;

        state.restRemaining -= 1;

        if (state.restRemaining <= 0) {
          global.clearInterval(restTimer);
          restTimer = null;

          const exercise = currentExercise();
          state.phase = 'work';
          state.reps = 0;

          // 重新设置同一动作，重置姿势评测的计数状态
          const detector = getDetector();
          if (detector && exercise && exercise.postureId) {
            detector.setExercise(exercise.postureId);
          }

          speak('休息结束，开始第' + (state.setIndex + 1) + '组', 'normal');
          notify();
          return;
        }

        if (state.restRemaining === 10) {
          speak('还剩10秒', 'normal');
        } else if (state.restRemaining <= 3 && state.restRemaining > 0) {
          // 最后 3 秒逐秒倒计时：3、2、1
          speak(String(state.restRemaining), 'normal');
        }
        notify();
      }, 1000);
    }

    /** 完成当前组：组内还有剩余组则休息，否则切换下一个动作 */
    function completeSet() {
      if (!state || state.phase !== 'work') return;

      const exercise = currentExercise();
      if (!exercise) return;

      const completedSets = state.setIndex + 1;
      const totalSets = exercise.sets;

      // 取出本组累计的“每 5 次鼓励”，放到组间歇播报
      const pendingEncouragement = state.pendingEncouragement;
      state.pendingEncouragement = null;

      // 记录本组完成情况：手动完成时按目标次数计入
      exercise.completedSets = completedSets;
      exercise.completedReps += Math.max(state.reps, exercise.targetReps);

      // 本动作全部完成 → 自动切下一个动作
      if (completedSets >= totalSets) {
        speak(exercise.name + '完成', 'normal');

        if (pendingEncouragement) {
          later(function () { speak(pendingEncouragement, 'low'); }, 900);
        }

        state.index += 1;

        if (state.index >= state.exercises.length) {
          finish();
          return;
        }

        beginExercise();
        return;
      }

      const remaining = totalSets - completedSets;
      speak('第' + completedSets + '组完成，还剩' + remaining + '组', 'normal');

      // 穿插鼓励：动作过半提示坚持；否则优先使用本组的每 5 次鼓励
      if (completedSets === Math.ceil(totalSets / 2)) {
        later(function () { speak('已完成一半，坚持住', 'low'); }, 1200);
      } else if (pendingEncouragement) {
        later(function () { speak(pendingEncouragement, 'low'); }, 1000);
      } else {
        later(function () { speak('做得很好', 'low'); }, 1000);
      }

      state.setIndex = completedSets;
      state.reps = 0;
      startRest(REST_SECONDS);
    }

    /** 姿势检测计数回调：实时计数 + 报数 + 达标判定 */
    function handleReps(count, unit) {
      if (!state || state.phase !== 'work') return;

      const exercise = currentExercise();
      if (!exercise || !exercise.auto) return;

      const value = Number(count) || 0;
      if (value === state.reps) return;

      state.reps = value;

      // 报数已由姿势检测的计数源头统一播报（自由 / 计划模式一致），
      // 这里只负责推进训练状态与记录鼓励语时机，避免重复播报。
      if (exercise.unit === '次' && value > 0 && value % 5 === 0) {
        // 每 5 次记录一条鼓励，放到组间歇播报，避免打断报数
        state.pendingEncouragement = pickEncouragement();
      }

      if (exercise.targetReps > 0 && value >= exercise.targetReps) {
        completeSet();
        return;
      }

      notify();
    }

    function start(dayPlan) {
      stop();

      const exercises = dayPlan && Array.isArray(dayPlan.exercises)
        ? dayPlan.exercises
        : [];

      if (!dayPlan || dayPlan.isRest || !exercises.length) {
        return { ok: false, message: '今天是休息日或暂无训练动作。' };
      }

      state = {
        exercises: exercises.map(function (item) {
          const prescription = parseReps(item.reps);
          const postureId = prescription.manual ? null : mapExercise(item.name);

          return {
            name: String(item.name || '训练动作'),
            // 计划没写组数时默认 3 组；次数由 parseReps 默认 10 次
            sets: Math.max(1, Number(item.sets) || 3),
            targetReps: prescription.target || 10,
            unit: prescription.unit,
            repsText: String(item.reps || prescription.text || ''),
            postureId: postureId,
            auto: Boolean(postureId) && !prescription.manual,
            completedSets: 0,
            completedReps: 0,
            skipped: false
          };
        }),
        index: 0,
        setIndex: 0,
        reps: 0,
        phase: 'work',
        restRemaining: 0,
        pendingEncouragement: null,
        startedAt: new Date().toISOString()
      };

      beginExercise();
      return { ok: true };
    }

    function stop() {
      if (restTimer) {
        global.clearInterval(restTimer);
        restTimer = null;
      }
      clearPendingTimers();

      // 统一走姿势评测 Agent 的语音管理器，保证语音状态一致
      if (global.PostureDetector &&
          typeof global.PostureDetector.cancelSpeech === 'function') {
        global.PostureDetector.cancelSpeech();
      } else if ('speechSynthesis' in global) {
        try {
          global.speechSynthesis.cancel();
        } catch (error) {
          console.warn('[trainer] 取消语音失败', error);
        }
      }

      const wasRunning = Boolean(state);
      state = null;
      if (wasRunning) onChange({ phase: 'idle', auto: false });
    }

    function completeCurrentSet() {
      completeSet();
    }

    function getState() {
      if (!state) return { phase: 'idle' };

      const exercise = currentExercise();
      return {
        phase: state.phase,
        exerciseName: exercise ? exercise.name : '',
        exerciseIndex: state.index,
        exerciseTotal: state.exercises.length,
        setIndex: state.setIndex,
        setTotal: exercise ? exercise.sets : 0,
        reps: state.reps,
        targetReps: exercise ? exercise.targetReps : 0,
        unit: exercise ? exercise.unit : '次',
        restRemaining: state.restRemaining,
        auto: Boolean(exercise && exercise.auto)
      };
    }

    return {
      start: start,
      stop: stop,
      handleReps: handleReps,
      completeCurrentSet: completeCurrentSet,
      getState: getState,
      isRunning: function () {
        return Boolean(state) && state.phase !== 'finished';
      }
    };
  }

  global.Trainer = {
    create: create,
    mapExercise: mapExercise,
    parseReps: parseReps,
    REST_SECONDS: REST_SECONDS
  };
})(window);