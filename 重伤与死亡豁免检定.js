// ==UserScript==
// @name         重伤与死亡豁免检定
// @author       MYRIAD
// @version      1.0.0
// @description  CoC7th 重伤/轻伤判定提醒：监听 .st hp-n 扣血，自动判定重伤（含一次避免昏迷的体质检定）并在生命值归零时区分濒死/昏迷。
// @timestamp    1751000000
// @license      MIT
// ==/UserScript==

(() => {
  if (seal.ext.find('wound&death')) return;

  const ext = seal.ext.new('wound&death', 'MYRIAD', '2.0.0');
  seal.ext.register(ext);

  // ---------------------------------------------------------------------------
  // 可在 WebUI 修改的提示文案（占位符见各项默认值；不会经过骰子变量解析）
  //   通用占位符：{name} 角色名  {dmg} 本次伤害  {half} 上限一半  {hp} 当前生命  {hpmax} 生命上限
  //   避免昏迷检定额外占位符：{roll} 骰值  {con} 体质值  {level} 成功等级  {result} 清醒/昏迷文案
  // ---------------------------------------------------------------------------
  seal.ext.registerStringConfig(ext, '重伤提示',
    '{name} 受到 {dmg} 点伤害（≥上限一半 {half}）→ 重伤！角色立刻倒地，重伤栏已标记。');
  seal.ext.registerStringConfig(ext, '避免昏迷检定提示',
    '避免昏迷的体质检定 d100={roll}/{con} {level} → {result}');
  seal.ext.registerStringConfig(ext, '避免昏迷-清醒文案', '保持清醒');
  seal.ext.registerStringConfig(ext, '避免昏迷-昏迷文案', '陷入昏迷');
  seal.ext.registerStringConfig(ext, '濒死提示',
    '重伤栏已标记且生命值归零 → 濒死，角色立刻昏迷！\n' +
    '从下一轮结束起，每轮结束投一次 .ra 体质，任意一次失败即死亡。\n' +
    '只有急救能稳定伤势，稳定后才能使用医学治疗。\n' +
    '急救稳定后获得1点临时生命，需每小时投 .ra 体质；失败则重回濒死。\n' +
    '医学治疗成功后，请用 .wound clear major 擦除重伤栏并恢复 1D3 生命。');
  seal.ext.registerStringConfig(ext, '轻伤昏迷提示',
    '{name} 受到 {dmg} 点伤害，生命值归零 → 昏迷（仅轻伤，不会因此死亡）。');

  function fill(tpl, map) {
    return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
  }

  // 工具函数
  function readAttr(ctx, names) {
    for (const n of names) {
      const v = parseInt(seal.format(ctx, `{${n}}`));
      if (!isNaN(v)) return v;
    }
    return NaN;
  }

  function readHp(ctx) { return readAttr(ctx, ['hp', '生命值', '生命']); }
  function readHpMax(ctx) { return readAttr(ctx, ['hpmax', '生命值上限', '最大生命值']); }
  function readCon(ctx) { return readAttr(ctx, ['con', '体质', 'CON']); }

  // d100 体质检定（仅用于重伤时“避免昏迷”这一次自动检定）
  // CoC7 大成功=1；大失败：技能<50 时 96-100，否则 100
  function conCheck(con) {
    const roll = Math.floor(Math.random() * 100) + 1;
    let level, success;
    if (roll === 1) { level = '大成功'; success = true; }
    else if (roll <= Math.floor(con / 5)) { level = '极难成功'; success = true; }
    else if (roll <= Math.floor(con / 2)) { level = '困难成功'; success = true; }
    else if (roll <= con) { level = '成功'; success = true; }
    else if (roll === 100 || (con < 50 && roll >= 96)) { level = '大失败'; success = false; }
    else { level = '失败'; success = false; }
    return { roll, con, level, success };
  }

  // ---------------------------------------------------------------------------
  // 每角色状态
  //   major: 重伤栏是否已标记
  //   dying: 是否处于濒死
  // ---------------------------------------------------------------------------

  function stateKey(ctx) {
    const gid = (ctx.group && ctx.group.groupId) ? ctx.group.groupId : 'private';
    return `state:${gid}:${ctx.player.userId}`;
  }
  function blank() { return { major: false, dying: false }; }
  function getState(ctx) {
    try {
      const raw = ext.storageGet(stateKey(ctx));
      if (raw) return Object.assign(blank(), JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return blank();
  }
  function setState(ctx, st) { ext.storageSet(stateKey(ctx), JSON.stringify(st)); }

  function statusLine(ctx, st) {
    const hp = readHp(ctx), hpmax = readHpMax(ctx);
    const tags = [];
    if (st.dying) tags.push('濒死');
    if (st.major) tags.push('重伤栏已标记');
    const flag = tags.length ? tags.join('、') : '无重伤标记';
    return `${ctx.player.name} 生命值 ${isNaN(hp) ? '?' : hp}/${isNaN(hpmax) ? '?' : hpmax}　状态：${flag}`;
  }

  function ok() { return seal.ext.newCmdExecuteResult(true); }
  function help() { const r = seal.ext.newCmdExecuteResult(true); r.showHelp = true; return r; }

  ext.onMessageReceived = (ctx, msg) => {
    const txt = (msg.message || '').trim();
    if (!/^[.。!！\/]\s*st/i.test(txt)) return; 
    const hpBefore = readHp(ctx); 
    if (isNaN(hpBefore)) return;

    setTimeout(() => {
      const hpAfter = readHp(ctx);
      if (isNaN(hpAfter)) return;
      const dmg = hpBefore - hpAfter;
      if (dmg <= 0) return; 

      const hpmax = readHpMax(ctx);
      if (isNaN(hpmax)) return;

      const st = getState(ctx);
      const isMajor = dmg * 2 >= hpmax; 
      const half = Math.ceil(hpmax / 2);
      const base = { name: ctx.player.name, dmg, half, hp: hpAfter, hpmax };
      const lines = [];

      if (isMajor) {
        st.major = true;
        lines.push(fill(seal.ext.getStringConfig(ext, '重伤提示'), base));
        if (hpAfter > 0) {
          const c = conCheck(readCon(ctx));
          const result = c.success
            ? seal.ext.getStringConfig(ext, '避免昏迷-清醒文案')
            : seal.ext.getStringConfig(ext, '避免昏迷-昏迷文案');
          lines.push(fill(seal.ext.getStringConfig(ext, '避免昏迷检定提示'),
            Object.assign({ roll: c.roll, con: c.con, level: c.level, result }, base)));
        }
      }

      if (hpAfter <= 0) {
        if (st.major) {
          st.dying = true;
          lines.push(fill(seal.ext.getStringConfig(ext, '濒死提示'), base));
        } else if (!isMajor) {
          lines.push(fill(seal.ext.getStringConfig(ext, '轻伤昏迷提示'), base));
        } else {
          
        }
      }

      if (lines.length) {
        setState(ctx, st);
        seal.replyToSender(ctx, msg, lines.join('\n'));
      }
    }, 500);
  };

  // ---------------------------------------------------------------------------
  // .伤势  查看重伤/濒死标记
  // ---------------------------------------------------------------------------
  // 清除标记并回复。clearMajor/clearDying 为 null 时不动该项
  function doClear(ctx, msg, clearMajor, clearDying) {
    const st = getState(ctx);
    if (clearMajor) st.major = false;
    if (clearDying) st.dying = false;
    setState(ctx, st);
    seal.replyToSender(ctx, msg, `已更新。${statusLine(ctx, st)}`);
    return ok();
  }

  // .wound / .wd —— 查看，或 .wound clear [major|dying] 清除
  const cmdWound = seal.ext.newCmdItemInfo();
  cmdWound.name = 'wound';
  cmdWound.help =
    '查看 / 清除重伤与濒死标记：\n' +
    '.wound  /  .wd                  查看当前重伤/濒死标记\n' +
    '.wound clear  /  .wdclr         清除重伤与濒死全部标记\n' +
    '.wound clear major  /  .wdclmaj 仅擦除重伤栏（医学治疗成功后使用）\n' +
    '.wound clear dying  /  .wdcld   仅解除濒死标记\n' +
    '别名 .伤势';
  cmdWound.solve = (ctx, msg, cmdArgs) => {
    const a1 = cmdArgs.getArgN(1);
    if (a1 === 'help') return help();

    if (!a1 || (a1 !== 'clear' && a1 !== '清除')) {
      seal.replyToSender(ctx, msg, statusLine(ctx, getState(ctx)));
      return ok();
    }

    const target = cmdArgs.getArgN(2);
    if (!target) return doClear(ctx, msg, true, true);
    if (target === 'major' || target === '重伤') return doClear(ctx, msg, true, false);
    if (target === 'dying' || target === '濒死') return doClear(ctx, msg, false, true);
    seal.replyToSender(ctx, msg, '用法：.wound clear [major|dying]，不带参数清除全部');
    return ok();
  };

  const cmdWdClr = seal.ext.newCmdItemInfo();
  cmdWdClr.name = 'wdclr';
  cmdWdClr.help = '清除重伤与濒死全部标记（= .wound clear）';
  cmdWdClr.solve = (ctx, msg, cmdArgs) => {
    if (cmdArgs.getArgN(1) === 'help') return help();
    return doClear(ctx, msg, true, true);
  };

  const cmdWdClMaj = seal.ext.newCmdItemInfo();
  cmdWdClMaj.name = 'wdclmaj';
  cmdWdClMaj.help = '仅擦除重伤栏标记（= .wound clear major）';
  cmdWdClMaj.solve = (ctx, msg, cmdArgs) => {
    if (cmdArgs.getArgN(1) === 'help') return help();
    return doClear(ctx, msg, true, false);
  };

  const cmdWdClD = seal.ext.newCmdItemInfo();
  cmdWdClD.name = 'wdcld';
  cmdWdClD.help = '仅解除濒死标记（= .wound clear dying）';
  cmdWdClD.solve = (ctx, msg, cmdArgs) => {
    if (cmdArgs.getArgN(1) === 'help') return help();
    return doClear(ctx, msg, false, true);
  };

  ext.cmdMap['wound'] = cmdWound;
  ext.cmdMap['wd'] = cmdWound;
  ext.cmdMap['伤势'] = cmdWound;
  ext.cmdMap['wdclr'] = cmdWdClr;
  ext.cmdMap['wdclmaj'] = cmdWdClMaj;
  ext.cmdMap['wdcld'] = cmdWdClD;
})();
