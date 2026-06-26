// ==UserScript==
// @name         临时疯狂自动检定
// @author       MYRIAD
// @version      1.1.0
// @description  当 .sc 造成的单次理智扣除 >= 5 时，自动触发 INT（智力）检定并提示临时疯狂结果。成功则提示执行 .ti，失败则显示自定义提醒。配置项可在 WebUI → 扩展 → 临时疯狂自动检定 中修改。
// @timestamp    1782221141
// 2026-06-23
// @license      MIT
// ==/UserScript==

let ext = seal.ext.find('AutoIntCheck');
if (!ext) {
    ext = seal.ext.new('AutoIntCheck', 'MYRIAD', '1.0.0');
    seal.ext.register(ext);

    // 可配置文本，在 WebUI → 扩展 → 临时疯狂自动检定 中修改
    // 占位符：{name} 角色名  {roll} 出目  {int} 智力值  {san_loss} 本次理智扣除量  {level} 成功级别
    seal.ext.registerStringConfig(ext, '成功提醒',
        '【临时疯狂】{name} 失去了 {san_loss} 点理智，触发了临时疯狂检定！\nINT检定：D100={roll}/{int}，{level}\n请执行 .ti 或 .li 以确定即时疯狂症状。', '');
    seal.ext.registerStringConfig(ext, '失败提醒',
        '【临时疯狂】{name} 失去了 {san_loss} 点理智，触发了临时疯狂检定！\nINT检定：D100={roll}/{int}，{level}\n请向KP确认临时疯狂的具体症状与持续时间。', '');
    seal.ext.registerStringConfig(ext, '大成功附加',
        '\n（大成功！意志力超群，临时疯狂症状尤为轻微，请与KP协商具体表现。）', '');
    seal.ext.registerStringConfig(ext, '大失败附加',
        '\n（大失败！理智彻底崩溃，临时疯狂症状格外严重，请与KP协商具体表现。）', '');
    seal.ext.registerStringConfig(ext, 'INT未设置提醒',
        '【临时疯狂】{name} 失去了 {san_loss} 点理智，触发了临时疯狂检定！\nINT属性未设置，本次掷骰：D100={roll}\n请自行判断理智检定结果。', '');

    seal.ext.registerStringConfig(ext, '理智变化识别格式', '理智变化: {旧} ➯ {新}',
        '用于从骰子的 sc 回复中识别理智变化（其它插件内部调用 sc 时也能触发临时疯狂检定）。' +
        '\n{旧} 和 {新} 分别代表变化前、后的理智值，会自动匹配其中的数字。' +
        '\n如果你不知道这是什么，请保持默认、不要修改。' +
        '\n如果你给「理智变化」设置过不同的自定义回复（自定义文案），请把你的文案格式填到这里，' +
        '并用 {旧} 和 {新} 标出新旧理智数值出现的位置，本插件才能正确识别并激活这条触发路径。');

    // 调试日志开关：开启后会在 main.log 输出每个入口的捕获/计算细节，便于排查。默认关闭。
    seal.ext.registerBoolConfig(ext, '调试日志', false);
    function dlog(text) {
        if (seal.ext.getBoolConfig(ext, '调试日志')) console.log(`[AutoIntCheck] ${text}`);
    }

    function buildSanChangeRegex() {
        const tpl = seal.ext.getStringConfig(ext, '理智变化识别格式');
        const oldPos = tpl.indexOf('{旧}');
        const newPos = tpl.indexOf('{新}');
        if (oldPos === -1 || newPos === -1) return null;
        let s = tpl.replace(/\{旧\}/g, '\x01').replace(/\{新\}/g, '\x02'); 
        s = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');                      
        s = s.replace(/\s+/g, '\\s*');                                     
        s = s.replace(/\x01/g, '(\\d+)').replace(/\x02/g, '(\\d+)');       
        try {
            return { re: new RegExp(s), oldFirst: oldPos < newPos };
        } catch (e) {
            console.log(`[AutoIntCheck] 理智变化识别格式无法编译为正则: ${e.message}`);
            return null;
        }
    }

    function readInt(ctx) {
        for (const key of ['智力', 'int', 'INT']) {
            const v = parseInt(seal.format(ctx, `{${key}}`));
            if (!isNaN(v) && v > 0) return v;
        }
        return NaN;
    }

    function fillTemplate(template, name, sanLoss, roll, intVal, level) {
        return template
            .replace(/{name}/g, name)
            .replace(/{san_loss}/g, sanLoss)
            .replace(/{roll}/g, roll)
            .replace(/{int}/g, intVal)
            .replace(/{level}/g, level);
    }

    const lastTrigger = {};
    function scheduleInsanityCheck(ctx, msg, sanBefore, source) {
        const uid = ctx.player.userId;
        const now = Date.now();
        if (lastTrigger[uid] && now - lastTrigger[uid] < 1500) {
            dlog(`(${source}) 跳过重复触发 uid=${uid}`);
            return;
        }
        lastTrigger[uid] = now;
        dlog(`(${source}) 已计划检定 uid=${uid} sanBefore=${sanBefore}`);

        setTimeout(() => {
            const sanAfter = parseInt(seal.format(ctx, '{san}'));
            dlog(`(${source}) sanAfter=${sanAfter} loss=${sanBefore - sanAfter}`);
            if (isNaN(sanAfter)) return;

            const sanLoss = sanBefore - sanAfter;
            if (sanLoss < 5) return;

            const roll = Math.floor(Math.random() * 100) + 1;
            const playerName = ctx.player.name;
            const intVal = readInt(ctx);
            dlog(`(${source}) intVal=${intVal} roll=${roll}`);

            if (isNaN(intVal) || intVal <= 0) {
                seal.replyToSender(ctx, msg,
                    seal.ext.getStringConfig(ext, 'INT未设置提醒')
                        .replace(/{name}/g, playerName)
                        .replace(/{san_loss}/g, sanLoss)
                        .replace(/{roll}/g, roll)
                );
                return;
            }

            let level, isSuccess;
            if (roll === 1) {
                level = '大成功';   isSuccess = true;
            } else if (roll === 100) {
                level = '大失败';   isSuccess = false;
            } else if (roll <= Math.floor(intVal / 5)) {
                level = '极难成功'; isSuccess = true;
            } else if (roll <= Math.floor(intVal / 2)) {
                level = '困难成功'; isSuccess = true;
            } else if (roll <= intVal) {
                level = '成功';     isSuccess = true;
            } else {
                level = '失败';     isSuccess = false;
            }

            let message = fillTemplate(
                seal.ext.getStringConfig(ext, isSuccess ? '成功提醒' : '失败提醒'),
                playerName, sanLoss, roll, intVal, level
            );

            if (roll === 1)   message += seal.ext.getStringConfig(ext, '大成功附加');
            if (roll === 100) message += seal.ext.getStringConfig(ext, '大失败附加');

            seal.replyToSender(ctx, msg, message);
        }, 500);
    }

    ext.onMessageReceived = (ctx, msg) => {
        const txt = (msg.message || '').trim();
        if (!/^[.。!！/]\s*sc($|[^a-zA-Z])/i.test(txt)) return;
        dlog(`onMessageReceived 命中 sc: ${txt}`);
        const sanBefore = parseInt(seal.format(ctx, '{san}'));
        if (!isNaN(sanBefore)) scheduleInsanityCheck(ctx, msg, sanBefore, 'onMessage');
    };

    ext.onMessageSend = (ctx, msg) => {
        const txt = msg.message || '';
        const info = buildSanChangeRegex();
        if (!info) return;
        const m = txt.match(info.re);
        if (!m) return;
        const before = parseInt(info.oldFirst ? m[1] : m[2]);
        const after = parseInt(info.oldFirst ? m[2] : m[1]);
        if (isNaN(before) || isNaN(after) || before - after < 5) return;
        dlog(`onMessageSend 解析理智变化 ${before} -> ${after}`);
        scheduleInsanityCheck(ctx, msg, before, 'onSend');
    };
}
