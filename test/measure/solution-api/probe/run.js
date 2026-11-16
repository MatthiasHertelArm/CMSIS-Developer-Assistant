/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Runs inside VS Code as extension tests: times CMSIS Solution API version 3 against the file and the hidden
// commands. Prints no environment text (it may hold expanded secrets), only lengths and tool names.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const OUT = process.env.PROBE_OUT;
const N = 40;
const now = () => Number(process.hrtime.bigint()) / 1e6;
async function timed(fn) { const t = now(); let ok = true, info; try { info = await fn(); } catch (e) { ok = false; info = String(e && e.message || e).slice(0, 200); } return { ms: now() - t, ok, info }; }
function stats(xs) { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, min: +s[0].toFixed(3), median: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) }; }
async function series(fn) { const ms = []; let fails = 0; for (let i = 0; i < N; i++) { const r = await timed(fn); if (!r.ok) { fails++; } ms.push(r.ms); } return { ...stats(ms), fails }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.run = async function () {
  const result = { started: new Date().toISOString(), vscode: vscode.version, events: [] };
  const log = (e) => { result.events.push({ t: +(now() - t0).toFixed(1), ...e }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); };
  const t0 = now();
  const envExt = vscode.extensions.getExtension('Arm.environment-manager');
  const ext = vscode.extensions.getExtension('Arm.cmsis-csolution');
  log({ what: 'state at start', csolutionActive: ext && ext.isActive, envActive: envExt && envExt.isActive, csolution: ext && ext.packageJSON.version, env: envExt && envExt.packageJSON.version });
  const act = await timed(() => ext.activate());
  log({ what: 'activate CMSIS Solution', ms: act.ms, ok: act.ok });
  const exportsObj = act.ok ? act.info : ext.exports;
  const api = exportsObj.getApi(3);
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const envFile = path.join(ws, '.cmsis', 'tools-environment.yml');
  // Cold: the first call, while Arm Tools may still be activating.
  const envActivating = () => { try { return envExt && envExt.isActive ? 'active' : 'inactive'; } catch { return '?'; } };
  log({ what: 'environment manager before first call', state: envActivating() });
  const cold = await timed(() => api.getToolsEnvironment());
  log({ what: 'getToolsEnvironment cold (first call)', ms: cold.ms, ok: cold.ok, length: cold.ok ? cold.info.length : cold.info });
  const coldTc = await timed(() => api.getToolchains());
  log({ what: 'getToolchains first call', ms: coldTc.ms, ok: coldTc.ok, count: coldTc.ok ? coldTc.info.length : coldTc.info });
  // Wait for the solution to load (getSolutionFile answers), at most 120 s.
  const tl = now(); let solution;
  while (now() - tl < 120000) { try { solution = await api.getSolutionFile(); } catch { solution = undefined; } if (solution) { break; } await sleep(250); }
  log({ what: 'solution loaded', ms: now() - tl, solution: solution ? path.basename(String(solution)) : null });
  // The Environment Manager did not activate the project's vcpkg tools on its own (runs 1-3): ask it, as cmsis_action activate_environment does,
  // and time a getToolsEnvironment issued while that activation runs.
  const manifest = vscode.Uri.file(path.join(ws, 'vcpkg-configuration.json'));
  const ta = now();
  const reactivation = Promise.resolve(vscode.commands.executeCommand('environment-manager.reactivate', manifest)).then(() => now() - ta, (e) => 'failed: ' + String(e && e.message || e).slice(0, 200));
  await sleep(200);
  const during = await timed(() => api.getToolsEnvironment());
  log({ what: 'getToolsEnvironment issued 200 ms into a reactivation', ms: during.ms, ok: during.ok, length: during.ok ? during.info.length : during.info });
  log({ what: 'reactivate command settled', ms: await reactivation });
  // Wait until the Environment Manager registered the project's toolchains (vcpkg), at most 180 s.
  const tr = now(); let toolchains = [];
  while (now() - tr < 180000) { try { toolchains = await api.getToolchains(); } catch { toolchains = []; } if (toolchains.length) { break; } await sleep(500); }
  log({ what: 'toolchains registered', ms: now() - tr, count: toolchains.length, names: toolchains.map((t) => t.name + ' ' + t.version), envActive: envExt && envExt.isActive });
  await sleep(2000);
  const shape = (text) => ({ length: text.length, tools: (text.match(/^\s*- name: (.+)$/gm) || []).map((l) => l.replace(/^\s*- name: /, '')), pathEntries: ((text.split('path:')[1] || '').split('variables:')[0].match(/^\s*- /gm) || []).length });
  const warm = {
    'API getToolsEnvironment': await series(() => api.getToolsEnvironment()),
    'API getToolchains': await series(() => api.getToolchains()),
    'file read tools-environment.yml': fs.existsSync(envFile) ? await series(() => fs.promises.readFile(envFile, 'utf8')) : 'no file',
    'file read sync tools-environment.yml': fs.existsSync(envFile) ? await series(() => fs.readFileSync(envFile, 'utf8')) : 'no file',
    'API getCbuildRunFile': await series(() => api.getCbuildRunFile()),
    'command cmsis-csolution.getCbuildRunFile': await series(() => vscode.commands.executeCommand('cmsis-csolution.getCbuildRunFile')),
    'API getActiveTarget': await series(() => api.getActiveTarget()),
    'command cmsis-csolution.getActiveTargetSet': await series(() => vscode.commands.executeCommand('cmsis-csolution.getActiveTargetSet')),
    'API getTargets': await series(() => api.getTargets()),
    'API getDebuggers': await series(() => api.getDebuggers()),
  };
  result.warm = warm;
  // Same content? Compare the API's text with the file, without printing either (secrets may be expanded).
  try { const a = await api.getToolsEnvironment(); const f = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : undefined; result.sameAsFile = f === undefined ? 'no file' : a === f; result.api = shape(a); result.file = f && shape(f); } catch (e) { result.sameAsFile = String(e); }
  log({ what: 'done' });
};
