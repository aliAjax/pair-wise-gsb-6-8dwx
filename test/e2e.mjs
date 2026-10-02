import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';

const BASE = 'http://localhost:4174';
const sans = readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
const serif = readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf');
const sansB64 = sans.toString('base64');
const serifB64 = serif.toString('base64');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`ok - ${name}`);
  } else {
    failed++;
    console.log(`FAIL - ${name} ${extra}`);
  }
}

/** 把 Google Fonts 的 @import 替换为本地 DejaVu 字体，确定性控制加载完成 */
async function mockFonts(page) {
  const face = (family, b64, weight = 400) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/ttf;base64,${b64}) format('truetype');}`;
  const css = [
    face('Fraunces', serifB64, 400),
    face('Fraunces', serifB64, 500),
    face('Fraunces', serifB64, 600),
    face('Fraunces', serifB64, 700),
    face('DM Sans', sansB64, 400),
    face('DM Sans', sansB64, 500),
    face('DM Sans', sansB64, 600),
    face('DM Sans', sansB64, 700),
    face('Space Grotesk', sansB64, 400),
    face('Space Grotesk', sansB64, 600),
    face('Newsreader', serifB64, 400),
    face('IBM Plex Sans', sansB64, 400),
    face('Playfair Display', serifB64, 400),
  ].join('');
  await page.route(/fonts\.googleapis\.com/, (route) =>
    route.fulfill({status: 200, contentType: 'text/css', body: css}),
  );
  await page.route(/fonts\.gstatic\.com/, (route) => route.abort());
}

async function freshContext() {
  const browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  return {browser, context};
}

async function measureCards(page) {
  return page.$$eval('.measure-card', (cards) =>
    cards.map((c) => c.textContent || ''),
  );
}

async function main() {
  /* ---------- 场景 1：字体加载完 -> 三档都完成，行数/溢出随宽度不同 ---------- */
  {
    const {browser, context} = await freshContext();
    const page = await context.newPage();
    await mockFonts(page);
    await page.goto(BASE);
    await page.evaluate(() => localStorage.removeItem('type-pairs'));
    await page.reload();
    await page.waitForTimeout(400);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(
      () => !document.querySelector('.measure-card .mc-pending'),
      {timeout: 5000},
    );
    const cards = await measureCards(page);
    check('三档全部完成测量（无待测卡）', cards.length === 3 && cards.every((c) => c.includes('标题行')));
    const nums = await page.$$eval('.measure-card .mc-nums b', (els) => els.map((e) => Number(e.textContent)));
    // 桌面 2、正文 3、平板 5、6、手机 8、9（顺序：每档 标题/正文）
    const headingLines = [nums[0], nums[2], nums[4]];
    const bodyLines = [nums[1], nums[3], nums[5]];
    check(
      '窄版心标题换行行数递增',
      headingLines[0] <= headingLines[1] && headingLines[1] <= headingLines[2] && headingLines[2] > headingLines[0],
      JSON.stringify(headingLines),
    );
    check('正文行数随版心变窄不减', bodyLines[2] >= bodyLines[0], JSON.stringify(bodyLines));
    await browser.close();
  }

  /* ---------- 场景 2：字体没加载完 -> 待测（font-loading），不能定稿 ---------- */
  {
    const {browser, context} = await freshContext();
    const page = await context.newPage();
    // 字体 CSS 永远挂起：document.fonts.load 不 resolve
    await page.route(/fonts\.googleapis\.com/, (route) =>
      route.fulfill({status: 200, contentType: 'text/css', body: '/* hang */'}),
    );
    await page.route(/fonts\.gstatic\.com/, (route) => route.abort());
    await page.goto(BASE);
    await page.waitForTimeout(1200);
    const cards = await measureCards(page);
    check('字体未就绪时三档标待测', cards.length === 3 && cards.every((c) => c.includes('待测')));
    const store = await page.evaluate(() => JSON.parse(localStorage.getItem('type-pairs') || '{}'));
    check(
      '存储里也是 pending 而非 measured',
      store.pairs?.[0]?.measures?.desktop?.status === 'pending',
      JSON.stringify(store.pairs?.[0]?.measures?.desktop),
    );
    await browser.close();
  }

  /* ---------- 场景 3：窗口跨断点只重测被触及档（其余档 measuredAt 不变） ---------- */
  {
    const {browser, context} = await freshContext();
    const page = await context.newPage();
    await mockFonts(page);
    await page.goto(BASE);
    await page.waitForFunction(() => !document.querySelector('.measure-card .mc-pending'), {timeout: 5000});
    await page.waitForTimeout(300); // 等测量批量落盘（120ms 防抖）
    const before = await page.evaluate(() => {
      const d = JSON.parse(localStorage.getItem('type-pairs') || '{}');
      return Object.fromEntries(
        Object.entries(d.pairs[0].measures).map(([k, v]) => [k, v.measuredAt]),
      );
    });
    // 桌面(1280) -> 平板宽度 850
    await page.setViewportSize({width: 850, height: 900});
    await page.waitForTimeout(600);
    const activeTab = await page.textContent('.tier-tabs button.active');
    check('窗口跨入平板档，标签自动切到平板', (activeTab || '').includes('平板'), activeTab || '');
    // -> 手机 500
    await page.setViewportSize({width: 500, height: 900});
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => {
      const d = JSON.parse(localStorage.getItem('type-pairs') || '{}');
      return Object.fromEntries(
        Object.entries(d.pairs[0].measures).map(([k, v]) => [k, v.measuredAt]),
      );
    });
    check(
      '桌面档未被跨断点重测（时间戳不变）',
      before.desktop === after.desktop,
      `${before.desktop} vs ${after.desktop}`,
    );
    check('手机档被触及重测', typeof after.mobile === 'number');
    await browser.close();
  }

  /* ---------- 场景 4：样例文字/字号一改，相关档立即待测；还原后恢复 ---------- */
  {
    const {browser, context} = await freshContext();
    const page = await context.newPage();
    await mockFonts(page);
    await page.goto(BASE);
    await page.waitForFunction(() => !document.querySelector('.measure-card .mc-pending'), {timeout: 5000});
    await page.fill('.sample-row input', 'A dramatically longer headline that must wrap everywhere now');
    await page.waitForTimeout(300);
    let cards = await measureCards(page);
    check('标题样例变化后三档立即失效待测', cards.every((c) => c.includes('待测') || c.includes('标题行')));
    await page.waitForFunction(() => !document.querySelector('.measure-card .mc-pending'), {timeout: 5000});
    cards = await measureCards(page);
    check('新输入完成重测', cards.every((c) => c.includes('标题行')));
    // 字号只影响标题宽度：三档标题签名都含 size，故三档待测（合理）
    await page.fill('.range-row input[type="range"]', '74');
    await page.$$eval('.range-row input[type="range"]', (els) => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(els[0], '74');
      els[0].dispatchEvent(new Event('input', {bubbles: true}));
    });
    await page.waitForTimeout(200);
    const dirtyTag = await page.$('.dirty-tag');
    check('未保存改动有标记', !!dirtyTag);
    await page.click('.revert');
    await page.waitForTimeout(300);
    const tag = await page.$('.dirty-tag');
    check('还原后未保存标记消失', !tag);
    await browser.close();
  }

  /* ---------- 场景 5：两个标签页同改字号 -> 后提交者看到字段冲突并解决 ---------- */
  {
    const {browser, context} = await freshContext();
    const a = await context.newPage();
    await mockFonts(a);
    await a.goto(BASE);
    await a.waitForFunction(() => !document.querySelector('.measure-card .mc-pending'), {timeout: 5000});
    const b = await context.newPage();
    await mockFonts(b);
    await b.goto(BASE);
    await b.waitForTimeout(400);

    const dragSize = async (page, val) => {
      await page.$$eval('.range-row input[type="range"]', (els, v) => {
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(els[0], v);
        els[0].dispatchEvent(new Event('input', {bubbles: true}));
      }, val);
    };
    // 双方都基于同一版本开始各自的草稿（真正并发）
    await dragSize(b, '72');
    await dragSize(a, '30');
    // A 先提交
    await a.click('button.save');
    await a.waitForTimeout(400);
    // B 后提交 -> 必须看到字段冲突
    await b.click('button.save');
    await b.waitForSelector('.conflict-modal', {timeout: 3000});
    const conflictText = await b.textContent('.conflict-modal');
    check('后提交者看到字号字段冲突', (conflictText || '').includes('字号'));
    const choices = await b.$$eval('.conflict-row', (rows) =>
      rows.map((r) => r.textContent),
    );
    check('冲突中展示双方值 30 与 72', choices.some((t) => t.includes('30px')) && choices.some((t) => t.includes('72px')));
    // 选择"另一标签页"的值（30）并合并
    await b.check('.conflict-row input[value="remote"]');
    await b.click('.conflict-modal .primary');
    await b.waitForTimeout(400);
    const savedSize = await b.$eval('.range-row input[type="range"]', (el) => el.value);
    check('按选择合并后字号为对方的 30', savedSize === '30', savedSize);
    // A 端通过 storage 事件同步
    await a.waitForTimeout(600);
    const aSize = await a.$eval('.range-row input[type="range"]', (el) => el.value);
    check('A 标签页同步到合并结果 30', aSize === '30', aSize);
    await browser.close();
  }

  /* ---------- 场景 6：两标签页改不同字段（字号 vs 字距）自动合并不冲突 ---------- */
  {
    const {browser, context} = await freshContext();
    const a = await context.newPage();
    await mockFonts(a);
    await a.goto(BASE);
    const b = await context.newPage();
    await mockFonts(b);
    await b.goto(BASE);
    await a.waitForFunction(() => !document.querySelector('.measure-card .mc-pending'), {timeout: 5000});
    const setRange = async (page, idx, val) => {
      await page.$$eval(
        '.range-row input[type="range"]',
        (els, p) => {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(els[p.idx], p.val);
          els[p.idx].dispatchEvent(new Event('input', {bubbles: true}));
        },
        {idx, val},
      );
    };
    // 双方先各自起草稿（不同字段），再先后提交
    await setRange(b, 3, '2.5'); // B 草稿：tracking
    await setRange(a, 0, '32'); // A 草稿：size
    await a.click('button.save');
    await a.waitForTimeout(300);
    await b.click('button.save');
    await b.waitForTimeout(400);
    const modal = await b.$('.conflict-modal');
    check('不同字段并发修改不弹冲突', !modal);
    const final = await b.evaluate(() => {
      const p = JSON.parse(localStorage.getItem('type-pairs') || '{}').pairs[0];
      return {size: p.size, tracking: p.tracking};
    });
    check('自动合并保留双方修改', final.size === 32 && Number(final.tracking) === 2.5, JSON.stringify(final));
    await browser.close();
  }

  /* ---------- 场景 7：导出 CSS 带三档行数与溢出，且不把待测当定稿 ---------- */
  {
    const {browser, context} = await freshContext();
    const page = await context.newPage();
    await mockFonts(page);
    await page.goto(BASE);
    await page.waitForFunction(() => !document.querySelector('.measure-card .mc-pending'), {timeout: 5000});
    const css = await page.evaluate(
      async () => {
        let captured = '';
        const orig = URL.createObjectURL;
        URL.createObjectURL = (blob) => {
          blob.text().then((t) => {
            window.__css = t;
          });
          return 'blob:mock';
        };
        document.querySelector('header .outline').dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await new Promise((r) => setTimeout(r, 300));
        URL.createObjectURL = orig;
        return window.__css;
      },
    );
    check('导出含桌面行数注释', /desktop: 标题 \d+ 行 · 正文 \d+ 行 · 溢出 (是|否)/.test(css), css.slice(0, 400));
    check('导出含平板媒体查询', css.includes('@media (max-width: 1000px)'));
    check('导出含手机媒体查询', css.includes('@media (max-width: 700px)'));
    await browser.close();
  }

  /* ---------- 场景 8：v1 旧数据升级补测量记录 ---------- */
  {
    const {browser, context} = await freshContext();
    const page = await context.newPage();
    await mockFonts(page);
    // 首次导航前就放好 v1 旧数据
    await page.addInitScript(() =>
      localStorage.setItem(
        'type-pairs',
        JSON.stringify([
          {id: 1, title: 'Old', heading: 'Legacy headline', body: 'Legacy body text.', category: 'X', favorite: false},
        ]),
      ),
    );
    await page.goto(BASE);
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem('type-pairs') || '{}').version === 2,
      {timeout: 5000},
    );
    const upgraded = await page.evaluate(() => JSON.parse(localStorage.getItem('type-pairs') || '{}'));
    check('旧数据升级到 version 2', upgraded.version === 2);
    for (const tier of ['desktop', 'tablet', 'mobile']) {
      check(
        `旧数据补齐 ${tier} 测量记录`,
        upgraded.pairs[0].measures[tier] && upgraded.pairs[0].measures[tier].status === 'pending',
      );
    }
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('type-pairs') || '{}').pairs?.[0]?.measures?.desktop
          ?.status === 'measured',
      {timeout: 5000},
    );
    const afterMeasure = await page.evaluate(() => JSON.parse(localStorage.getItem('type-pairs') || '{}'));
    check('升级后待测档完成重测落盘', afterMeasure.pairs[0].measures.desktop.status === 'measured');
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
