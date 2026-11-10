// Settings menu text (Chinese, English) and layout CSS.
// CSS uses only var(--threedog-*) variables, no colors or fonts; a game overrides these classes with ui.css.

export const STRINGS = {
  'zh-CN': {
    'settings.title': '设置', 'settings.action': '菜单', 'title.settings': '设置', 'module.settings': '设置',
    'settings.graphics': '画质', 'settings.audio': '声音', 'settings.controls': '按键', 'settings.language': '语言',
    'settings.quality': '画质预设', 'settings.quality.low': '低', 'settings.quality.medium': '中', 'settings.quality.high': '高', 'settings.quality.custom': '自定义',
    'settings.pixelRatio': '渲染精度', 'settings.shadows': '阴影', 'settings.antialias': '抗锯齿', 'settings.nextStart': '抗锯齿的改动下次启动时生效', 'settings.bloom': '泛光', 'settings.ao': '环境光遮蔽',
    'settings.adaptive': '自动分辨率', 'settings.viewDistance': '视距', 'settings.density': '植被密度',
    'settings.vol.master': '总音量', 'settings.vol.music': '音乐', 'settings.vol.sfx': '音效', 'settings.vol.ambience': '环境音', 'settings.vol.ui': '界面音',
    'settings.pressKey': '请按一个键…', 'settings.unbound': '未绑定', 'settings.rebindHint': '点击按键后按下新键，Esc 取消。',
    'settings.resetKeys': '恢复默认按键',
    'settings.saves': '存档', 'settings.exportSave': '导出存档', 'settings.importSave': '导入存档', 'settings.noSaves': '还没有存档。',
    'settings.saveHint': '导出会下载一个 .json 文件（含附件，如照片）；换设备或浏览器数据丢失后，用"导入存档"恢复。',
    'settings.langName.zh-CN': '简体中文', 'settings.langName.en': 'English',
    'settings.game': '游戏', 'settings.resume': '继续游戏', 'settings.load': '读档', 'settings.toTitle': '回到标题',
    'settings.camera': '镜头', 'settings.sensitivity': '鼠标灵敏度', 'settings.invertY': '反转 Y 轴', 'settings.fov': '视野',
    'settings.options': '选项',
  },
  en: {
    'title.settings': 'Settings', 'module.settings': 'settings',
    'settings.title': 'Settings', 'settings.action': 'Menu',
    'settings.graphics': 'Graphics', 'settings.audio': 'Audio', 'settings.controls': 'Controls', 'settings.language': 'Language',
    'settings.quality': 'Quality preset', 'settings.quality.low': 'Low', 'settings.quality.medium': 'Medium', 'settings.quality.high': 'High', 'settings.quality.custom': 'Custom',
    'settings.pixelRatio': 'Render scale', 'settings.shadows': 'Shadows', 'settings.antialias': 'Anti-aliasing', 'settings.nextStart': 'The anti-aliasing change applies the next time the game starts', 'settings.bloom': 'Bloom', 'settings.ao': 'Ambient occlusion',
    'settings.adaptive': 'Adaptive resolution', 'settings.viewDistance': 'View distance', 'settings.density': 'Vegetation density',
    'settings.vol.master': 'Master volume', 'settings.vol.music': 'Music', 'settings.vol.sfx': 'Sound effects', 'settings.vol.ambience': 'Ambience', 'settings.vol.ui': 'Interface',
    'settings.pressKey': 'Press a key…', 'settings.unbound': 'Unbound', 'settings.rebindHint': 'Click a key, then press the new one. Esc cancels.',
    'settings.resetKeys': 'Reset to defaults',
    'settings.saves': 'Saves', 'settings.exportSave': 'Export save', 'settings.importSave': 'Import save', 'settings.noSaves': 'No saves yet.',
    'settings.saveHint': 'Export downloads a .json file (attachments such as photos included). Use "Import save" to restore it on another device or after browser data is lost.',
    'settings.langName.zh-CN': '简体中文', 'settings.langName.en': 'English',
    'settings.game': 'Game', 'settings.resume': 'Resume', 'settings.load': 'Load', 'settings.toTitle': 'Back to title',
    'settings.camera': 'Camera', 'settings.sensitivity': 'Mouse sensitivity', 'settings.invertY': 'Invert Y', 'settings.fov': 'Field of view',
    'settings.options': 'Options',
  },
};

export const CSS = `
.threedog-win-settings{box-sizing:border-box;width:min(560px,calc(100% - 32px));max-height:min(80%,640px)}
.threedog-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px;padding-bottom:10px;border-bottom:1px solid var(--threedog-line)}
.threedog-tab.is-active,.threedog-seg .threedog-btn.is-active,.threedog-set-toggle.is-active{border-color:var(--threedog-accent);color:var(--threedog-accent)}
.threedog-set-row{justify-content:space-between;flex-wrap:wrap;min-height:36px}
.threedog-set-label{flex:1 1 140px;min-width:0}
.threedog-set-ctl{display:flex;align-items:center;gap:8px;flex:0 1 auto;justify-content:flex-end;flex-wrap:wrap}
.threedog-seg{display:inline-flex;flex-wrap:wrap;gap:4px}
.threedog-seg .threedog-btn:disabled{opacity:.5;cursor:default}
.threedog-range{width:min(180px,40%);accent-color:var(--threedog-accent)}
.threedog-set-val{min-width:3.6em;text-align:right;font-variant-numeric:tabular-nums;color:var(--threedog-muted);font-size:12px}
.threedog-key{min-width:72px;font-variant-numeric:tabular-nums}
.threedog-key.is-waiting{border-color:var(--threedog-accent);color:var(--threedog-accent)}
.threedog-key.is-conflict{border-style:dashed}
.threedog-set-note{color:var(--threedog-muted);font-size:12px;margin:8px 0}
.threedog-set-foot{display:flex;justify-content:flex-end;margin-top:8px}
`;
