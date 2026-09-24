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

   ⚠️ **必须有复原入口**（原来只进不出）：
   教室一体机是共用的，教师自己的手机/电脑上只要打开过一次 /classroom
   （比如「我的 → 教室端 → 在新标签页打开」），这台设备就一直是教室端，
   之后每次进教师端都被拦去登录页，而界面上**没有任何地方**能看见这件事、
   也没有地方改回来。现在：
     · 角色写入时**记下时间**（`deviceRoleAt`），设置页显示"标记于 …"；
     · 设置页有明确的「改回教师端」（`restoreTeacherDevice`），
       并且**要重新验证教师密码**才放行 —— 权限判断见 Settings.tsx：
       改回教师端 = 拿到教师控制台，所以门槛必须和"重新登录"一样高，
       不能让教室那台机器上的学生随手一点就进教师端。
   ============================================================ */

const ROLE_KEY = 'shugao.deviceRole'
const ROLE_AT_KEY = 'shugao.deviceRoleAt'
export type DeviceRole = 'teacher' | 'classroom'

export function setDeviceRole(r: DeviceRole) {
  try {
    localStorage.setItem(ROLE_KEY, r)
    localStorage.setItem(ROLE_AT_KEY, String(Date.now()))
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

/** 这个角色是什么时候打上的（没记录过就是 null）。给设置页解释"为什么被拦"用 */
export function deviceRoleAt(): number | null {
  try {
    const v = Number(localStorage.getItem(ROLE_AT_KEY) ?? 0)
    return v > 0 ? v : null
  } catch {
    return null
  }
}

/**
 * 把这台设备改回教师端 —— 教师端的复原入口。
 *
 * ⚠️ 调用前必须重新验证教师密码（远程模式走 Supabase 复验），
 * 否则它就等于给教室里的学生开了一道直通教师控制台的门。
 */
export function restoreTeacherDevice() {
  setDeviceRole('teacher')
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
