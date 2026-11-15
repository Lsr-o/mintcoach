/**
 * ============================================================================
 * js/storage.js —— 统一数据存储层（多用户隔离）
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 当前用户 ID 存在 localStorage 的 currentUserId
 *   2. 用户档案列表存在 users（数组）
 *   3. 其余数据按「当前用户」加前缀隔离：u:<userId>:<key>
 *      —— 训练计划、打卡、复盘、饮食记录、日历数据全部走这一层
 *
 * 说明：localStorage 不可用（无痕模式 / 配额满）时静默降级，
 *       页面仍可运行，只是刷新后数据不保留。
 * ============================================================================
 */
(function (global) {
  'use strict';

  const App = (global.FitnessApp = global.FitnessApp || {});

  /** 当前用户 ID 的存储键 */
  const CURRENT_USER_KEY = 'currentUserId';
  /** 用户档案列表的存储键 */
  const USERS_KEY = 'users';
  /** 单用户数据键前缀 */
  const USER_PREFIX = 'u:';

  /** 安全读取 JSON */
  function readJSON(key, fallback) {
    try {
      const raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  /** 安全写入 JSON */
  function writeJSON(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  /** 读取当前用户 ID，未登录返回空串 */
  function getCurrentUserId() {
    try {
      return global.localStorage.getItem(CURRENT_USER_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  /** 设置当前用户 ID；传空则清除 */
  function setCurrentUserId(id) {
    const text = String(id || '');
    try {
      if (text) global.localStorage.setItem(CURRENT_USER_KEY, text);
      else global.localStorage.removeItem(CURRENT_USER_KEY);
    } catch (error) {
      /* 忽略存储失败 */
    }
  }

  /** 读取用户档案列表 */
  function getUsers() {
    const list = readJSON(USERS_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  /** 保存用户档案列表 */
  function saveUsers(list) {
    return writeJSON(USERS_KEY, Array.isArray(list) ? list : []);
  }

  /** 当前用户档案（不存在时返回 null） */
  function currentUser() {
    const id = getCurrentUserId();
    if (!id) return null;
    return (
      getUsers().find(function (user) {
        return user.id === id;
      }) || null
    );
  }

  /** 按当前用户拼接真实存储键：u:<id>:<key> */
  function scopedKey(key) {
    const id = getCurrentUserId();
    return id ? USER_PREFIX + id + ':' + key : 'guest:' + key;
  }

  /** 读取当前用户的数据 */
  function getData(key, fallback) {
    return readJSON(scopedKey(key), fallback === undefined ? null : fallback);
  }

  /** 写入当前用户的数据 */
  function saveData(key, value) {
    return writeJSON(scopedKey(key), value);
  }

  /** 删除当前用户的数据 */
  function removeData(key) {
    try {
      global.localStorage.removeItem(scopedKey(key));
    } catch (error) {
      /* 忽略存储失败 */
    }
  }

  /** 删除指定用户的全部数据（按前缀 u:<userId>: 清理） */
  function removeUserData(userId) {
    try {
      const prefix = USER_PREFIX + userId + ':';
      Object.keys(global.localStorage).forEach(function (key) {
        if (key.indexOf(prefix) === 0) {
          global.localStorage.removeItem(key);
        }
      });
    } catch (error) {
      /* 忽略存储失败 */
    }
  }

  /** 生成一个新的用户 ID */
  function createUserId() {
    return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  App.storage = {
    CURRENT_USER_KEY: CURRENT_USER_KEY,
    USERS_KEY: USERS_KEY,
    getCurrentUserId: getCurrentUserId,
    setCurrentUserId: setCurrentUserId,
    getUsers: getUsers,
    saveUsers: saveUsers,
    currentUser: currentUser,
    getData: getData,
    saveData: saveData,
    removeData: removeData,
    removeUserData: removeUserData,
    createUserId: createUserId
  };
})(window);