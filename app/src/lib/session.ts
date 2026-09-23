/**
 * 登录有效期。
 *
 * 一个设备上登录一次就长期有效是方便的 —— 教室里那台一体机尤其需要。
 * 但一直不验证也不合适：**超过 7 天没输过密码，就要求重新登一次**。
 *
 * 注意这里记的是「上次**输密码**的时间」，不是"上次打开"的时间 ——
 * 否则天天用的人永远不会过期，规则就形同虚设。
 */

const KEY = 'shugao.lastAuthAt'
export const AUTH_DAYS = 7

const DAY = 86_400_000

/** 登录成功时调用 */
export function markLogin() {
  try {
    localStorage.setItem(KEY, String(Date.now()))
  } catch {
    /* 隐私模式下存不了，那就永远不过期，总比把教师挡在外面好 */
  }
}

/** 有没有记录过。老设备第一次升级上来时没有这个键 */
export function hasAuthStamp(): boolean {
  try {
    return Boolean(localStorage.getItem(KEY))
  } catch {
    return false
  }
}

export function authExpired(): boolean {
  try {
    const v = Number(localStorage.getItem(KEY) ?? 0)
    // 没有记录 = 从没在这个版本登录过。不把人踢出去，而是从现在开始计时
    if (!v) return false
    return Date.now() - v > AUTH_DAYS * DAY
  } catch {
    return false
  }
}

/** 还剩几天到期（给界面显示用） */
export function authDaysLeft(): number {
  try {
    const v = Number(localStorage.getItem(KEY) ?? 0)
    if (!v) return AUTH_DAYS
    return Math.max(0, Math.ceil((AUTH_DAYS * DAY - (Date.now() - v)) / DAY))
  } catch {
    return AUTH_DAYS
  }
}
