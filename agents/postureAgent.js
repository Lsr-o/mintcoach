/**
 * ============================================================================
 * agents/postureAgent.js —— 姿势评测 Agent（实时摄像头）
 * ----------------------------------------------------------------------------
 * 职责：
 *   通过摄像头做实时姿势评测，统计动作次数，并通过语音纠正动作问题。
 *
 * 输入：
 *   @param {UserProfile} profile 用户档案
 *   @param {Object} [options] { exercise: 'squat' | 'pushup' | 'lunge' | 'plank' }
 *
 * 输出：
 *   @returns {Promise<PostureSession>} 实时会话对象（不是一次性结果）
 *
 * 会话对象约定（接口稳定，后续填充内部实现）：
 *   session.on('rep' | 'feedback' | 'error', handler) 订阅事件，返回取消订阅函数
 *   session.start()    -> Promise<{ ok, reason?, message? }>
 *   session.stop()     -> Promise<void>
 *   session.getStats() -> { reps, score, issues }
 *
 * 当前状态：全部为占位实现，capabilities 四项能力均为 false。
 * TODO：1. getUserMedia 获取摄像头
 *       2. MediaPipe / TensorFlow Pose 关键点检测
 *       3. 动作状态机计数
 *       4. SpeechSynthesis 语音纠正
 * ============================================================================
 */
(function (global) {
  'use strict';

  const App = (global.FitnessApp = global.FitnessApp || {});

  /** 支持的动作 key，后续可扩展到动作库全量 */
  const SUPPORTED_EXERCISES = ['squat', 'pushup', 'lunge', 'plank'];

  const EXERCISE_LABELS = {
    squat: '深蹲',
    pushup: '俯卧撑',
    lunge: '弓步蹲',
    plank: '平板支撑'
  };

  /**
   * 姿势评测 Agent 主入口：创建一次实时评测会话。
   *
   * @param {UserProfile} profile 用户档案
   * @param {Object} [options] { exercise }
   * @returns {Promise<PostureSession>}
   */
  async function postureAgent(profile, options = {}) {
    const user = App.normalizeUserProfile(profile);
    const exercise = SUPPORTED_EXERCISES.includes(options.exercise)
      ? options.exercise
      : 'squat';

    /** 事件订阅表：rep / feedback / error */
    const listeners = Object.create(null);

    const session = {
      id: App.newId('posture'),
      exercise: exercise,
      exerciseLabel: EXERCISE_LABELS[exercise],
      profile: user,
      status: 'idle',
      capabilities: {
        camera: false,
        poseDetection: false,
        repCounting: false,
        voiceCoaching: false
      },

      /**
       * 订阅会话事件。
       * @param {'rep'|'feedback'|'error'} event
       * @param {Function} handler
       * @returns {Function} 取消订阅
       */
      on(event, handler) {
        if (typeof handler !== 'function') return function noop() {};
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(handler);
        return function unsubscribe() {
          listeners[event] = listeners[event].filter((item) => item !== handler);
        };
      },

      /**
       * 启动实时评测（占位）。
       * 正式实现流程：申请摄像头 → 加载姿态模型 → 启动渲染循环 → 开始计数与播报。
       */
      async start() {
        // TODO：接入真实摄像头与姿态识别
        session.status = 'unavailable';
        return {
          ok: false,
          reason: 'posture_agent_not_implemented',
          message: '姿势评测 Agent 尚未接入摄像头与骨架识别，当前仅为接口占位。'
        };
      },

      /** 停止评测并释放摄像头（占位） */
      async stop() {
        // TODO：停止渲染循环、关闭 MediaStream、释放模型
        session.status = 'idle';
      },

      /** 读取实时统计（占位） */
      getStats() {
        return { reps: 0, score: 0, issues: [] };
      },

      _meta: App.createMeta('postureAgent')
    };

    return session;
  }

  /**
   * 预留接口：单帧姿势评测。
   * 后续可在渲染循环中逐帧调用，返回本次是否有计数、问题与纠正话术。
   *
   * @param {Object} frame 视频帧或关键点数据
   * @param {PostureSession} session 当前会话
   * @returns {Promise<{repDetected:boolean, reps:number, score:number, issues:string[], feedback:string}>}
   */
  postureAgent.evaluateFrame = async function evaluateFrame(frame, session) {
    // TODO：关键点角度计算 + 动作阶段判断 + 计数 + 生成纠正话术
    return {
      repDetected: false,
      reps: 0,
      score: 0,
      issues: [],
      feedback: '逐帧评测接口已预留，识别能力尚未接入。'
    };
  };

  /**
   * 预留接口：语音纠正播报。
   * @param {string} text 播报内容
   * @returns {Promise<boolean>} 是否成功播报
   */
  postureAgent.speak = async function speak(text) {
    // TODO：使用 SpeechSynthesis / 云端 TTS 播报
    return false;
  };

  postureAgent.SUPPORTED_EXERCISES = SUPPORTED_EXERCISES;
  postureAgent.EXERCISE_LABELS = EXERCISE_LABELS;

  App.postureAgent = postureAgent;
})(window);