#!/usr/bin/env node
/**
 * install-diary-plugin.mjs —— 把 plugins/dsh-diary 装进指定 profile（默认 desktop）。
 *
 * 干四件事，全部幂等、写前备份：
 *   1. 在 profile/node_modules 下建指向本仓库的 junction（Windows 免管理员）；
 *   2. profile/package.json：加 `link:` 依赖 + 把包名加进 dsh.profile.bundles；
 *   3. profile/cordis.patch.yml：插入一条 `id: dsh-diary` 的行，config.root 写成本仓库路径；
 *   4. 打印下一步（完全退出 DSH 再打开）。
 *
 * 为什么不用 `dsh plugin add`：那是 pnpm 安装流程，要求 DSH 完全退出且会碰 lockfile；
 * 本仓库的插件是 **link:** 依赖（setup-dsh.mjs 也是这么装的），用 junction 更轻、可回滚。
 *
 * 用法：
 *   node scripts/install-diary-plugin.mjs            # 装到 desktop
 *   node scripts/install-diary-plugin.mjs web        # 装到 web
 *   node scripts/install-diary-plugin.mjs desktop --check   # 只检查，不写
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugins', 'dsh-diary');
const PACKAGE_NAME = 'dsh-diary';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const PROFILE = args.find((a) => !a.startsWith('--')) || 'desktop';

function log(line) {
  console.log(`[install-diary] ${line}`);
}

function fail(message) {
  console.error(`[install-diary] ERROR: ${message}`);
  process.exit(1);
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function stamp() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backup(file) {
  if (!exists(file)) return null;
  const dest = `${file}.bak-${stamp()}`;
  fs.copyFileSync(file, dest);
  // 保留最近 5 份，别把 profile 目录塞满（这是本脚本自己的备份，不是日记）
  const dir = path.dirname(file);
  const base = path.basename(file);
  const olds = fs.readdirSync(dir)
    .filter((n) => n.startsWith(`${base}.bak-`))
    .sort()
    .reverse();
  for (const name of olds.slice(5)) {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
  return dest;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ── 0. 校验插件包 ────────────────────────────────────────────────────────────
{
  const pkgFile = path.join(PLUGIN_DIR, 'package.json');
  if (!exists(pkgFile)) fail(`插件目录不完整：${PLUGIN_DIR}`);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (pkg.name !== PACKAGE_NAME) fail(`package.json 的 name 是 ${pkg.name}，期望 ${PACKAGE_NAME}`);
  for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', path.join('lib', 'router.js')]) {
    if (!exists(path.join(PLUGIN_DIR, rel))) fail(`插件缺少文件：${rel}`);
  }
  if (!pkg.dsh?.bundle?.patch) fail('package.json 缺少 dsh.bundle.patch（插件管理器会拒绝安装）');
  if (!pkg.dsh?.client?.platform) fail('package.json 缺少 dsh.client.platform（客户端半不会被加载）');
}

const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
if (!exists(profileDir)) fail(`profile 不存在：${profileDir}`);

// ── 1. junction ──────────────────────────────────────────────────────────────
function ensureDirLink(linkPath, targetDir) {
  const resolvedTarget = fs.realpathSync(targetDir);
  let stat = null;
  try { stat = fs.lstatSync(linkPath); } catch {}
  if (stat) {
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      let current = null;
      try { current = fs.realpathSync(linkPath); } catch {}
      if (current === resolvedTarget) {
        log(`链接已存在且指向本仓库：${linkPath}`);
        return;
      }
      if (checkOnly) fail(`链接指向别处：${linkPath} -> ${current}`);
      fs.rmSync(linkPath, { recursive: true, force: true });
    } else {
      fail(`目标已存在且不是目录/链接：${linkPath}`);
    }
  }
  if (checkOnly) fail(`缺少链接：${linkPath}`);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(resolvedTarget, linkPath, 'junction');
  log(`已创建链接：${linkPath} -> ${resolvedTarget}`);
}

ensureDirLink(path.join(profileDir, 'node_modules', PACKAGE_NAME), PLUGIN_DIR);

// ── 2. profile/package.json ──────────────────────────────────────────────────
{
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = exists(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')) : { name: `dsh-profile-${PROFILE}`, private: true };
  if (!pkg.dsh) pkg.dsh = {};
  if (!pkg.dsh.profile) pkg.dsh.profile = {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  if (!pkg.dependencies) pkg.dependencies = {};

  const linkSpec = `link:${PLUGIN_DIR.split(path.sep).join('/')}`;
  let changed = false;
  if (pkg.dependencies[PACKAGE_NAME] !== linkSpec) {
    pkg.dependencies[PACKAGE_NAME] = linkSpec;
    changed = true;
  }
  if (!pkg.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    pkg.dsh.profile.bundles.push(PACKAGE_NAME);
    changed = true;
  }
  if (changed) {
    if (checkOnly) fail(`profile/package.json 还没登记 ${PACKAGE_NAME}`);
    backup(pkgFile);
    writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    log(`profile/package.json 已更新（依赖 ${linkSpec} + bundle 登记）`);
  } else {
    log('profile/package.json 已是目标状态');
  }
}

// ── 3. cordis.patch.yml ─────────────────────────────────────────────────────
//
// 用**文本追加**而不是 YAML 全量重排：这个文件里有 setup-dsh 维护的注释块，
// 重新 dump 会把注释丢掉。同时按 `id: dsh-diary` 判重（哪怕注释被别的脚本冲掉也能认出来）。
{
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = exists(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  // 数据根：如果仓库的上一级就有 `日记/` 与 `日记-私密/`（本机的 <数据根> 就是这种布局），
  // 就把它当数据根——这样面板的作用范围是"整个大目录"，而不是被锁在 qqbot 里。
  // 项目根永远是本仓库（config.json + src/diary-core.js 在这里）。
  const parent = path.dirname(REPO_ROOT);
  const parentIsDataRoot = ['日记', '日记-私密'].every((d) => exists(path.join(parent, d)));
  const dataRoot = parentIsDataRoot ? parent : REPO_ROOT;
  const toYaml = (p) => p.split(path.sep).join('\\').replace(/'/g, "''");
  log(`作用范围：root=${dataRoot} / project=${REPO_ROOT}`);

  const has = /id:\s*['"]?dsh-diary['"]?/.test(original);
  const beginMark = '# === dsh-diary 日记面板 BEGIN ===';
  const endMark = '# === dsh-diary 日记面板 END ===';
  const block = [
    beginMark,
    '# 由 scripts/install-diary-plugin.mjs 维护；这段区块可以整体删掉再重跑本脚本。',
    '- insert:',
    '    - id: dsh-diary',
    `      name: '${PACKAGE_NAME}'`,
    '      config:',
    `        root: '${toYaml(dataRoot)}'`,
    `        project: '${toYaml(REPO_ROOT)}'`,
    endMark,
    ''
  ].join('\n');

  if (original.includes(beginMark) && original.includes(endMark)) {
    // 受管区块：内容一致就什么都不做；不一致才替换（配置改了要能更新，不然"重装"只是原地踏步）
    const currentBlock = new RegExp(`${beginMark}[\\s\\S]*?${endMark}\\n?`).exec(original)?.[0] ?? '';
    if (currentBlock.trim() === block.trim()) {
      log('cordis.patch.yml 的 dsh-diary 区块已是最新（root/project 一致）');
    } else if (checkOnly) {
      fail('cordis.patch.yml 的 dsh-diary 区块与当前脚本算出的 root/project 不一致');
    } else {
      backup(patchFile);
      const next = original.replace(new RegExp(`${beginMark}[\\s\\S]*?${endMark}\\n?`), block);
      writeFile(patchFile, next.replace(/\s*$/, '\n'));
      log('cordis.patch.yml 的 dsh-diary 区块已刷新（root/project）');
    }
  } else if (has) {
    log('cordis.patch.yml 里已有 dsh-diary 条目（不是本脚本的受管区块），跳过；root/project 请在 profile 里自己改');
  } else {
    if (checkOnly) fail('cordis.patch.yml 里还没有 dsh-diary 条目');
    if (original) backup(patchFile);
    writeFile(patchFile, `${original.replace(/\s*$/, '')}\n\n${block}`);
    log('cordis.patch.yml 已追加 dsh-diary 条目');
  }
}

log('Done.');
if (!checkOnly) {
  log('下一步：**完全退出 DSH 再打开**（client 半要重新加载），然后在 设置 → 日记 里查看。');
  log('回滚：删 profile 里的 junction、package.json 的 dsh-diary 依赖与 bundle、cordis.patch.yml 的这段区块，重开 DSH。');
}
