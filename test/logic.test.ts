import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingAll} from '../src/breakpoints';
import {
  FONT_DEFAULT,
  STORE_KEY,
  commitMeasuresBatch,
  migrate,
  mutatePairs,
  normalize,
  pendingForValues,
  readStore,
  threeWayMerge,
  tryCommit,
  extractValues,
} from '../src/store';
import type {ContentValues, Pair, PairV1} from '../src/types';
import {tierSignature} from '../src/measure';
import {buildCss, tierSummary} from '../src/export';

// 最小 localStorage polyfill：每个测试前清空
const mem = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() {
    return mem.size;
  },
} as Storage;

function reset() {
  mem.delete(STORE_KEY);
}
test.beforeEach(reset);

function values(over: Partial<ContentValues> = {}): ContentValues {
  return {
    title: 'T',
    category: 'C',
    heading: 'H',
    body: 'B',
    ...FONT_DEFAULT,
    ...over,
  } as ContentValues;
}

test('v1 旧数据升级：补齐字体字段与三档待测测量记录', () => {
  const v1: PairV1[] = [
    {id: 1, title: 'a', heading: 'h', body: 'b', category: 'cat', favorite: false},
  ];
  const data = migrate(v1);
  assert.equal(data.version, 2);
  assert.equal(data.rev, 1);
  const p = data.pairs[0] as Pair;
  assert.equal(p.headingFont, 'Fraunces');
  for (const tier of ['desktop', 'tablet', 'mobile'] as const) {
    assert.equal(p.measures[tier].status, 'pending');
    assert.equal(p.measures[tier].signature, null);
  }
});

test('normalize 给缺测量记录的 v2 数据补档', () => {
  const data = normalize({
    version: 2,
    rev: 3,
    pairs: [{...values(), id: 1, favorite: false, measures: pendingAll('queued')}],
  } as never);
  assert.equal(data.pairs[0].measures.mobile.status, 'pending');
});

test('三向合并：仅一方改动自动采纳；同字段双方分歧才报冲突', () => {
  const base = values({size: 46, tracking: 0, heading: 'H'});
  const remote = values({size: 60, tracking: 0, heading: 'Remote heading'});
  const local = values({size: 46, tracking: 2, heading: 'Local heading'});
  const {merged, conflicts} = threeWayMerge(base, remote, local);
  // tracking 只有本地改 -> 保留本地
  assert.equal(merged.tracking, 2);
  // size 只有远程改 -> 自动采用远程
  assert.equal(merged.size, 60);
  // heading 双方都改且不同 -> 冲突
  assert.deepEqual(conflicts, ['heading']);
  assert.equal(merged.heading, 'Local heading');
});

