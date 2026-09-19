/* ============================================================
   教室端发声：提示音 + 中文语音合成
   不依赖任何音频素材，也不需要装任何东西 —— 用系统 TTS。
   ============================================================ */

let audioCtx: AudioContext | null = null

/** 「叮咚」两音提示 —— 播报前先响，避免被当成背景音忽略 */
export function chime() {
  try {
    audioCtx ??= new AudioContext()
    const ctx = audioCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    const notes = [
      { f: 988, at: 0 },
      { f: 1319, at: 0.17 },
    ]
    for (const n of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = n.f
      const start = t0 + n.at
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.6)
    }
  } catch {
    /* 音频不可用就静默跳过，不影响播报流程 */
  }
}

/** 浏览器需要一次用户交互才允许出声 */
export function unlockAudio() {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    // 用一句空话把 speechSynthesis 也唤醒
    const u = new SpeechSynthesisUtterance('')
    speechSynthesis.speak(u)
  } catch {
    /* 忽略 */
  }
}

let cachedVoice: SpeechSynthesisVoice | null = null

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice
  const voices = speechSynthesis.getVoices()
  if (!voices.length) return null
  cachedVoice =
    voices.find((v) => /zh[-_]CN/i.test(v.lang) && /Xiaoxiao|Yunxi|Huihui|Kangkang/i.test(v.name)) ??
    voices.find((v) => /zh[-_]CN/i.test(v.lang)) ??
    voices.find((v) => /^zh/i.test(v.lang)) ??
    null
  return cachedVoice
}

// 语音列表是异步加载的，先预热一次
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = () => {
    cachedVoice = null
    pickVoice()
  }
}

export function speak(text: string, opts?: { rate?: number; onEnd?: () => void }) {
  try {
    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice()
    if (v) u.voice = v
    u.lang = 'zh-CN'
    u.rate = opts?.rate ?? 0.92
    u.pitch = 1
    u.volume = 1
    if (opts?.onEnd) u.onend = opts.onEnd
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  } catch {
    opts?.onEnd?.()
  }
}

export function stopSpeaking() {
  try {
    speechSynthesis.cancel()
  } catch {
    /* 忽略 */
  }
}
