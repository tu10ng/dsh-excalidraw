/**
 * Panel copy. Two languages, flat keys, no interpolation beyond `{name}` —
 * every string a person reads in this panel goes through `translate`.
 *
 * @module dsh-excalidraw/client/i18n
 */

export const DICTS = {
  zh: {
    'panel.title': '画板',
    'panel.loading': '正在加载画板…',
    'panel.error': '画板出错了：{message}',
    'panel.retry': '重试',
    'panel.offline': '未连接',
    'panel.live': '已连接',
    'panel.rev': 'rev {rev}',
    'panel.empty': '画板是空的。让助手画点什么，或把右侧的事件拖进来。',
    'panel.held': 'DSH 正在改 {count} 个元素',
    'panel.release': '收回',
    'panel.released': '已收回控制权',
    'panel.fit': '适配画面',
    'panel.rail': '事件',
    'panel.railHide': '收起事件',
    'panel.sideHide': '收起侧栏',
    'panel.sideShow': 'AI 侧栏',
    'side.chat': '对话',
    'side.events': '事件',
    'side.collapse': '收起侧栏',
    'side.expand': '展开侧栏',
    'side.split': '拖动调整侧栏宽度',
    'chat.title': 'AI 对话',
    'chat.loading': '正在准备画板对话…',
    'chat.connecting': '正在连接对话…',
    'chat.error': '对话不可用：{message}',
    'chat.unavailable': '当前宿主不支持内嵌对话；画板工具仍然可以在主对话里使用。',
    'chat.reset': '新对话',
    'chat.resetHint': '换一个新会话，旧会话仍留在侧边栏里',
    'panel.follow': '跟随事件',
    'panel.followOn': '跟随中',
    'panel.conflict': '画板版本冲突，已重新同步',
    'panel.saveFailed': '保存失败：{message}',
    'panel.txDeferred': '{count} 个元素你正在操作，松手后应用',
    'panel.txFailed': '助手改动未生效：{message}',
    'rail.title': '事件流',
    'rail.empty': '还没有事件。对话一开始，这里就会出现。',
    'rail.minor': '显示细节',
    'rail.minorHide': '隐藏细节',
    'rail.add': '放到画板',
    'rail.locate': '定位',
    'rail.open': '打开会话',
    'rail.all': '全部会话',
    'rail.session': '本会话',
    'rail.failed': '失败',
    'rail.now': '刚刚',
    'rail.bound': '画板上有 {count} 处',
    'rail.notOnBoard': '画板上还没有这条事件',
    'binding.title': '绑定的事件',
    'binding.open': '打开会话',
    'binding.locate': '定位',
    'binding.none': '选中一个画板元素查看它的绑定',
    'action.addAtCenter': '已放到画面中央',
  },
  en: {
    'panel.title': 'Canvas',
    'panel.loading': 'Loading the board…',
    'panel.error': 'The board failed: {message}',
    'panel.retry': 'Retry',
    'panel.offline': 'Offline',
    'panel.live': 'Live',
    'panel.rev': 'rev {rev}',
    'panel.empty': 'The board is empty. Ask the assistant to draw, or drag an event in.',
    'panel.held': 'DSH is editing {count} element(s)',
    'panel.release': 'Take back',
    'panel.released': 'Control handed back',
    'panel.fit': 'Fit to content',
    'panel.rail': 'Events',
    'panel.railHide': 'Hide events',
    'panel.sideHide': 'Hide panel',
    'panel.sideShow': 'AI panel',
    'side.chat': 'Chat',
    'side.events': 'Events',
    'side.collapse': 'Hide panel',
    'side.expand': 'Show panel',
    'side.split': 'Drag to resize the panel',
    'chat.title': 'AI chat',
    'chat.loading': 'Preparing the board conversation…',
    'chat.connecting': 'Connecting the conversation…',
    'chat.error': 'The conversation is unavailable: {message}',
    'chat.unavailable': 'This Host cannot embed a conversation; the board tools still work from the main chat.',
    'chat.reset': 'New chat',
    'chat.resetHint': 'Start a new session; the old one stays in the sidebar',
    'panel.follow': 'Follow events',
    'panel.followOn': 'Following',
    'panel.conflict': 'Board moved on; resynchronized',
    'panel.saveFailed': 'Save failed: {message}',
    'panel.txDeferred': '{count} element(s) are under your hand; applying when you let go',
    'panel.txFailed': 'The assistant change did not land: {message}',
    'rail.title': 'Event stream',
    'rail.empty': 'No events yet. They appear here as soon as the conversation starts.',
    'rail.minor': 'Show details',
    'rail.minorHide': 'Hide details',
    'rail.add': 'Put on board',
    'rail.locate': 'Locate',
    'rail.open': 'Open conversation',
    'rail.all': 'All sessions',
    'rail.session': 'This session',
    'rail.failed': 'failed',
    'rail.now': 'now',
    'rail.bound': '{count} on the board',
    'rail.notOnBoard': 'That event is not on the board yet',
    'binding.title': 'Bound event',
    'binding.open': 'Open conversation',
    'binding.locate': 'Locate',
    'binding.none': 'Select one board element to see what it is bound to',
    'action.addAtCenter': 'Placed at the center of the view',
  },
}

/** The panel's active language, from the Host locale unless it is neither zh nor en. */
export function resolveLang(ctx) {
  try {
    const snapshot = ctx?.locale?.getLocale?.() ?? ctx?.locale?.getSnapshot?.()
    const id = snapshot?.active ?? snapshot?.id ?? snapshot?.locale ?? 'en'
    return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/** @param {'zh'|'en'} lang */
export function translator(lang) {
  const dict = DICTS[lang] ?? DICTS.en
  return (key, vars) => {
    const template = dict[key] ?? DICTS.en[key] ?? key
    if (vars === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
  }
}
