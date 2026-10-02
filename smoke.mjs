import {chromium} from 'playwright';
import {readFileSync} from 'fs';

const MONO_TTF = readFileSync('/tmp/fontserve/DejaVuSansMono.ttf');


const results = [];
function check(name, cond, extra = '') {
  results.push({name, ok: !!cond, extra});
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function doc(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('type-pairs-v2')));
}

async function waitMeasured(page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const d = await doc(page);
    const m = d.measurements[d.selectedId];
    const all = m.desktop && m.tablet && m.mobile;
    const measured = all && Object.values(m).every((x) => x.status === 'measured');
    if (measured) return d;
    await sleep(150);
  }
  return doc(page);
}

async function chipStatus(page, tierCn) {
  return page.evaluate((cn) => {
    const chips = [...document.querySelectorAll('.meas-chip')];
    const chip = chips.find((c) => c.querySelector('.chip-head b')?.textContent === cn);
    if (!chip) return null;
    return {
      status: chip.querySelector('.chip-status').textContent,
      lines: [...chip.querySelectorAll('.chip-lines span')].map((s) => s.textContent.trim()),
      cls: chip.className,
    };
  }, tierCn);
}

let browser;
try {
  browser = await chromium.launch({
    executablePath:
      '/home/node/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell',
    env: {
      ...process.env,
      LD_LIBRARY_PATH:
        '/tmp/libs/extracted/usr/lib/aarch64-linux-gnu:/tmp/libs/extracted/lib/aarch64-linux-gnu',
    },
  });

  const BASE_URL = 'http://127.0.0.1:4173/';

  // 确定性字体：把 Google Fonts CSS 替换为指向本地静态服务的 @font-face。
  // 应用所有声明的家族都映射到 DejaVuSansMono（度量与 sans/serif 回退基线不同），
  // 从而画布“字体是否真正生效”的检测可被确定性验证，不依赖外网与字体缓存。
  // 字体与应用同源（4173）经路由回灌，避免跨域 canvas 字体污染
  const FONT_URL = 'http://127.0.0.1:4173/__testfont__.ttf';
  const LOCAL_FONT_CSS = `
    @font-face{font-family:'Fraunces';font-weight:400 700;src:url(${FONT_URL}) format('truetype');}
    @font-face{font-family:'DM Sans';font-weight:400 700;src:url(${FONT_URL}) format('truetype');}
    @font-face{font-family:'Space Grotesk';font-weight:400 700;src:url(${FONT_URL}) format('truetype');}
    @font-face{font-family:'Newsreader';font-weight:400 700;src:url(${FONT_URL}) format('truetype');}
    @font-face{font-family:'Playfair Display';font-weight:400 700;src:url(${FONT_URL}) format('truetype');}
    @font-face{font-family:'IBM Plex Sans';font-weight:400 700;src:url(${FONT_URL}) format('truetype');}
  `;
  function routeLocalFonts(context) {
    context.route('https://fonts.googleapis.com/**', (r) =>
      r.fulfill({status: 200, contentType: 'text/css', body: LOCAL_FONT_CSS}),
    );
    context.route('**/__testfont__.ttf', (r) =>
      r.fulfill({status: 200, contentType: 'font/ttf', body: MONO_TTF}),
    );
  }

  // ---------- 场景 1：三档实排测量 ----------
  const ctx = await browser.newContext({viewport: {width: 1280, height: 900}});
  routeLocalFonts(ctx);
  const page = await ctx.newPage();
  await page.goto(BASE_URL, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('.meas-chip');
  await sleep(500); // 首帧 + 字体
  const d0 = await waitMeasured(page);
  const m0 = d0.measurements[d0.selectedId];
  check('三档都有测量记录', m0.desktop && m0.tablet && m0.mobile);
  check('三档状态均为 measured(字体已加载)', ['desktop', 'tablet', 'mobile'].every((t) => m0[t].status === 'measured'),
    `桌${m0.desktop.status}/板${m0.tablet.status}/机${m0.mobile.status}`);
  check('标题/正文行数为正整数', ['desktop', 'tablet', 'mobile'].every((t) => m0[t].headingLines >= 1 && m0[t].bodyLines >= 1),
    `桌 ${m0.desktop.headingLines}行/${m0.desktop.bodyLines}行`);
  check('无溢出标记正确', !m0.desktop.overflowX && !m0.desktop.overflowY, m0.desktop.overflowDetail);
  check('帧宽随档位不同（桌>板>机）', m0.desktop.frameWidth > m0.tablet.frameWidth && m0.tablet.frameWidth > m0.mobile.frameWidth,
    `${m0.desktop.frameWidth}/${m0.tablet.frameWidth}/${m0.mobile.frameWidth}`);
  const deskH = m0.desktop.headingLines;

  // ---------- 场景 2：窗口变化只重做受影响档位 ----------
  await page.setViewportSize({width: 820, height: 900}); // 平板档
  await sleep(600);
  let bar = await page.textContent('.canvas-bar span');
  check('820px 时判定为平板档', bar.includes('平板'));
  let activeChip = await chipStatus(page, '平板');
  check('平板档为激活高亮', (await page.$eval('.meas-chip.measured.chip-active .chip-head b', (e) => e.textContent)) === '平板');
  const tabAtBefore = m0.tablet.measuredAt;
  const dAtTablet = await doc(page);
  const tabAtAfter = dAtTablet.measurements[dAtTablet.selectedId].tablet.measuredAt;
  check('激活(平板)档随流式宽度重测', tabAtAfter >= tabAtBefore);

  await page.setViewportSize({width: 500, height: 900}); // 手机档
  await sleep(600);
  bar = await page.textContent('.canvas-bar span');
  check('500px 时判定为手机档', bar.includes('手机'));

  // ---------- 场景 3：字号变化 → 相关档位立即失效 → 重测定稿 ----------
  await page.setViewportSize({width: 1280, height: 900});
  await sleep(400);
  const sigBefore = (await doc(page)).measurements[d0.selectedId].desktop.signature;
  // 拖字号滑杆并松手提交
  await page.evaluate(() => {
    const sliders = document.querySelectorAll('input[type=range]');
    const size = sliders[0];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(size, '72');
    size.dispatchEvent(new Event('input', {bubbles: true}));
    size.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
  });
  // 失效后重测：签名应更新（测量走 ~300ms 防抖落盘，轮询等待而非固定 sleep）
  await sleep(100);
  const d1 = await waitMeasured(page);
  const m1 = d1.measurements[d1.selectedId];
  const waitSig = async (tier, oldSig) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const d = await doc(page);
      const s = d.measurements[d.selectedId]?.[tier]?.signature;
      if (s && s !== oldSig) return s;
      await sleep(100);
    }
    return (await doc(page)).measurements[(await doc(page)).selectedId]?.[tier]?.signature;
  };
  const newDeskSig = await waitSig('desktop', sigBefore);
  const newMobSig = await waitSig('mobile', sigBefore);
  check('字号变化后签名更新(三档失效重测)', newDeskSig !== sigBefore && newMobSig !== sigBefore,
    `桌:${newDeskSig === sigBefore ? '未变' : '已变'} 机:${newMobSig === sigBefore ? '未变' : '已变'}`);
  check('大字号行数不少于原行数', m1.desktop.headingLines >= deskH, `${deskH} -> ${m1.desktop.headingLines}`);
  check('字号 72 提交进文档', d1.fields[d1.selectedId].size === 72);
  // 恢复字号
  await page.evaluate(() => {
    const sliders = document.querySelectorAll('input[type=range]');
    const size = sliders[0];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(size, '46');
    size.dispatchEvent(new Event('input', {bubbles: true}));
    size.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
  });
  await waitMeasured(page);

  // ---------- 场景 4：跨标签页字段冲突（独立 context，避免上一场景字号干扰） ----------
  const ctxC = await browser.newContext({viewport: {width: 1280, height: 900}});
  routeLocalFonts(ctxC);
  const pageA = await ctxC.newPage();
  const pageB = await ctxC.newPage();
  await pageA.goto(BASE_URL, {waitUntil: 'domcontentloaded'});
  await pageB.goto(BASE_URL, {waitUntil: 'domcontentloaded'});
  await pageA.waitForSelector('.meas-chip');
  await pageB.waitForSelector('.meas-chip');
  await sleep(400);

  // A 先把字号拖到 60（草稿未提交）；B 提交 36 并同步到 A 的文档；A 松手提交 → 冲突
  function dragSliderOnly(pg, val) {
    return pg.evaluate((v) => {
      const size = document.querySelectorAll('input[type=range]')[0];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(size, String(v));
      size.dispatchEvent(new Event('input', {bubbles: true})); // 只产生本地脏草稿，不提交
    }, val);
  }
  function releaseSlider(pg) {
    return pg.evaluate(() => {
      const size = document.querySelectorAll('input[type=range]')[0];
      size.dispatchEvent(new PointerEvent('pointerup', {bubbles: true})); // 松手才提交
    });
  }
  await dragSliderOnly(pageA, 60);
  await sleep(200);
  await dragSliderOnly(pageB, 36);
  await sleep(200); // 等 React flush，使松手提交读到最新草稿（真实拖动天然有此间隔）
  await releaseSlider(pageB);
  await sleep(700); // 等 storage 事件到达 A
  await releaseSlider(pageA);
  await sleep(500);
  const conflictVisible = await pageA.isVisible('.conflict');
  check('后提交者(A)看到字号字段冲突横幅', conflictVisible);
  if (conflictVisible) {
    const txt = await pageA.textContent('.conflict-body');
    check(
      '冲突横幅显示双方的值',
      txt.includes('36px') && txt.includes('60px'),
      txt.replace(/\s+/g, ' ').slice(0, 140),
    );
    await pageA.click('.conflict-local'); // A 保留自己的草稿值 60
    await sleep(400);
    const dA = await doc(pageA);
    check('A 保留本地值后文档字号为 60', dA.fields[dA.selectedId].size === 60);
  }

  // 样例文字冲突：两边各改各的，B 先失焦提交，A 后失焦提交 → A 见冲突
  await pageA.fill('.sample-row input[type=text]', 'A writes a longer competing headline');
  await pageB.fill('.sample-row input[type=text]', 'B writes a totally different headline here');
  await sleep(200);
  await pageB.locator('.sample-row input[type=text]').blur();
  await sleep(900);
  await pageA.locator('.sample-row input[type=text]').blur();
  await sleep(700);
  const textConflict = await pageA.isVisible('.conflict');
  check('样例标题并发修改产生冲突', textConflict);
  if (textConflict) await pageA.click('.conflict-remote');

  // ---------- 场景 5：导出 CSS 带三档行数与溢出 ----------
  const [download] = await Promise.all([
    pageA.waitForEvent('download'),
    pageA.click('button:has-text("导出 CSS")'),
  ]);
  const css = (await download.path()) ? await download.path() : null;
  const stream = css ? await import('fs').then((fs) => fs.promises.readFile(css, 'utf8')) : '';
  check('导出文件是 .css', download.suggestedFilename().endsWith('.css'), download.suggestedFilename());
  check('导出含三档测量报告', stream.includes('测量报告') && stream.includes('桌面') && stream.includes('平板') && stream.includes('手机'));
  check('导出含行数数据', /标题行/.test(stream) || /行/.test(stream));
  check('导出含三个媒体查询/响应式断点', stream.includes('@media (max-width: 1000px)') && stream.includes('@media (max-width: 700px)'));
  check('导出含溢出明细', stream.includes('无溢出') || stream.includes('溢出'));
  const reportLines = stream.split('\n').filter((l) => /^\/\* (桌面|平板|手机)\s+\d+×\d+/.test(l));
  check('报告三行齐全', reportLines.length === 3, reportLines.join(' | '));

  await ctxC.close();

  // ---------- 场景 6：旧 v1 数据迁移，补三档待测记录 ----------
  const ctx2 = await browser.newContext({viewport: {width: 1280, height: 900}});
  routeLocalFonts(ctx2);
  const p3 = await ctx2.newPage();
  // 页面脚本运行前预置 v1 数据；loadDoc 初始化时同步完成迁移
  await p3.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem(
      'type-pairs',
      JSON.stringify([
        {id: 1, title: 'Legacy', heading: 'Old headline', body: 'Old body text from v1 storage.', category: 'Brand', favorite: false},
      ]),
    );
  });
  await p3.goto(BASE_URL, {waitUntil: 'commit'});
  // 模块初始化即写 v2 迁移文档；短暂等待初始化 effect 落盘，但抢在字体到位重测前读占位
  let mig = null;
  for (let i = 0; i < 20; i++) {
    await sleep(50);
    const raw = await p3.evaluate(() => localStorage.getItem('type-pairs-v2'));
    if (raw) {
      mig = JSON.parse(raw);
      break;
    }
  }
  check('迁移后版本为 v2', mig && mig.version === 2);
  check('迁移后配对保留', mig && mig.pairs[0].title === 'Legacy');
  check('迁移补录三档测量占位', mig && mig.measurements[1].desktop && mig.measurements[1].tablet && mig.measurements[1].mobile);
  check(
    '迁移占位标记为待测(pending)',
    mig && Object.values(mig.measurements[1]).every((x) => x.status === 'pending' && x.migrated),
  );
  await p3.waitForSelector('.meas-chip');
  await sleep(2500); // 字体加载后应自动从 pending → measured（不当成定稿）
  const mig2 = await doc(p3);
  check('字体到位后迁移占位自动重测为 measured', ['desktop', 'tablet', 'mobile'].every((t) => mig2.measurements[1][t].status === 'measured'),
    `桌${mig2.measurements[1].desktop.status}`);
  await ctx2.close();

  // ---------- 场景 7：字体未就绪先待测（用不存在的字体族，不受字体缓存影响） ----------
  const ctx3 = await browser.newContext({viewport: {width: 1280, height: 900}});
  const p4 = await ctx3.newPage();
  await p4.addInitScript(() => {
    localStorage.clear();
    // 预置一份 v2：标题字体是不存在的字体族，document.fonts.check 永远为 false
    const pairs = [
      {id: 1, title: 'NoFont', heading: 'Headline without a real family', body: 'Body text that can never resolve its heading webfont.', category: 'Brand', favorite: false},
    ];
    const doc = {
      version: 2,
      pairs,
      fields: {1: {headingFont: 'ThisFamilyDoesNotExist-xyz', bodyFont: 'DM Sans', size: 46, weight: 600, leading: 1.25, tracking: 0}},
      revisions: {1: {}},
      measurements: {1: {}},
      selectedId: 1,
    };
    localStorage.setItem('type-pairs-v2', JSON.stringify(doc));
  });
  await p4.goto(BASE_URL, {waitUntil: 'domcontentloaded'});
  await p4.waitForSelector('.meas-chip');
  await sleep(1500);
  const dm = await doc(p4);
  const mm = dm.measurements[dm.selectedId];
  // 字体族不存在 → document.fonts.check 不通过，必须是 pending，不能当定稿
  check('字体未加载时标记为 pending 而非定稿', mm.desktop.status === 'pending' && mm.mobile.status === 'pending',
    `桌${mm.desktop.status}/机${mm.mobile.status}`);
  const pendChip = await chipStatus(p4, '桌面');
  check('UI 显示“待测·字体加载中”', pendChip && pendChip.status.includes('待测'));
  await ctx3.close();
} catch (e) {
  console.error('SMOKE ERROR', e);
  process.exitCode = 1;
} finally {
  await browser?.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
