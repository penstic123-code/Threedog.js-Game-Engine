// Desktop icon for the hub (Windows only): double-click starts `node hub.mjs` in a minimized console, closing that window stops the hub.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON = join(HERE, 'threedog.ico');
const LNK = 'threedog.lnk';

// Pure decision. A differing target (a deleted or other copy) is retargeted instead of trusted, so a stale icon never blocks start.
export function shortcutPlan(platform, { current, node, script }) {
  const target = node, args = `"${script}"`, icon = ICON;
  if (platform !== 'win32') return { action: 'unsupported', target, args, icon };
  // `npx threedog hub` runs a throwaway copy that npm clears later: an icon pointing there would break, so none is made or moved to it
  if (/[\\/]_npx[\\/]/.test(script)) return { action: 'none', target, args, icon, message: 'running from an npx copy: install threedog and @threedog/tools in a project (npm install threedog@1 && npm install -D @threedog/tools@1) or globally, then run threedog hub --shortcut' };
  if (!current) return { action: 'create', target, args, icon };
  const norm = (p) => String(p ?? '').replaceAll('/', String.fromCharCode(92)).toLowerCase();
  const same = (a, b) => norm(a) === norm(b);
  return { action: same(current.target, target) && same(current.args, args) ? 'none' : 'retarget', target, args, icon };
}

// Values travel as env vars and the script as -EncodedCommand (UTF-16LE base64): no quoting, Chinese paths survive.
function ps(body, env) {
  const encoded = Buffer.from('[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";' + body, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
}

export function ensureShortcut({ onlyIfPresent = false, script = join(HERE, '..', 'hub.mjs') } = {}) {
  if (process.platform !== 'win32') return { action: 'unsupported', message: 'run: npx threedog hub' };
  try {
    const desktop = ps('[Environment]::GetFolderPath("Desktop")', {});
    const path = join(desktop, LNK);
    const raw = ps('if(Test-Path -LiteralPath $env:TD_LNK){$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:TD_LNK);ConvertTo-Json @{target=$s.TargetPath;args=$s.Arguments}}', { TD_LNK: path });
    const current = raw ? JSON.parse(raw) : null;
    const plan = shortcutPlan('win32', { current, node: process.execPath, script });
    if (plan.action === 'none') return { action: 'none', path, message: plan.message ?? 'desktop icon already points here' };
    if (plan.action === 'create' && onlyIfPresent) return { action: 'none', path, message: 'no desktop icon; run: threedog hub --shortcut' };
    ps('$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:TD_LNK);$s.TargetPath=$env:TD_TARGET;$s.Arguments=$env:TD_ARGS;$s.WindowStyle=7;$s.IconLocation=$env:TD_ICON;$s.WorkingDirectory=$env:TD_HOME;$s.Save()',
      { TD_LNK: path, TD_TARGET: plan.target, TD_ARGS: plan.args, TD_ICON: plan.icon, TD_HOME: homedir() });
    return { action: plan.action, path, message: `desktop icon ${plan.action === 'create' ? 'created' : 'retargeted'}: ${path}` };
  } catch (e) {
    return { action: 'none', message: `desktop icon failed: ${String(e.message).split('\n')[0]}` };
  }
}