test('后提交者：rev 变化且同字段分歧时拿到 conflicts，未冲突字段自动合并', () => {
  // 模拟存储：tab A 先提交 size
  let store = mutatePairs(() => [
    {...values({size: 46, heading: 'Same'}), id: 1, favorite: false, measures: pendingAll('queued')},
  ]);
  const base = extractValues(store.pairs[0]);
  // A 标签页改 size 提交
  store = mutatePairs(() => [
    {...values({size: 60, heading: 'Same'}), id: 1, favorite: false, measures: pendingAll('queued')},
  ]);
  // B 标签页基于旧 base 改 tracking + size
  const res = tryCommit({
    pairId: 1,
    base,
    baseRev: base === undefined ? 0 : 1,
    values: values({size: 40, tracking: 2, heading: 'Same'}),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'conflict');
  assert.deepEqual(res.conflicts, ['size']);
  assert.equal(res.merged!.tracking, 2); // 非冲突字段已自动并入
});

test('rev 已被 storage 事件同步、但草稿 base 仍旧时，仍按字段内容报冲突', () => {
  // 共同起点
  mutatePairs(() => [
    {...values({size: 46, tracking: 0}), id: 1, favorite: false, measures: pendingAll('queued')},
  ]);
  const start = readStore();
  const base = extractValues(start.pairs[0]);
  // A 先改 size 提交（rev+1）
  const afterA = mutatePairs((ps) =>
    ps.map((p) => (p.id === 1 ? {...p, size: 30, measures: pendingForValues({...extractValues(p), size: 30}, 'dirty')} : p)),
  );
  // B 的本地 data 已通过 storage 同步到 rev=afterA.rev，但草稿 base 还是编辑开始时的旧值
  const res = tryCommit({
    pairId: 1,
    base,
    baseRev: afterA.rev, // 注意：与当前 rev 相同
    values: values({size: 72, tracking: 0}),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'conflict');
  assert.deepEqual(res.conflicts, ['size']);
});

test('提交成功后三档测量全部失效', () => {
  const measured: Pair = {
    ...values({tracking: 0}),
    id: 7,
    favorite: false,
    measures: {
      desktop: {status: 'measured', signature: 'x', headingLines: 2, bodyLines: 3, overflow: false},
      tablet: {status: 'measured', signature: 'x', headingLines: 3, bodyLines: 4, overflow: true},
      mobile: {status: 'measured', signature: 'x', headingLines: 4, bodyLines: 5, overflow: true},
    },
  };
  mutatePairs(() => [measured]);
  const base = values({tracking: 0});
  const res = tryCommit({
    pairId: 7,
    base,
    baseRev: 0,
    values: values({tracking: 1.5}),
  });
  assert.equal(res.ok, true);
  const p = res.data!.pairs[0];
  for (const tier of ['desktop', 'tablet', 'mobile'] as const) {
    assert.equal(p.measures[tier].status, 'pending');
  }
});

test('签名随字号/字距/样例文字变化，字体未列出的档位参数也参与', () => {
  const v = values();
  const a = tierSignature(v, 'desktop');
  const b = tierSignature(values({size: 50}), 'desktop');
  const c = tierSignature(values({heading: 'Different'}), 'mobile');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, tierSignature(v, 'desktop'));
});

test('commitMeasuresBatch：签名过期的旧测量不允许覆盖新输入', () => {
  mutatePairs(() => [
    {...values(), id: 9, favorite: false, measures: pendingAll('queued')},
  ]);
  // 先写入 desktop 测量（有签名）
  const sig = tierSignature(values(), 'desktop');
  let next = commitMeasuresBatch([
    {pairId: 9, tier: 'desktop', measure: {status: 'measured', signature: sig, headingLines: 2, bodyLines: 3, overflow: false}},
  ])!;
  assert.equal(next.pairs[0].measures.desktop.headingLines, 2);
  // 模拟输入已变成 size=60 并提交（三档待测、携带新签名），随后旧帧拿着旧签名回报
  const newValues = values({size: 60});
  mutatePairs((ps) =>
    ps.map((p) => (p.id === 9 ? {...p, size: 60, measures: pendingForValues(newValues, 'dirty')} : p)),
  );
  commitMeasuresBatch([
    {pairId: 9, tier: 'desktop', measure: {status: 'measured', signature: sig, headingLines: 9, bodyLines: 9, overflow: true}},
  ]);
  const fresh = readStore();
  const m = fresh.pairs.find((p) => p.id === 9)!.measures.desktop;
  assert.notEqual(m.headingLines, 9, '旧签名测量必须被丢弃');
  assert.equal(m.status, 'pending', '过期测量被拒后该档保持待测');
});

test('导出 CSS 带三档行数与溢出；待测档位明确标注', () => {
  const pair: Pair = {
    ...values(),
    id: 1,
    favorite: false,
    measures: {
      desktop: {status: 'measured', signature: 'a', headingLines: 2, bodyLines: 4, overflow: false, measuredAt: 1},
      tablet: {status: 'measured', signature: 'b', headingLines: 3, bodyLines: 5, overflow: false, measuredAt: 1},
      mobile: {status: 'measured', signature: 'c', headingLines: 4, bodyLines: 6, overflow: true, measuredAt: 1},
    },
  };
  const css = buildCss(pair);
  assert.match(css, /desktop: 标题 2 行 · 正文 4 行 · 溢出 否/);
  assert.match(css, /mobile: 标题 4 行 · 正文 6 行 · 溢出 是/);
  assert.match(css, /@media \(max-width: 1000px\)/);
  assert.match(css, /@media \(max-width: 700px\)/);

  const pending = {...pair, measures: pendingAll('font-loading')};
  const css2 = buildCss(pending);
  assert.match(css2, /待测（字体未就绪或尚未重测，不得视为定稿）/);

  const summary = tierSummary(pair.measures);
  assert.equal(summary.length, 3);
  assert.equal(summary[2].status, 'measured');
});
