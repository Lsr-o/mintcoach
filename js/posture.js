/**
 * ============================================================================
 * js/posture.js —— 姿势评测 Agent：多动作关键点检测 + 通用计数状态机
 * ----------------------------------------------------------------------------
 * 依赖（index.html <head> 通过 CDN 引入）：
 *   window.Pose    @mediapipe/pose
 *   window.Camera  @mediapipe/camera_utils
 *
 * 能力：
 *   1. 摄像头实时检测 33 个人体关键点，绘制骨架
 *   2. 5 个动作配置：深蹲 / 俯卧撑 / 弓步蹲 / 开合跳 / 平板支撑
 *   3. 通用状态机计数（角度类、距离类），平板支撑为计时模式
 *   4. 姿势纠正：弹窗（带正确姿势 SVG）+ 中文语音播报
 *   5. 动作切换时重置计数、弹窗与语音
 *
 * 动作配置字段：
 *   { id, name, mode, points, startAngle, bottomAngle, correctAngle,
 *     correctHint, hint, linePoints, lineHint, svg, ... }
 *
 * 用法：
 *   const detector = PostureDetector.create({
 *     video, canvas,
 *     alertRoot, alertText, alertSvg, alertClose,
 *     onStatus, onCount, onReps
 *   });
 *   await detector.start();
 *   detector.setExercise('pushup');
 *   await detector.stop();
 * ============================================================================
 */
