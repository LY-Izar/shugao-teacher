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

/* ============================================================
   本机角色：这台设备是「教室端」还是「教师端」
   ------------------------------------------------------------
   为什么需要：教室端和教师端**用的是同一个账号**，学生在教室里
   把网址后缀一改（/classroom → /）就进了教师控制台，能看到全班成绩、
   还能改数据。

   这一层拦的是**"改网址"这个实际操作**：教室端登录进来的设备，
   访问教师端必须重新输一次教师密码。

   ⚠️ 这只是客户端拦截，**不是加密级的安全**：懂开发者工具的学生
   可以改 localStorage 绕过去。真正的隔离要让教室端用**独立账号**，
   并在数据库层面（RLS）禁止它改成绩与名单 —— 那是单独立项的架构改动。
   ============================================================ */

const ROLE_KEY = 'shugao.deviceRole'
export type DeviceRole = 'teacher' | 'classroom'

export function setDeviceRole(r: DeviceRole) {
  try {
    localStorage.setItem(ROLE_KEY, r)
  } catch {
    /* 忽略 */
  }
}

export function deviceRole(): DeviceRole {
  try {
    return localStorage.getItem(ROLE_KEY) === 'classroom' ? 'classroom' : 'teacher'
  } catch {
    return 'teacher'
  }
}

/** 这台设备是被当作教室端用的 —— 进教师端要重新验证 */
export function isClassroomDevice(): boolean {
  return deviceRole() === 'classroom'
}

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
