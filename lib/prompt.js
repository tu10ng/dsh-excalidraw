/**
 * What the board tells its own conversation.
 *
 * The text is a system-prompt section, registered only for the session this
 * plugin created: every other conversation in the profile never pays for it.
 * It says what the board is, which tools change it, and — most importantly —
 * that changes are visible to a person who may be drawing at the same time.
 *
 * @module dsh-excalidraw/prompt
 */

/** Full guidance for the board's own session. */
export const BOARD_GUIDANCE = `你坐在一块 Excalidraw 画板旁边，用户正看着同一块画板。

怎么和画板打交道：
- 改图前先用 excalidraw_read 看现有元素和它们的 id；不要凭记忆。
- 用 excalidraw_apply 改图，ops 按顺序执行：
  create {op:"create", element:{type, x, y, width, height, text?, ...}}
  patch  {op:"patch", id, set:{x?, y?, width?, height?, text?, backgroundColor?, ...}}
  delete {op:"delete", id}
  lock   {op:"lock", ids:[...]} / {op:"unlock", ids:[...]}
- 一次事务只改这次需要的元素。面板会把它们锁住并高亮成你的选择，用户此时拖不动它们；
  用户正在拖的元素会被推迟，工具结果里会写 deferred。
- 位置用画板坐标（像素）。新增元素时给彼此留出间距，不要叠在已有元素上；
  要连线就先创建两个元素，再用 arrow 的 x/y/width/height 画在两者之间。
- 需要在对话里留下依据时，用 excalidraw_bind 把元素绑到某条会话事件。

风格：先读再改；改完用一两句话说明改了什么、为什么。不要一次铺满画板。`

/**
 * One-line reminder for sessions that merely have the board tools available
 * (for example the main conversation), so the model knows the board exists.
 */
export const BOARD_HINT = '这个 profile 里有一块画板（侧栏「画板」）。需要画图时用 excalidraw_* 工具，先 excalidraw_read 再改。'

/**
 * Register the sections on the system-prompt service.
 *
 * @param {{ section: Function, context: Function }} systemPrompt
 * @param {{ owns: (agent: object) => boolean }} chat
 * @returns {() => void}
 */
export function registerBoardPrompt(systemPrompt, chat) {
  const disposers = []
  disposers.push(
    systemPrompt.section({
      name: 'dsh-excalidraw:guidance',
      order: 3052,
      interpolate: false,
      text: (context) => (chat.owns(context?.agent) ? BOARD_GUIDANCE : ''),
    }),
    systemPrompt.section({
      name: 'dsh-excalidraw:hint',
      order: 3053,
      interpolate: false,
      text: (context) => (chat.owns(context?.agent) ? '' : BOARD_HINT),
    }),
  )
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* unloading must not throw */
      }
    }
  }
}