(function (global) {
  'use strict';

  /** MediaPipe Pose 标准骨架连线（33 点索引） */
  const POSE_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 7],
    [0, 4], [4, 5], [5, 6], [6, 8],
    [9, 10],
    [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21],
    [17, 19],
    [12, 14], [14, 16], [16, 18], [16, 20], [16, 22],
    [18, 20],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [24, 26], [25, 27], [26, 28],
    [27, 29], [28, 30], [29, 31], [30, 32],
    [27, 31], [28, 32]
  ];

  const VISIBILITY_THRESHOLD = 0.5;
  const MODEL_BASE_URL = 'libs/mediapipe/';

  /** 同一类纠正的最短间隔，避免每帧重复弹窗 */
  const CORRECTION_COOLDOWN = 4000;
  /** 每次计数后的锁定期，防止抖动重复计数（500ms，动作太快也能过滤抖动） */
  const REP_LOCK_MS = 500;
  /**
   * 站立基线校准帧数：角度类动作取开始后前若干帧的最大角度作为"站直"参考。
   * 不同机位 / 拍摄角度下，站直时的膝角并不总是 170°+（正面拍摄往往只有 130°~150°），
   * 写死 150° 会导致"还站着就被判定为下蹲"，从而一直提示动作不标准且无法计数。
   */
  const BASE_CALIBRATION_FRAMES = 30;
  /** 累计纠正次数（按动作 id），供复盘统计「高频易错姿势」 */
  const correctionTotals = {};
  /**
   * 一次有效动作的最小下蹲幅度（相对站立基线的角度下降）。
   * 深度不足但幅度达到该值，仍然计数——否则柔韧性一般或机位偏差的用户
   * 永远蹲不到"标准深度"，会出现"只有纠正提示、没有报数"的情况。
   */
  const MIN_VALID_STROKE = 55;
  /** 纠正弹窗自动收起时间（约 5 秒，够动画播完整循环） */
  const ALERT_DURATION = 5200;

  /** 统一包裹火柴人 SVG */
  function svgFigure(content) {
    return (
      '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g fill="none" stroke="currentColor" stroke-width="4" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          content +
        '</g>' +
      '</svg>'
    );
  }

  /**
   * 动作库。
   * points：参与计算的关键点。角度动作为 [髋/肩, 膝/肘, 踝/腕]；
   *         开合跳为双腕 [15, 16]；平板支撑用 [肩, 髋, 踝] 做直线检测。
   */
  const EXERCISES = [
    {
      id: 'squat',
      name: '深蹲',
      mode: 'angle',
      points: [23, 25, 27],
      startAngle: 150,
      bottomAngle: 90,
      correctAngle: 100,
      correctHint: '再蹲深一点',
      hint: '站立 → 蹲下 → 站起',
      linePoints: null,
      svg: svgFigure(
        '<circle cx="52" cy="24" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="52" y1="34" x2="58" y2="62"/>' +
        '<line x1="58" y1="62" x2="36" y2="74"/>' +
        '<line x1="36" y1="74" x2="42" y2="104"/>' +
        '<line x1="42" y1="104" x2="58" y2="104"/>' +
        '<line x1="58" y1="62" x2="82" y2="72"/>' +
        '<line x1="82" y1="72" x2="84" y2="104"/>' +
        '<line x1="84" y1="104" x2="100" y2="104"/>' +
        '<line x1="52" y1="44" x2="82" y2="48"/>' +
        '<line x1="82" y1="48" x2="94" y2="38"/>'
      )
    },
    {
      id: 'pushup',
      name: '俯卧撑',
      mode: 'angle',
      points: [11, 13, 15],
      startAngle: 160,
      bottomAngle: 90,
      correctAngle: 100,
      correctHint: '再下去一点',
      hint: '侧对摄像头 · 伸直手臂 → 弯曲 → 推起',
      linePoints: [11, 23, 27],
      lineHint: '核心收紧，身体保持直线',
      lineThreshold: 15,
      svg: svgFigure(
        '<circle cx="22" cy="54" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="30" y1="58" x2="76" y2="68"/>' +
        '<line x1="76" y1="68" x2="102" y2="82"/>' +
        '<line x1="102" y1="82" x2="112" y2="86"/>' +
        '<line x1="34" y1="60" x2="42" y2="84"/>' +
        '<line x1="42" y1="84" x2="34" y2="102"/>' +
        '<line x1="28" y1="62" x2="36" y2="86"/>' +
        '<line x1="36" y1="86" x2="28" y2="102"/>'
      )
    },
    {
      id: 'lunge',
      name: '弓步蹲',
      mode: 'angle',
      points: [23, 25, 27],
      startAngle: 150,
      bottomAngle: 90,
      correctAngle: 100,
      correctHint: '弓步再蹲深一点，后膝接近地面',
      hint: '侧对摄像头 · 站立 → 下蹲 → 站起',
      linePoints: null,
      svg: svgFigure(
        '<circle cx="48" cy="24" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="48" y1="34" x2="52" y2="60"/>' +
        '<line x1="52" y1="60" x2="34" y2="76"/>' +
        '<line x1="34" y1="76" x2="34" y2="104"/>' +
        '<line x1="34" y1="104" x2="50" y2="104"/>' +
        '<line x1="52" y1="60" x2="78" y2="82"/>' +
        '<line x1="78" y1="82" x2="102" y2="96"/>' +
        '<line x1="102" y1="96" x2="112" y2="100"/>' +
        '<line x1="48" y1="42" x2="70" y2="54"/>'
      )
    },
    {
      id: 'jumping_jack',
      name: '开合跳',
      mode: 'distance',
      points: [15, 16],
      startAngle: null,
      bottomAngle: null,
      correctAngle: null,
      closedMax: 0.32,
      openMin: 0.5,
      correctHint: '手臂举高，动作幅度大一点',
      hint: '双手体侧 → 举过头顶 → 放下',
      linePoints: null,
      svg: svgFigure(
        '<circle cx="60" cy="24" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="60" y1="34" x2="60" y2="66"/>' +
        '<line x1="60" y1="44" x2="38" y2="20"/>' +
        '<line x1="60" y1="44" x2="82" y2="20"/>' +
        '<line x1="60" y1="66" x2="44" y2="98"/>' +
        '<line x1="44" y1="98" x2="30" y2="108"/>' +
        '<line x1="60" y1="66" x2="76" y2="98"/>' +
        '<line x1="76" y1="98" x2="90" y2="108"/>'
      )
    },
    {
      id: 'plank',
      name: '平板支撑',
      mode: 'hold',
      points: [11, 23, 27],
      startAngle: null,
      bottomAngle: null,
      correctAngle: null,
      correctHint: '臀部下沉了，收紧核心',
      hint: '肘部支撑 · 肩、髋、踝保持一条直线',
      linePoints: [11, 23, 27],
      lineThreshold: 15,
      announceInterval: 10,
      svg: svgFigure(
        '<circle cx="24" cy="54" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="32" y1="58" x2="84" y2="62"/>' +
        '<line x1="84" y1="62" x2="108" y2="70"/>' +
        '<line x1="108" y1="70" x2="116" y2="74"/>' +
        '<line x1="34" y1="60" x2="38" y2="88"/>' +
        '<line x1="38" y1="88" x2="26" y2="92"/>'
      )
    },
    {
      id: 'biceps_curl',
      name: '哑铃弯举',
      mode: 'angle',
      points: [11, 13, 15],
      startAngle: 160,
      bottomAngle: 60,
      correctAngle: 90,
      correctHint: '弯举到位，小臂贴近大臂',
      hint: '侧对摄像头 · 手臂伸直 → 弯举 → 放下',
      linePoints: null,
      svg: svgFigure(
        '<circle cx="46" cy="24" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="46" y1="34" x2="50" y2="62"/>' +
        '<line x1="50" y1="62" x2="36" y2="104"/>' +
        '<line x1="50" y1="62" x2="66" y2="104"/>' +
        '<line x1="50" y1="44" x2="64" y2="60"/>' +
        '<line x1="64" y1="60" x2="54" y2="42"/>' +
        '<line x1="46" y1="42" x2="62" y2="42"/>' +
        '<rect x="42" y="37" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>' +
        '<rect x="61" y="37" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>'
      )
    },
    {
      id: 'shoulder_press',
      name: '哑铃肩上推举',
      mode: 'angle',
      inverted: true,
      points: [11, 13, 15],
      startAngle: 100,
      bottomAngle: 160,
      correctAngle: 150,
      correctHint: '手臂向上完全伸直',
      hint: '双手置于肩部 → 向上推举 → 收回',
      linePoints: null,
      svg: svgFigure(
        '<circle cx="60" cy="30" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="60" y1="40" x2="60" y2="70"/>' +
        '<line x1="60" y1="70" x2="46" y2="104"/>' +
        '<line x1="60" y1="70" x2="74" y2="104"/>' +
        '<line x1="60" y1="46" x2="44" y2="30"/>' +
        '<line x1="44" y1="30" x2="40" y2="14"/>' +
        '<line x1="60" y1="46" x2="76" y2="30"/>' +
        '<line x1="76" y1="30" x2="80" y2="14"/>' +
        '<line x1="32" y1="14" x2="48" y2="14"/>' +
        '<rect x="28" y="9" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>' +
        '<rect x="47" y="9" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>' +
        '<line x1="72" y1="14" x2="88" y2="14"/>' +
        '<rect x="68" y="9" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>' +
        '<rect x="87" y="9" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>'
      )
    },
    {
      id: 'lateral_raise',
      name: '哑铃侧平举',
      mode: 'height',
      points: [11, 15],
      startAngle: null,
      bottomAngle: null,
      correctAngle: null,
      downThreshold: 0.18,
      upThreshold: 0.05,
      correctThreshold: 0.1,
      correctHint: '抬到与肩同高，别耸肩',
      hint: '手臂下垂 → 侧平举至肩高 → 放下',
      linePoints: null,
      svg: svgFigure(
        '<circle cx="60" cy="26" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="60" y1="36" x2="60" y2="70"/>' +
        '<line x1="60" y1="70" x2="48" y2="104"/>' +
        '<line x1="60" y1="70" x2="72" y2="104"/>' +
        '<line x1="60" y1="46" x2="38" y2="46"/>' +
        '<line x1="38" y1="46" x2="18" y2="46"/>' +
        '<line x1="60" y1="46" x2="82" y2="46"/>' +
        '<line x1="82" y1="46" x2="102" y2="46"/>' +
        '<line x1="12" y1="46" x2="24" y2="46"/>' +
        '<rect x="8" y="41" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>' +
        '<rect x="23" y="41" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>' +
        '<line x1="96" y1="46" x2="108" y2="46"/>' +
        '<rect x="92" y="41" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>' +
        '<rect x="107" y="41" width="5" height="10" rx="2" fill="currentColor" stroke="none"/>'
      )
    },
    {
      id: 'high_knees',
      name: '高抬腿',
      mode: 'alternating',
      points: [25, 23],
      startAngle: null,
      bottomAngle: null,
      correctAngle: null,
      tracks: [
        { knee: 25, hip: 23, label: '左腿' },
        { knee: 26, hip: 24, label: '右腿' }
      ],
      raiseMargin: 0.02,
      correctHint: '膝盖抬到髋部以上，加快节奏',
      hint: '左右交替把膝盖抬到髋部以上',
      linePoints: null,
      svg: svgFigure(
        '<circle cx="54" cy="22" r="8" fill="currentColor" stroke="none"/>' +
        '<line x1="54" y1="32" x2="54" y2="64"/>' +
        '<line x1="54" y1="64" x2="54" y2="104"/>' +
        '<line x1="54" y1="64" x2="78" y2="48"/>' +
        '<line x1="78" y1="48" x2="70" y2="70"/>' +
        '<line x1="54" y1="42" x2="76" y2="54"/>' +
        '<line x1="54" y1="42" x2="34" y2="54"/>'
      )
    }
  ];

  /**
   * 各动作的动画示范配置（Canvas 火柴人）。
   *   duration：一个循环的毫秒数
   *   view：side 侧面 / front 正面
   *   anchor：lowest 最低点贴地 / hip 髋部固定
   *   joint：红色高亮并标注角度的关节
   *   params：正向运动学参数，动画中从 from 插值到 to
   *   equipment：dumbbell 表示手上画哑铃
   */
  const ANIMATION_PRESETS = {
    squat: {
      duration: 2000,
      view: 'side',
      anchor: 'lowest',
      joint: 'knee',
      params: {
        kneeAngle: { from: 170, to: 90 },
        thighAngle: { from: 0, to: -72 },
        torsoAngle: { from: 180, to: 190 },
        upperArmAngle: { from: 8, to: -38 },
        elbowAngle: { from: 172, to: 150 }
      }
    },
    pushup: {
      duration: 2200,
      view: 'side',
      anchor: 'lowest',
      joint: 'elbow',
      params: {
        torsoAngle: { from: 90, to: 90 },
        thighAngle: { from: 88, to: 88 },
        kneeAngle: { from: 176, to: 176 },
        upperArmAngle: { from: 2, to: 2 },
        elbowAngle: { from: 170, to: 90 }
      }
    },
    lunge: {
      duration: 2200,
      view: 'side',
      anchor: 'lowest',
      joint: 'knee',
      rearLeg: true,
      params: {
        kneeAngle: { from: 170, to: 90 },
        thighAngle: { from: 0, to: -62 },
        torsoAngle: { from: 180, to: 186 },
        rearThighAngle: { from: 16, to: 34 },
        rearKneeAngle: { from: 172, to: 148 },
        upperArmAngle: { from: 8, to: -30 },
        elbowAngle: { from: 170, to: 150 }
      }
    },
    jumping_jack: {
      duration: 1800,
      view: 'front',
      anchor: 'lowest',
      joint: 'shoulder',
      params: {
        armAngle: { from: 6, to: 162 },
        legSpread: { from: 3, to: 24 },
        kneeAngle: { from: 176, to: 176 }
      }
    },
    plank: {
      duration: 3200,
      view: 'side',
      anchor: 'lowest',
      joint: 'hip',
      params: {
        torsoAngle: { from: 90, to: 90 },
        thighAngle: { from: 88, to: 88 },
        kneeAngle: { from: 176, to: 176 },
        upperArmAngle: { from: 0, to: 0 },
        elbowAngle: { from: 172, to: 178 }
      }
    },
    biceps_curl: {
      duration: 2200,
      view: 'side',
      anchor: 'lowest',
      joint: 'elbow',
      equipment: 'dumbbell',
      params: {
        torsoAngle: { from: 180, to: 180 },
        thighAngle: { from: 0, to: 0 },
        kneeAngle: { from: 176, to: 176 },
        upperArmAngle: { from: 0, to: 0 },
        elbowAngle: { from: 180, to: 50 }
      }
    },
    shoulder_press: {
      duration: 2200,
      view: 'side',
      anchor: 'lowest',
      joint: 'elbow',
      equipment: 'dumbbell',
      params: {
        torsoAngle: { from: 180, to: 180 },
        thighAngle: { from: 0, to: 0 },
        kneeAngle: { from: 176, to: 176 },
        upperArmAngle: { from: 10, to: 170 },
        elbowAngle: { from: 20, to: 170 }
      }
    },
    lateral_raise: {
      duration: 2000,
      view: 'front',
      anchor: 'lowest',
      joint: 'shoulder',
      equipment: 'dumbbell',
      params: {
        armAngle: { from: 5, to: 88 },
        legSpread: { from: 4, to: 4 },
        kneeAngle: { from: 176, to: 176 }
      }
    },
    high_knees: {
      duration: 1400,
      view: 'side',
      anchor: 'hip',
      joint: 'knee',
      supportLeg: true,
      params: {
        thighAngle: { from: 0, to: -100 },
        kneeAngle: { from: 170, to: 90 },
        torsoAngle: { from: 180, to: 178 },
        upperArmAngle: { from: 10, to: -55 },
        elbowAngle: { from: 170, to: 140 }
      }
    }
  };

  /** 左右对称动作的另一侧关键点，用于两侧平均 */
  const MIRROR_POINTS = {
    squat: [24, 26, 28],
    lunge: [24, 26, 28],
    pushup: [12, 14, 16],
    biceps_curl: [12, 14, 16],
    shoulder_press: [12, 14, 16],
    lateral_raise: [12, 16],
    plank: [12, 24, 28]
  };

  /** 躯干直线检查的右侧三点 */
  const MIRROR_LINE_POINTS = {
    pushup: [12, 24, 28],
    plank: [12, 24, 28]
  };

  // 把动画、左右对称点合并进每个动作对象，保持 EXERCISES 作为唯一配置来源
  EXERCISES.forEach(function (exercise) {
    exercise.animation = ANIMATION_PRESETS[exercise.id] || null;
    exercise.pointsRight = MIRROR_POINTS[exercise.id] || null;
    exercise.linePointsRight = MIRROR_LINE_POINTS[exercise.id] || null;
  });

  /** 按 id 或中文名查找动作 */
  function getExercise(idOrName) {
    const text = String(idOrName === null || idOrName === undefined ? '' : idOrName).trim();
    if (!text) return null;
    return (
      EXERCISES.find(function (item) {
        return item.id === text || item.name === text;
      }) || null
    );
  }

  function isVisible(point) {
    if (!point) return false;
    if (typeof point.visibility === 'number') return point.visibility >= VISIBILITY_THRESHOLD;
    return true;
  }

  /** 三点夹角（余弦定理），返回角度制 */
  function calcAngle(a, b, c) {
    if (!a || !b || !c) return null;

    const abx = a.x - b.x;
    const aby = a.y - b.y;
    const cbx = c.x - b.x;
    const cby = c.y - b.y;

    const dot = abx * cbx + aby * cby;
    const magnitude = Math.sqrt((abx * abx + aby * aby) * (cbx * cbx + cby * cby));
    if (!magnitude) return null;

    const cosine = Math.max(-1, Math.min(1, dot / magnitude));
    return (Math.acos(cosine) * 180) / Math.PI;
  }

  /** 两点归一化坐标距离 */
  function calcDistance(a, b) {
    if (!a || !b) return null;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** 读取三个可见关键点 */
  function readPoints(landmarks, indexes) {
    const points = indexes.map(function (index) {
      return landmarks[index];
    });
    if (!points.every(isVisible)) return null;
    return points;
  }

  /**
   * 读取左右两侧角度并取平均：
   *   两侧都可见 → 平均值；只有一侧可见 → 使用可见侧；都不可见 → null。
   */
  function readBilateralAngle(landmarks, exerciseConfig) {
    const values = [];

    const left = readPoints(landmarks, exerciseConfig.points);
    if (left) {
      const angle = calcAngle(left[0], left[1], left[2]);
      if (angle !== null) values.push(angle);
    }

    if (exerciseConfig.pointsRight) {
      const right = readPoints(landmarks, exerciseConfig.pointsRight);
      if (right) {
        const angle = calcAngle(right[0], right[1], right[2]);
        if (angle !== null) values.push(angle);
      }
    }

    if (!values.length) return null;
    return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
  }

  /** 侧平举：读取左右手腕相对肩膀的高度差，取两侧平均 */
  function readHeightDelta(landmarks, exerciseConfig) {
    const values = [];

    const left = readPoints(landmarks, exerciseConfig.points);
    if (left) values.push(left[1].y - left[0].y);

    if (exerciseConfig.pointsRight) {
      const right = readPoints(landmarks, exerciseConfig.pointsRight);
      if (right) values.push(right[1].y - right[0].y);
    }

    if (!values.length) return null;
    return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
  }

  /** 姿态偏离直线的角度（180 度为完全笔直） */
  function calcLineDeviation(landmarks, indexes) {
    if (!indexes || indexes.length < 3) return null;
    const points = readPoints(landmarks, indexes);
    if (!points) return null;
    const angle = calcAngle(points[0], points[1], points[2]);
    if (angle === null) return null;
    return Math.abs(180 - angle);
  }

  /* ======================== Canvas 动画火柴人 ======================== */

  /** 动画逻辑画布尺寸与地面位置（CSS 再等比缩小显示） */
  const FIGURE_WIDTH = 320;
  const FIGURE_HEIGHT = 380;
  const GROUND_Y = 366;

  /**
   * 火柴人各段长度（贴近真人比例）：
   *   大腿 ≈ 小腿，上臂 ≈ 前臂，躯干略长于大腿。
   */
  const BODY = {
    torso: 100,
    thigh: 82,
    shin: 82,
    upperArm: 52,
    forearm: 52,
    head: 17
  };

  const FIGURE_COLORS = {
    line: '#d4ff4d',
    joint: '#ffffff',
    highlight: '#ff6b6b',
    ground: 'rgba(255, 255, 255, 0.28)',
    arrow: '#7fb2ff'
  };

  /** 极坐标 → 直角坐标：0° 向下，90° 向右，180° 向上 */
  function polar(origin, angleDeg, length) {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: origin.x + Math.sin(rad) * length,
      y: origin.y + Math.cos(rad) * length
    };
  }

  /** 把配置里的 from/to 按进度插值 */
  function interpolateParams(config, progress) {
    const params = {};
    Object.keys(config.params).forEach(function (key) {
      const range = config.params[key];
      params[key] = range.from + (range.to - range.from) * progress;
    });
    return params;
  }

  /**
   * 侧面视角正向运动学：
   *   从髋部出发向下算膝、踝；从肩出发算肘、腕。
   * 弓步的后腿、高抬腿的支撑腿按配置额外计算。
   */
  function computeSideFigure(params, config) {
    const hip = { x: 150, y: 210 };
    const shoulder = polar(hip, params.torsoAngle, BODY.torso);

    const knee = polar(hip, params.thighAngle, BODY.thigh);
    const shinAngle = params.thighAngle + (180 - params.kneeAngle);
    const ankle = polar(knee, shinAngle, BODY.shin);

    const elbow = polar(shoulder, params.upperArmAngle, BODY.upperArm);
    const lowerArmAngle = params.upperArmAngle - (180 - params.elbowAngle);
    const wrist = polar(elbow, lowerArmAngle, BODY.forearm);

    const neck = polar(shoulder, params.torsoAngle, 12);
    const head = polar(neck, params.torsoAngle, 16);

    const points = {
      hip: hip,
      shoulder: shoulder,
      neck: neck,
      head: head,
      knee: knee,
      ankle: ankle,
      elbow: elbow,
      wrist: wrist
    };

    // 弓步的后腿
    if (config.rearLeg) {
      const rearKnee = polar(hip, params.rearThighAngle, BODY.thigh);
      const rearShinAngle = params.rearThighAngle + (180 - params.rearKneeAngle);
      points.rearKnee = rearKnee;
      points.rearAnkle = polar(rearKnee, rearShinAngle, BODY.shin);
    }

    // 高抬腿的支撑腿（保持笔直站立）
    if (config.supportLeg) {
      points.supportKnee = polar(hip, 0, BODY.thigh);
      points.supportAnkle = polar(points.supportKnee, 0, BODY.shin);
    }

    // 贴地：让最低的脚 / 手落在地面线上
    if (config.anchor !== 'hip') {
      let lowest = Math.max(ankle.y, wrist.y);
      if (points.rearAnkle) lowest = Math.max(lowest, points.rearAnkle.y);
      if (points.supportAnkle) lowest = Math.max(lowest, points.supportAnkle.y);

      const shift = GROUND_Y - lowest;
      Object.keys(points).forEach(function (key) {
        points[key] = { x: points[key].x, y: points[key].y + shift };
      });
    }

    return points;
  }

  /**
   * 正面视角正向运动学：左右对称的手臂与腿。
   * armAngle：手臂相对竖直向下的角度；legSpread：双腿张开角度。
   */
  function computeFrontFigure(params) {
    const hip = { x: 160, y: 210 };
    const shoulder = { x: 160, y: hip.y - BODY.torso };
    const head = { x: 160, y: shoulder.y - 22 };

    const spread = params.legSpread;
    const leftKnee = polar(hip, -spread, BODY.thigh);
    const leftAnkle = polar(leftKnee, -spread, BODY.shin);
    const rightKnee = polar(hip, spread, BODY.thigh);
    const rightAnkle = polar(rightKnee, spread, BODY.shin);

    const arm = params.armAngle;
    const leftElbow = polar(shoulder, -arm, BODY.upperArm);
    const leftWrist = polar(leftElbow, -arm, BODY.forearm);
    const rightElbow = polar(shoulder, arm, BODY.upperArm);
    const rightWrist = polar(rightElbow, arm, BODY.forearm);

    const points = {
      hip: hip,
      shoulder: shoulder,
      head: head,
      leftKnee: leftKnee,
      leftAnkle: leftAnkle,
      rightKnee: rightKnee,
      rightAnkle: rightAnkle,
      leftElbow: leftElbow,
      leftWrist: leftWrist,
      rightElbow: rightElbow,
      rightWrist: rightWrist
    };

    // 右侧别名：供角度标注 / 箭头 / 哑铃复用
    points.knee = rightKnee;
    points.ankle = rightAnkle;
    points.elbow = rightElbow;
    points.wrist = rightWrist;

    const lowest = Math.max(leftAnkle.y, rightAnkle.y);
    const shift = GROUND_Y - lowest;
    Object.keys(points).forEach(function (key) {
      points[key] = { x: points[key].x, y: points[key].y + shift };
    });

    return points;
  }

  /** 画一条线段 */
  function lineBetween(context, from, to, color) {
    if (!from || !to) return;
    context.strokeStyle = color || FIGURE_COLORS.line;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }

  /** 画关节圆点 */
  function drawJoint(context, point, radius, color) {
    if (!point) return;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  }

  /** 判断某个关节是否需要红色高亮 */
  function isHighlightJoint(jointName, key) {
    if (jointName === 'knee') return key === 'knee' || key === 'leftKnee' || key === 'rightKnee';
    if (jointName === 'elbow') return key === 'elbow' || key === 'leftElbow' || key === 'rightElbow';
    return jointName === key;
  }

  /** 绘制骨架与关节 */
  function drawSkeleton(context, config, points) {
    context.lineWidth = 3;
    context.lineCap = 'round';

    lineBetween(context, points.hip, points.shoulder);
    lineBetween(context, points.shoulder, points.neck);

    context.beginPath();
    context.arc(points.head.x, points.head.y, BODY.head, 0, Math.PI * 2);
    context.strokeStyle = FIGURE_COLORS.line;
    context.stroke();

    if (config.view === 'front') {
      lineBetween(context, points.hip, points.leftKnee);
      lineBetween(context, points.leftKnee, points.leftAnkle);
      lineBetween(context, points.hip, points.rightKnee);
      lineBetween(context, points.rightKnee, points.rightAnkle);

      lineBetween(context, points.shoulder, points.leftElbow);
      lineBetween(context, points.leftElbow, points.leftWrist);
      lineBetween(context, points.shoulder, points.rightElbow);
      lineBetween(context, points.rightElbow, points.rightWrist);
    } else {
      lineBetween(context, points.hip, points.knee);
      lineBetween(context, points.knee, points.ankle);

      if (points.rearKnee) {
        lineBetween(context, points.hip, points.rearKnee, 'rgba(212, 255, 77, 0.55)');
        lineBetween(context, points.rearKnee, points.rearAnkle, 'rgba(212, 255, 77, 0.55)');
      }

      if (points.supportKnee) {
        lineBetween(context, points.hip, points.supportKnee);
        lineBetween(context, points.supportKnee, points.supportAnkle);
      }

      lineBetween(context, points.shoulder, points.elbow);
      lineBetween(context, points.elbow, points.wrist);
    }

    const joints = config.view === 'front'
      ? [
          ['hip', points.hip],
          ['shoulder', points.shoulder],
          ['leftKnee', points.leftKnee],
          ['rightKnee', points.rightKnee],
          ['leftAnkle', points.leftAnkle],
          ['rightAnkle', points.rightAnkle],
          ['leftElbow', points.leftElbow],
          ['rightElbow', points.rightElbow],
          ['leftWrist', points.leftWrist],
          ['rightWrist', points.rightWrist]
        ]
      : [
          ['hip', points.hip],
          ['shoulder', points.shoulder],
          ['knee', points.knee],
          ['ankle', points.ankle],
          ['elbow', points.elbow],
          ['wrist', points.wrist]
        ];

    joints.forEach(function (entry) {
      const active = isHighlightJoint(config.joint, entry[0]);
      drawJoint(
        context,
        entry[1],
        active ? 9 : 5,
        active ? FIGURE_COLORS.highlight : FIGURE_COLORS.joint
      );
    });

    if (points.rearKnee) drawJoint(context, points.rearKnee, 5, FIGURE_COLORS.joint);
    if (points.rearAnkle) drawJoint(context, points.rearAnkle, 5, FIGURE_COLORS.joint);
    if (points.supportKnee) drawJoint(context, points.supportKnee, 5, FIGURE_COLORS.joint);
    if (points.supportAnkle) drawJoint(context, points.supportAnkle, 5, FIGURE_COLORS.joint);
  }

  /** 在关键关节画角度弧线 + 角度数值 */
  function drawAngleLabel(context, config, points) {
    const jointMap = {
      knee: ['hip', 'knee', 'ankle'],
      elbow: ['shoulder', 'elbow', 'wrist'],
      shoulder: ['hip', 'shoulder', 'elbow'],
      hip: ['shoulder', 'hip', 'knee']
    };
    const keys = jointMap[config.joint];
    if (!keys) return;

    const a = points[keys[0]];
    const b = points[keys[1]];
    const c = points[keys[2]];
    if (!a || !b || !c) return;

    const angle = calcAngle(a, b, c);
    if (angle === null) return;

    const start = Math.atan2(a.y - b.y, a.x - b.x);
    const end = Math.atan2(c.y - b.y, c.x - b.x);
    let delta = end - start;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    context.strokeStyle = FIGURE_COLORS.highlight;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(b.x, b.y, 26, start, start + delta, delta < 0);
    context.stroke();

    const mid = start + delta / 2;
    context.fillStyle = FIGURE_COLORS.highlight;
    context.font = 'bold 15px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(
      Math.round(angle) + '°',
      b.x + Math.cos(mid) * 42,
      b.y + Math.sin(mid) * 42
    );
  }

  /** 沿运动方向画箭头 */
  function drawMotionArrow(context, config, points, nextPoints) {
    const keyMap = { knee: 'knee', elbow: 'elbow', shoulder: 'shoulder', hip: 'hip' };
    const key = keyMap[config.joint];
    if (!key) return;

    const current = points[key];
    const next = nextPoints[key];
    if (!current || !next) return;

    const dx = next.x - current.x;
    const dy = next.y - current.y;
    const length = Math.hypot(dx, dy);
    if (length < 1.2) return;

    const ux = dx / length;
    const uy = dy / length;
    const startX = current.x + ux * 38;
    const startY = current.y + uy * 38;
    const endX = startX + ux * 28;
    const endY = startY + uy * 28;

    context.strokeStyle = FIGURE_COLORS.arrow;
    context.fillStyle = FIGURE_COLORS.arrow;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
    context.stroke();

    const angle = Math.atan2(uy, ux);
    context.beginPath();
    context.moveTo(endX, endY);
    context.lineTo(endX - Math.cos(angle - 0.5) * 9, endY - Math.sin(angle - 0.5) * 9);
    context.lineTo(endX - Math.cos(angle + 0.5) * 9, endY - Math.sin(angle + 0.5) * 9);
    context.closePath();
    context.fill();
  }

  /** 器械动作：在手腕处画哑铃 */
  function drawDumbbells(context, config, points) {
    if (config.equipment !== 'dumbbell') return;

    const wrists = config.view === 'front'
      ? [points.leftWrist, points.rightWrist]
      : [points.wrist];

    wrists.forEach(function (wrist) {
      if (!wrist) return;

      context.save();
      context.translate(wrist.x, wrist.y);
      context.fillStyle = FIGURE_COLORS.joint;
      context.fillRect(-11, -2.5, 22, 5);
      context.fillStyle = FIGURE_COLORS.line;
      context.fillRect(-15, -7, 5, 14);
      context.fillRect(10, -7, 5, 14);
      context.restore();
    });
  }

  /** 绘制关键关节的浅色虚线运动轨迹 */
  function drawMotionTrail(context, config) {
    const keyMap = { knee: 'knee', elbow: 'elbow', shoulder: 'shoulder', hip: 'hip' };
    const key = keyMap[config.joint];
    if (!key) return;

    const samples = 20;
    context.save();
    context.setLineDash([5, 5]);
    context.lineWidth = 1.5;
    context.strokeStyle = 'rgba(255, 255, 255, 0.26)';
    context.beginPath();

    let started = false;
    for (let i = 0; i <= samples; i += 1) {
      const params = interpolateParams(config, i / samples);
      const points = config.view === 'front'
        ? computeFrontFigure(params)
        : computeSideFigure(params, config);
      const point = points[key];
      if (!point) continue;

      if (started) {
        context.lineTo(point.x, point.y);
      } else {
        context.moveTo(point.x, point.y);
        started = true;
      }
    }

    context.stroke();
    context.restore();
  }

  /** 绘制一帧 */
  function drawFigure(context, config, progress) {
    context.clearRect(0, 0, FIGURE_WIDTH, FIGURE_HEIGHT);

    // 地面线
    context.strokeStyle = FIGURE_COLORS.ground;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(18, GROUND_Y);
    context.lineTo(FIGURE_WIDTH - 18, GROUND_Y);
    context.stroke();

    // 关键关节运动轨迹（浅色虚线）
    drawMotionTrail(context, config);

    const params = interpolateParams(config, progress);
    const points = config.view === 'front'
      ? computeFrontFigure(params)
      : computeSideFigure(params, config);

    // 用下一帧位置判断运动方向，画箭头
    const nextParams = interpolateParams(config, Math.min(1, progress + 0.015));
    const nextPoints = config.view === 'front'
      ? computeFrontFigure(nextParams)
      : computeSideFigure(nextParams, config);

    drawSkeleton(context, config, points);
    drawAngleLabel(context, config, points);
    drawMotionArrow(context, config, points, nextPoints);
    drawDumbbells(context, config, points);
  }

  /**
   * 动画播放器：弹窗打开时 start()，关闭时 stop()。
   * 每个循环从 0 → 1 → 0（正弦往返），保证动作有去有回。
   */
  function createFigureAnimator(canvasElement) {
    const context = canvasElement ? canvasElement.getContext('2d') : null;
    let config = null;
    let rafId = null;
    let startedAt = null;

    function setConfig(exercise) {
      config = exercise && exercise.animation ? exercise.animation : null;
    }

    function loop(timestamp) {
      if (!config) return;
      if (startedAt === null) startedAt = timestamp;

      const elapsed = (timestamp - startedAt) % config.duration;
      const rawProgress = elapsed / config.duration;
      // 正弦往返：0 → 1 → 0
      const progress = (1 - Math.cos(rawProgress * Math.PI * 2)) / 2;

      drawFigure(context, config, progress);
      rafId = global.requestAnimationFrame(loop);
    }

    function start() {
      if (!config || !context) return;
      stop();
      startedAt = null;
      rafId = global.requestAnimationFrame(loop);
    }

    function stop() {
      if (rafId !== null && global.cancelAnimationFrame) {
        global.cancelAnimationFrame(rafId);
      }
      rafId = null;
      startedAt = null;
      if (context) context.clearRect(0, 0, FIGURE_WIDTH, FIGURE_HEIGHT);
    }

    return { setConfig: setConfig, start: start, stop: stop };
  }

  /* ======================== 统一语音管理 ======================== */

  /**
   * 语音优先级：
   *   high   计数报数：立即打断当前语音，保证报数最及时
   *   normal 动作 / 组完成 / 休息提示：空闲时播报，忙时排队
   *   low    鼓励语：空闲时播报，忙时排队等当前语音结束
   * 训练流程与姿势纠正共用这一套语音，避免互相抢占。
   */
  let speechBusy = false;
  let currentIsCount = false;
  let speechSeq = 0;
  let speechQueue = [];
  let drainTimer = null;
  // 语音引擎健康状况：连续失败且从未成功时，报数降级为提示音
  let speechFailures = 0;
  let speechSucceeded = false;
  let speechFallbackActive = false;
  let audioContext = null;
  // Chrome 的 cancel() 是异步的，紧接着 speak() 会被连坐丢弃，
  // 因此取消后留出一小段静默窗口再播下一条。
  let cancelGuardUntil = 0;

  /** 挑选中文语音；没有中文包时返回 null，由浏览器按 lang 兜底 */
  function pickChineseVoice() {
    const synth = global.speechSynthesis;
    if (!synth || typeof synth.getVoices !== 'function') return null;

    let voices = [];
    try {
      voices = synth.getVoices() || [];
    } catch (error) {
      return null;
    }

    let fallback = null;
    for (let i = 0; i < voices.length; i += 1) {
      const voice = voices[i];
      const lang = String(voice.lang || '').toLowerCase();
      if (lang.indexOf('zh') !== 0 && lang.indexOf('cmn') !== 0) continue;
      // 同语言下优先本地语音（响应更快、不依赖网络）
      if (lang.indexOf('zh-cn') === 0 && voice.localService) return voice;
      if (lang.indexOf('zh-cn') === 0) fallback = voice;
      else if (!fallback) fallback = voice;
    }
    return fallback;
  }

  /** Chrome 空闲后会挂起语音引擎，挂起状态下的播报一律无声 */
  function resumeSpeech() {
    const synth = global.speechSynthesis;
    if (!synth) return;
    try {
      if (synth.paused) synth.resume();
    } catch (error) {
      /* 部分浏览器不支持 resume，忽略即可 */
    }
  }

  /**
   * 语音引擎不可用时的兜底提示音：短促单音，用于告诉用户"计到了一次"。
   * 只在报数（high）时使用，避免普通提示音过多干扰。
   */
  function beepCount() {
    try {
      const Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) return;

      if (!audioContext) audioContext = new Ctor();
      if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
        audioContext.resume();
      }

      const now = audioContext.currentTime;
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch (error) {
      /* 部分环境不支持 WebAudio，忽略 */
    }
  }

  /** 语音能力诊断：页面可据此提示用户是否缺少中文语音包 */
  function getSpeechDiagnostics() {
    const synth = global.speechSynthesis;
    let voiceCount = 0;

    try {
      voiceCount = synth && typeof synth.getVoices === 'function'
        ? (synth.getVoices() || []).length
        : 0;
    } catch (error) {
      voiceCount = 0;
    }

    return {
      supported: 'speechSynthesis' in global,
      voiceCount: voiceCount,
      chineseVoice: Boolean(pickChineseVoice()),
      paused: Boolean(synth && synth.paused),
      fallbackActive: speechFallbackActive,
      failures: speechFailures
    };
  }

  /** 纠正统计：返回 { 动作名: 次数 }，读取后清零避免下次训练重复累计 */
  function getCorrectionStats() {
    const stats = {};

    Object.keys(correctionTotals).forEach(function (id) {
      const item = getExercise(id);
      stats[item ? item.name : id] = correctionTotals[id];
      correctionTotals[id] = 0;
    });

    return stats;
  }

  function cancelSpeechManager() {
    // 递增序号让所有已发出的语音回调失效，避免旧回调清掉新语音的状态
    speechSeq += 1;
    speechQueue = [];
    speechBusy = false;
    currentIsCount = false;
    cancelGuardUntil = Date.now() + 150;

    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }

    if ('speechSynthesis' in global) {
      try {
        global.speechSynthesis.cancel();
      } catch (error) {
        console.warn('[posture] 取消语音失败', error);
      }
    }
  }

  function utterSpeech(text, rate, isCount) {
    const synth = global.speechSynthesis;

    // 语音引擎缺失或已判定不可用：报数改用提示音，保证用户有反馈
    if (!synth || speechFallbackActive) {
      if (isCount) beepCount();
      if (speechQueue.length) setTimeout(drainSpeechQueue, 0);
      return;
    }

    resumeSpeech();

    try {
      const utterance = new global.SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.volume = 1;
      utterance.rate = rate || 1.05;
      utterance.pitch = 1;

      const voice = pickChineseVoice();
      if (voice) utterance.voice = voice;

      const seq = (speechSeq += 1);
      speechBusy = true;
      currentIsCount = Boolean(isCount);

      // 兜底：部分环境不会触发 onend / onerror，避免状态永久卡死
      const guardTimer = setTimeout(function () {
        if (seq !== speechSeq) return;
        speechBusy = false;
        currentIsCount = false;
        drainSpeechQueue();
      }, Math.max(2500, String(text).length * 320 + 1200));

      const settle = function () {
        clearTimeout(guardTimer);
        // 已被取消或被新语音取代时，不要覆盖当前状态
        if (seq !== speechSeq) return;
        speechBusy = false;
        currentIsCount = false;
        drainSpeechQueue();
      };

      utterance.onend = function () {
        // 成功播报过就重置失败计数，避免偶发错误触发降级
        speechSucceeded = true;
        speechFailures = 0;
        settle();
      };

      utterance.onerror = function (event) {
        const reason = event && event.error;
        // interrupted / canceled 属于主动打断，不算异常
        if (reason && reason !== 'interrupted' && reason !== 'canceled') {
          console.warn('[posture] 语音播报异常', reason);
          speechFailures += 1;
          // 从未成功播报且连续失败：判定语音引擎不可用，后续报数改用提示音
          if (!speechSucceeded && speechFailures >= 2) {
            speechFallbackActive = true;
            console.warn('[posture] 语音引擎不可用，已切换为提示音兜底');
          }
        }
        settle();
      };

      synth.speak(utterance);

      // 静默失败检测：400ms 后既没有任何播报活动，也没收到结束回调，
      // 说明这条语音被浏览器丢弃（cancel 竞态或引擎异常）。
      setTimeout(function () {
        if (seq !== speechSeq) return;
        if (!speechBusy) return;
        if (synth.speaking || synth.pending) return;

        speechFailures += 1;
        if (isCount) beepCount();
        if (!speechSucceeded) {
          speechFallbackActive = true;
          console.warn('[posture] 语音引擎未响应，已切换为提示音兜底');
        }
        settle();
      }, 400);
    } catch (error) {
      speechBusy = false;
      currentIsCount = false;
      speechFailures += 1;
      if (!speechSucceeded && speechFailures >= 2) {
        speechFallbackActive = true;
        console.warn('[posture] 语音引擎不可用，已切换为提示音兜底');
      }
      console.warn('[posture] 语音播报失败', error);
      if (isCount) beepCount();
      drainSpeechQueue();
    }
  }

  function drainSpeechQueue() {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (speechBusy || !speechQueue.length) return;

    const wait = cancelGuardUntil - Date.now();
    if (wait > 0) {
      drainTimer = setTimeout(drainSpeechQueue, wait);
      return;
    }

    const item = speechQueue.shift();
    utterSpeech(item.text, item.rate, item.isCount);
  }

  function speakText(text, priority) {
    if (!text || !('speechSynthesis' in global)) return;

    const level = priority || 'normal';
    const isCount = level === 'high';
    // 计数报数语速稍快，短促清晰
    const rate = isCount ? 1.3 : 1.05;
    const item = { text: text, rate: rate, isCount: isCount };

    if (isCount) {
      // 正在播报上一次报数时排队，避免连续计数互相掐断
      if (speechBusy && currentIsCount) {
        speechQueue.push(item);
        return;
      }

      // 关键：只有在真的有语音在播时才打断。
      // 空闲状态下调用 cancel() 会让紧随其后的 speak() 被 Chrome 静默丢弃，
      // 现象就是"计数正常、纠正有声音，但报数完全没有声音"。
      if (speechBusy) {
        cancelSpeechManager();
      }

      speechQueue.push(item);
      drainSpeechQueue();
      return;
    }

    // 普通 / 鼓励语音：忙时清掉排队中的非报数项，只保留最新一条
    if (speechBusy) {
      for (let i = speechQueue.length - 1; i >= 0; i -= 1) {
        if (!speechQueue[i].isCount) speechQueue.splice(i, 1);
      }
      speechQueue.push(item);
      return;
    }

    speechQueue.push(item);
    drainSpeechQueue();
  }

  // 预热语音列表：部分浏览器首次 getVoices() 为空，需提前触发加载
  if ('speechSynthesis' in global && typeof global.speechSynthesis.getVoices === 'function') {
    try {
      global.speechSynthesis.getVoices();
    } catch (error) {
      /* 忽略预热失败 */
    }
  }

  /**
   * 创建姿势检测器。
   *
   * @param {Object} options
   * @param {HTMLVideoElement} options.video
   * @param {HTMLCanvasElement} options.canvas
   * @param {HTMLElement} [options.alertRoot] 纠正弹窗容器
   * @param {HTMLElement} [options.alertText] 弹窗文案
   * @param {HTMLElement} [options.alertSvg] 弹窗 SVG 容器
   * @param {HTMLElement} [options.alertClose] 弹窗关闭按钮
   * @param {Function} [options.onStatus]
   * @param {Function} [options.onCount]
   * @param {Function} [options.onReps]
   */
  function create(options) {
    const video = options.video;
    const canvas = options.canvas;
    const alertRoot = options.alertRoot || null;
    const alertText = options.alertText || null;
    const alertCanvas = options.alertCanvas || null;
    const alertClose = options.alertClose || null;

    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : function () {};
    const onCount = typeof options.onCount === 'function' ? options.onCount : function () {};
    const onReps = typeof options.onReps === 'function' ? options.onReps : function () {};

    const context = canvas ? canvas.getContext('2d') : null;

    let pose = null;
    let camera = null;
    let active = false;
    let sending = false;
    /** 帧计数器：每 2 帧只送 1 帧给 Pose，检测帧率减半以降低卡顿 */
    let frameTick = 0;
    let lastError = null;
    let exercise = EXERCISES[0];
    let alertTimer = null;
    // 纠正弹窗里的 Canvas 动画播放器
    let alertAnimator = alertCanvas ? createFigureAnimator(alertCanvas) : null;
    let tracker = createTracker();

    /** 一次动作的计数 / 纠正状态 */
    function createTracker() {
      return {
        // 距离类从"闭合"开始，高度类从"下垂"开始，其余从起始角度开始
        phase: exercise.mode === 'distance'
          ? 'closed'
          : exercise.mode === 'height'
            ? 'down'
            : 'start',
        reps: 0,
        corrected: false,
        localPeak: 0,
        peak: 0,
        minDelta: 1,
        peakWindow: [],
        legs: {},
        lastLeg: null,
        failCount: 0,
        holdStartedAt: Date.now(),
        holdSeconds: -1,
        nextAnnounce: 10,
        lastCorrections: {},
        angleHistory: [],
        lastRepAt: 0,
        // 站立基线与最浅深度：角度类动作用来自适应阈值
        baseAngle: 0,
        baseFrames: 0,
        minAngle: 0,
        downFrames: 0,
        // 连续几次"幅度够但深度不足"，用于克制纠正提示频率
        shallowStreak: 0
      };
    }

    /** 最近 7 帧角度移动平均，减少关键点抖动 */
    function smoothAngle(value) {
      const history = tracker.angleHistory;
      history.push(value);
      if (history.length > 7) history.shift();
      return history.reduce(function (sum, item) { return sum + item; }, 0) / history.length;
    }

    /** 计数并加 500ms 锁定期，防止抖动重复计数 */
    function countRep() {
      const now = Date.now();
      if (now - tracker.lastRepAt < REP_LOCK_MS) return false;
      tracker.lastRepAt = now;
      tracker.reps += 1;
      onReps(tracker.reps, '次');
      // 报数放在计数源头：自由训练与计划训练都能听到，不依赖 Trainer 是否启动
      speakText(String(tracker.reps), 'high');
      return true;
    }

    /** 重置计数状态（切换动作 / 开始 / 停止时调用） */
    function resetTracker() {
      tracker = createTracker();
      onReps(0, exercise.mode === 'hold' ? '秒' : '次');
    }

    function countVisible(landmarks) {
      if (!landmarks || !landmarks.length) return 0;
      return landmarks.filter(isVisible).length;
    }

    function clearCanvas() {
      if (context && canvas) {
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    /** 绘制骨架与关键点 */
    function draw(landmarks) {
      if (!context || !canvas) return;

      clearCanvas();
      if (!landmarks || !landmarks.length) {
        onCount(0, 33);
        return;
      }

      const width = canvas.width;
      const height = canvas.height;

      context.lineWidth = 3;
      context.lineCap = 'round';
      context.strokeStyle = 'rgba(212, 255, 77, 0.9)';

      POSE_CONNECTIONS.forEach(function (pair) {
        const from = landmarks[pair[0]];
        const to = landmarks[pair[1]];
        if (!isVisible(from) || !isVisible(to)) return;

        context.beginPath();
        context.moveTo(from.x * width, from.y * height);
        context.lineTo(to.x * width, to.y * height);
        context.stroke();
      });

      landmarks.forEach(function (point, index) {
        if (!isVisible(point)) return;

        context.beginPath();
        context.arc(point.x * width, point.y * height, 4, 0, Math.PI * 2);
        context.fillStyle = index < 11 ? '#ffffff' : '#d4ff4d';
        context.fill();

        context.lineWidth = 1;
        context.strokeStyle = 'rgba(11, 13, 17, 0.85)';
        context.stroke();
      });

      onCount(countVisible(landmarks), landmarks.length);
    }

    /* ======================== 纠正弹窗与语音 ======================== */

    function hideAlert() {
      if (alertTimer) {
        clearTimeout(alertTimer);
        alertTimer = null;
      }
      if (alertAnimator) alertAnimator.stop();
      if (alertRoot) alertRoot.hidden = true;
    }

    function showAlert(text) {
      if (!alertRoot) return;

      if (alertText) alertText.textContent = text;

      // 启动当前动作的 Canvas 动画示范
      if (alertAnimator) {
        alertAnimator.setConfig(exercise);
        alertAnimator.start();
      }

      alertRoot.hidden = false;
      if (alertTimer) clearTimeout(alertTimer);
      alertTimer = setTimeout(hideAlert, ALERT_DURATION);
    }

    function cancelSpeech() {
      cancelSpeechManager();
    }

    function speak(text) {
      // 姿势纠正使用普通优先级，与训练提示共享同一套语音队列
      speakText(text, 'normal');
    }

    /** 触发纠正：同一类纠正 4 秒内只提示一次，并累计该动作的纠正次数 */
    function reportCorrection(key, text) {
      const now = Date.now();
      if (tracker.lastCorrections[key] && now - tracker.lastCorrections[key] < CORRECTION_COOLDOWN) {
        return;
      }
      tracker.lastCorrections[key] = now;

      // 累计次数，复盘页用于统计高频易错动作
      if (exercise && exercise.id) {
        correctionTotals[exercise.id] = (correctionTotals[exercise.id] || 0) + 1;
      }

      showAlert(text);
      speak(text);
    }

    /* ======================== 通用计数状态机 ======================== */

    /**
     * 角度类：起始 → 下降 → 底部 → 回到起始 = 1 次。
     *
     * 阈值自适应：以启动时校准出的站立基线为参照，
     *   进入下蹲 = 低于「配置起始角」与「基线 × 0.88」中较小的那个；
     *   蹲到位   = 低于「配置底部角」与「基线 × 0.62」中较小的那个。
     * 侧对摄像头、站直角度接近 180° 时，行为与配置值（150° / 90°）一致；
     * 正面拍摄站直只有 130°~150° 时，阈值同步下调，不再把"站着"误判成下蹲。
     */
    function updateAngleState(value) {
      // 反向角度动作（如肩上推举）：从小角度推到大角度再收回
      if (exercise.inverted) {
        updateInvertedAngleState(value);
        return;
      }

      // 启动校准：取前若干帧的最大角度作为站立基线
      if (tracker.baseFrames < BASE_CALIBRATION_FRAMES) {
        tracker.baseFrames += 1;
        tracker.baseAngle = Math.max(tracker.baseAngle, value);

        if (tracker.baseFrames >= BASE_CALIBRATION_FRAMES) {
          // 校准期间几乎没站直（例如一开始就蹲着），退回配置阈值
          if (tracker.baseAngle < exercise.startAngle * 0.75) {
            tracker.baseAngle = exercise.startAngle;
          }
          tracker.minAngle = value;
        }
        return;
      }

      const base = tracker.baseAngle;
      const enterGate = Math.min(exercise.startAngle, base * 0.88);
      const countGate = Math.min(exercise.bottomAngle, base * 0.62);

      if (tracker.phase === 'start') {
        tracker.minAngle = value;
        // 角度仍在起始范围，等待下蹲
        if (value >= enterGate) return;
        tracker.phase = 'down';
        tracker.downFrames = 0;
        tracker.corrected = false;
      }

      if (tracker.phase === 'down') {
        tracker.downFrames += 1;
        tracker.minAngle = Math.min(tracker.minAngle, value);

        // 蹲到位：进入底部阶段（至少保持 2 帧，避免单帧误判直接计数）
        if (value <= countGate && tracker.downFrames >= 2) {
          tracker.phase = 'bottom';
          return;
        }

        // 回到起始高度时结算本周期
        if (value >= enterGate) {
          const stroke = base - tracker.minAngle;
          const minStroke = Math.min(MIN_VALID_STROKE, base * 0.32);

          if (stroke >= minStroke) {
            // 幅度足够就算一次：柔韧性一般或机位偏差时也能听到报数
            countRep();
            tracker.shallowStreak += 1;

            // 连续 2 次都没到标准深度才提示，避免每次都说"再蹲深一点"
            if (tracker.shallowStreak >= 2 && !tracker.corrected) {
              tracker.corrected = true;
              tracker.shallowStreak = 0;
              reportCorrection('angle', exercise.correctHint);
            }
          } else if (tracker.downFrames >= 8 && !tracker.corrected) {
            // 幅度明显不足：不计数，只提示
            tracker.corrected = true;
            reportCorrection('angle', exercise.correctHint);
          }

          tracker.phase = 'start';
          tracker.minAngle = value;
          tracker.corrected = false;
        }
        return;
      }

      if (tracker.phase === 'bottom' && value >= enterGate) {
        tracker.phase = 'start';
        tracker.corrected = false;
        tracker.shallowStreak = 0;
        tracker.minAngle = value;
        countRep();
      }
    }

    /**
     * 反向角度类：起始小角度 → 推到大角度 → 收回 = 1 次（肩上推举）。
     * 推到顶但未完全伸直时，在开始回落时提示一次。
     */
    function updateInvertedAngleState(value) {
      if (tracker.phase === 'start') {
        if (value <= exercise.startAngle) return;
        tracker.phase = 'rising';
        tracker.peak = value;
        tracker.corrected = false;
      }

      if (tracker.phase === 'rising') {
        const previousPeak = tracker.peak;
        tracker.peak = Math.max(tracker.peak, value);

        // 推到顶但没有完全伸直：回落超过 2 度时提示一次
        if (
          value < previousPeak - 2 &&
          previousPeak < exercise.correctAngle &&
          !tracker.corrected
        ) {
          tracker.corrected = true;
          reportCorrection('angle', exercise.correctHint);
        }

        if (value >= exercise.bottomAngle) {
          tracker.phase = 'top';
          return;
        }

        if (value <= exercise.startAngle) {
          tracker.phase = 'start';
          tracker.corrected = false;
          tracker.peak = value;
        }
        return;
      }

      if (tracker.phase === 'top' && value <= exercise.startAngle) {
        tracker.phase = 'start';
        tracker.corrected = false;
        tracker.peak = value;
        countRep();
      }
    }

    /** 记录开合跳的一次峰值，连续 3 次幅度不足则纠正 */
    function recordPeak(peak) {
      if (!peak || peak <= 0) return;

      tracker.peakWindow.push(peak);
      if (tracker.peakWindow.length > 3) tracker.peakWindow.shift();

      const allTooSmall =
        tracker.peakWindow.length === 3 &&
        tracker.peakWindow.every(function (value) {
          return value < exercise.openMin;
        });

      if (allTooSmall) {
        reportCorrection('amplitude', exercise.correctHint);
        tracker.peakWindow = [];
      }
    }

    /** 距离类：体侧 → 举起 → 放下 = 1 次 */
    function updateDistanceState(distance) {
      const isOpen = distance >= exercise.openMin;
      const isClosed = distance <= exercise.closedMax;

      if (tracker.phase === 'closed') {
        if (distance <= exercise.closedMax) return;
        tracker.phase = 'rising';
        tracker.localPeak = distance;
      }

      if (tracker.phase === 'rising') {
        tracker.localPeak = Math.max(tracker.localPeak, distance);

        if (isOpen) {
          tracker.phase = 'open';
        } else if (isClosed) {
          // 没举到位就放下，记录一次幅度不足
          recordPeak(tracker.localPeak);
          tracker.phase = 'closed';
          tracker.localPeak = 0;
          return;
        } else {
          return;
        }
      }

      if (tracker.phase === 'open') {
        tracker.localPeak = Math.max(tracker.localPeak, distance);

        if (isClosed) {
          recordPeak(tracker.localPeak);
          tracker.phase = 'closed';

          if (tracker.localPeak >= exercise.openMin) {
            countRep();
          }
          tracker.localPeak = 0;
        }
      }
    }

    /** 高度类：手腕从低于肩抬到肩高再放下 = 1 次（侧平举） */
    function updateHeightState(landmarks) {
      // 左右两侧高度差取平均，一侧被遮挡时自动使用可见侧
      const delta = readHeightDelta(landmarks, exercise);
      if (delta === null) return;

      if (tracker.phase === 'down') {
        if (delta >= exercise.downThreshold) return;
        tracker.phase = 'rising';
        tracker.minDelta = delta;
      }

      if (tracker.phase === 'rising') {
        tracker.minDelta = Math.min(tracker.minDelta, delta);

        if (delta <= exercise.upThreshold) {
          tracker.phase = 'up';
        } else if (delta >= exercise.downThreshold) {
          // 没抬到肩高就放下：提示动作幅度
          if (tracker.minDelta > exercise.correctThreshold) {
            reportCorrection('height', exercise.correctHint);
          }
          tracker.phase = 'down';
          tracker.minDelta = 1;
          return;
        } else {
          return;
        }
      }

      if (tracker.phase === 'up' && delta >= exercise.downThreshold) {
        tracker.phase = 'down';
        tracker.minDelta = 1;
        countRep();
      }
    }

    /**
     * 交替类：左右膝盖交替抬到髋部以上，各计 1 次（高抬腿）。
     * 同一侧连续抬腿不重复计数；连续 3 次没抬到髋部高度则提示。
     */
    function updateAlternatingState(landmarks) {
      const tracks = exercise.tracks || [];
      const raiseMargin = exercise.raiseMargin || 0.02;

      tracks.forEach(function (track) {
        const knee = landmarks[track.knee];
        const hip = landmarks[track.hip];
        if (!isVisible(knee) || !isVisible(hip)) return;

        const key = track.label;
        if (!tracker.legs[key]) {
          tracker.legs[key] = { lifted: false, minY: knee.y };
        }
        const state = tracker.legs[key];

        // Y 越小表示位置越高：膝盖高于髋部才记为抬起
        const lifted = knee.y < hip.y - raiseMargin;

        if (lifted && !state.lifted && tracker.lastLeg !== key) {
          tracker.lastLeg = key;
          countRep();
          tracker.failCount = 0;
        }
        state.lifted = lifted;

        // 记录本次抬腿的最高点
        state.minY = Math.min(state.minY, knee.y);

        // 膝盖明显回落，判定一次抬腿尝试结束
        if (knee.y > state.minY + 0.03) {
          const reached = state.minY < hip.y - raiseMargin;

          if (!reached) {
            tracker.failCount += 1;
            if (tracker.failCount >= 3) {
              tracker.failCount = 0;
              reportCorrection('knees', exercise.correctHint);
            }
          } else {
            tracker.failCount = 0;
          }

          state.minY = knee.y;
        }
      });
    }

    /** 直线姿势检查：肩-髋-踝偏离 180 度超过阈值即纠正 */
    function checkLine(landmarks) {
      if (!exercise.linePoints || !exercise.lineThreshold) return;

      const values = [];
      const left = calcLineDeviation(landmarks, exercise.linePoints);
      if (left !== null) values.push(left);

      if (exercise.linePointsRight) {
        const right = calcLineDeviation(landmarks, exercise.linePointsRight);
        if (right !== null) values.push(right);
      }

      if (!values.length) return;

      // 两侧取偏离更大的一个，避免漏掉明显塌腰
      const deviation = Math.max.apply(null, values);
      if (deviation > exercise.lineThreshold) {
        reportCorrection('line', exercise.lineHint || exercise.correctHint);
      }
    }

    /** 平板支撑：计时 + 每 10 秒播报 */
    function updateHold() {
      const seconds = Math.floor((Date.now() - tracker.holdStartedAt) / 1000);

      if (seconds !== tracker.holdSeconds) {
        tracker.holdSeconds = seconds;
        onReps(seconds, '秒');
      }

      const interval = exercise.announceInterval || 10;
      while (seconds >= tracker.nextAnnounce) {
        speak('坚持' + tracker.nextAnnounce + '秒');
        tracker.nextAnnounce += interval;
      }
    }

    /** Pose 检测结果回调 */
    function handleResults(results) {
      if (!active) return;

      const landmarks = results && results.poseLandmarks;

      // 平板支撑即使暂时没检测到人，也继续计时
      if (exercise.mode === 'hold') {
        updateHold();

        if (!landmarks) {
          clearCanvas();
          onCount(0, 33);
          return;
        }

        draw(landmarks);
        checkLine(landmarks);
        return;
      }

      if (!landmarks) {
        clearCanvas();
        onCount(0, 33);
        return;
      }

      draw(landmarks);

      if (exercise.mode === 'angle') {
        const angle = readBilateralAngle(landmarks, exercise);
        if (angle !== null) {
          // 最近 7 帧移动平均，消除关键点抖动
          updateAngleState(smoothAngle(angle));
        } else {
          // 关键点不可见：暂停计数，并清空平滑历史，避免恢复时沿用旧数据
          tracker.angleHistory.length = 0;
        }
        checkLine(landmarks);
      } else if (exercise.mode === 'distance') {
        const points = readPoints(landmarks, exercise.points);
        if (points) {
          const distance = calcDistance(points[0], points[1]);
          if (distance !== null) updateDistanceState(distance);
        }
      } else if (exercise.mode === 'height') {
        updateHeightState(landmarks);
      } else if (exercise.mode === 'alternating') {
        updateAlternatingState(landmarks);
      }
    }

    /* ======================== 生命周期 ======================== */

    /** 启动摄像头与姿态模型 */
    async function start() {
      if (active) {
        return { ok: false, reason: 'already_running', message: '摄像头已经在运行。' };
      }

      if (!global.Pose || !global.Camera) {
        const message =
          '姿势检测库未加载成功。请确认 libs/mediapipe 目录完整，然后刷新页面。';
        onStatus('error', message);
        return { ok: false, reason: 'library_not_loaded', message: message };
      }

      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        const message =
          '当前浏览器环境无法访问摄像头。请通过本地 HTTP 服务打开页面（例如 python -m http.server）。';
        onStatus('error', message);
        return { ok: false, reason: 'camera_unavailable', message: message };
      }

      onStatus('loading', '正在加载人体姿态模型…');
      lastError = null;

      try {
        if (!pose) {
          pose = new global.Pose({
            locateFile: function (file) {
              return MODEL_BASE_URL + file;
            }
          });

          pose.setOptions({
            // 降回 1 档复杂度以缓解卡顿，平滑与滞回优化仍然保留
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
          });
        }

        pose.onResults(handleResults);

        camera = new global.Camera(video, {
          onFrame: async function () {
            if (!active || !pose || sending) return;

            frameTick += 1;
            // 隔帧检测：奇数帧直接跳过，减少主线程计算压力
            if (frameTick % 2 !== 0) return;

            sending = true;
            try {
              await pose.send({ image: video });
            } catch (error) {
              lastError = error;
              console.error('[posture] pose.send 失败', error);
            } finally {
              sending = false;
            }
          },
          // 摄像头降到 480x360，减少解码与推理开销
          width: 480,
          height: 360
        });

        active = true;

        if (video) {
          video.setAttribute('playsinline', '');
          video.muted = true;
        }

        await camera.start();

        resetTracker();
        hideAlert();
        onStatus('running', '检测中');
        return { ok: true };
      } catch (error) {
        active = false;
        lastError = error;
        await stop();

        const name = error && error.name ? error.name : '';
        let message = '摄像头启动失败，请检查权限与设备。';

        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          message = '摄像头权限被拒绝，请在浏览器地址栏允许摄像头访问后重试。';
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          message = '没有找到可用的摄像头设备。';
        } else if (name === 'NotReadableError') {
          message = '摄像头被其他程序占用，请关闭占用程序后重试。';
        } else if (error && error.message) {
          message = '摄像头启动失败：' + error.message;
        }

        onStatus('error', message);
        return { ok: false, reason: 'start_failed', message: message };
      }
    }

    /** 停止摄像头并清理画面 */
    async function stop() {
      active = false;

      if (camera) {
        try {
          await camera.stop();
        } catch (error) {
          console.warn('[posture] camera.stop 失败', error);
        }
        camera = null;
      }

      if (video && video.srcObject) {
        try {
          video.srcObject.getTracks().forEach(function (track) {
            track.stop();
          });
        } catch (error) {
          console.warn('[posture] 停止视频轨道失败', error);
        }
        video.srcObject = null;
      }

      hideAlert();
      cancelSpeech();
      resetTracker();
      clearCanvas();
      onCount(0, 33);
      onStatus('idle', '已停止');
    }

    /** 切换动作：重置计数、弹窗与语音 */
    function setExercise(idOrName) {
      const config = getExercise(idOrName);
      if (!config) return false;

      exercise = config;
      hideAlert();
      cancelSpeech();
      resetTracker();
      return true;
    }

    function getCurrentExercise() {
      return exercise;
    }

    function isRunning() {
      return active;
    }

    if (alertClose) {
      alertClose.addEventListener('click', hideAlert);
    }

    // 点击全屏遮罩空白处也可以关闭弹窗
    if (alertRoot) {
      alertRoot.addEventListener('click', function (event) {
        if (event.target === alertRoot) hideAlert();
      });
    }

    onReps(0, exercise.mode === 'hold' ? '秒' : '次');

    return {
      start: start,
      stop: stop,
      setExercise: setExercise,
      getExercise: getCurrentExercise,
      isRunning: isRunning,
      getLastError: function () {
        return lastError;
      }
    };
  }

  global.PostureDetector = {
    create: create,
    EXERCISES: EXERCISES,
    getExercise: getExercise,
    POSE_CONNECTIONS: POSE_CONNECTIONS,
    VISIBILITY_THRESHOLD: VISIBILITY_THRESHOLD,
    // 统一语音接口：训练流程与姿势纠正共用
    speak: speakText,
    cancelSpeech: cancelSpeechManager,
    getSpeechDiagnostics: getSpeechDiagnostics,
    getCorrectionStats: getCorrectionStats
  };
})(window);