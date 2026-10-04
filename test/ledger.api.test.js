'use strict';

// 端到端：库存台账追溯（铅条原材 + 玻璃原片）
// 网页与 HTTP API 按材料类型/规格/时间范围逐笔查询发生时间、业务来源、
// 实物库存与净预留的增减及笔后余额；无记录返回空结果，非法筛选明确报错。
// 登记/调库、独立或整套单的确认和取消、裁片换单、盘点确认、领料确认
// 都与台账写入处于同一事务；预览、失败回滚及幂等重试不留下重复流水。
// 旧库首次启用按各规格当前实物库存和净预留建立基线，不倒推旧业务；
// 新登记规格从登记余额起记账，流水可顺序核对至当前余额。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39261';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `ledger-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const Database = require('better-sqlite3');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let PUB, PUB2;
let MID, RID, GID, BID;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function ledger(qs) {
  return api('GET', '/api/stock-ledger' + (qs ? `?${new URLSearchParams(qs)}` : ''));
}

// 建一张 100×100 两色拼片窗（左红右绿）并发布；再改成左红右蓝发布 v2
async function setupDesigns() {
  const d = await api('POST', '/api/designs', { name: '台账测试窗', width: 100, height: 100 });
  const designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  PUB = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;
  const pieces = (await api('GET', `/api/designs/${designId}`)).data.draft.pieces;
  const green = pieces.find((p) => p.color === '#00ff00');
  await api('PUT', `/api/designs/${designId}/pieces/${green.id}`, {
    color: '#0000ff', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  PUB2 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/materials'); break; } catch { await sleep(50); }
  }
  MID = (await api('POST', '/api/materials', { name: '300台账料', length: 300, stock: 10 })).data.material.id;
  RID = (await api('POST', '/api/glass-sheets', { color: '#FF0000', width: 600, height: 400, stock: 10 })).data.sheet.id;
  GID = (await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 600, height: 400, stock: 10 })).data.sheet.id;
  BID = (await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 600, height: 400, stock: 10 })).data.sheet.id;
  await setupDesigns();
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

function typeOf(entries, eventType) {
  return entries.filter((e) => e.eventType === eventType);
}

test('新登记规格从登记余额起记账：首笔 register 笔后余额=登记库存、净预留 0', async () => {
  const r = await ledger({ type: 'lead', specId: MID });
  assert.strictEqual(r.status, 200);
  const first = r.data.entries[0];
  assert.strictEqual(first.eventType, 'register');
  assert.strictEqual(first.stockChange, 10);
  assert.strictEqual(first.reserveChange, 0);
  assert.strictEqual(first.stockBalance, 10);
  assert.strictEqual(first.reserveBalance, 0);
  assert.ok(first.sourceRef.includes('原材登记'));
  assert.strictEqual(first.occurredAt.length, 19);

  const g = await ledger({ type: 'glass', specId: RID });
  const gf = g.data.entries[0];
  assert.strictEqual(gf.eventType, 'register');
  assert.strictEqual(gf.stockBalance, 10);
  assert.strictEqual(gf.specName, '#ff0000'); // 颜色大小写归一
  assert.strictEqual(gf.specWidth, 600);
  assert.strictEqual(gf.specHeight, 400);
});

test('计划确认/取消：净预留增减，实物库存不变；笔后余额顺序正确', async () => {
  const created = await api('POST', '/api/plans', { publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5 });
  const planId = created.data.plan.id;
  // 排产预览不产生台账流水
  await api('POST', '/api/plans/preview', { publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5 });
  const before = (await ledger({ type: 'lead', specId: MID })).data.entries.length;
  await api('POST', `/api/plans/${planId}/confirm`);
  let entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  assert.strictEqual(entries.length, before + 1);
  const confirm = typeOf(entries, 'plan_confirm')[0];
  assert.strictEqual(confirm.stockChange, 0);
  assert.ok(confirm.reserveChange > 0);
  assert.strictEqual(confirm.reserveBalance, confirm.reserveChange);
  assert.strictEqual(confirm.stockBalance, 10);
  assert.strictEqual(confirm.sourceType, 'plan');
  assert.strictEqual(confirm.sourceId, planId);

  // 重复确认不重复写流水
  await api('POST', `/api/plans/${planId}/confirm`);
  entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  assert.strictEqual(typeOf(entries, 'plan_confirm').length, 1);

  // 确认失败（缺口）整单回滚，不留流水
  const shortagePlan = (await api('POST', '/api/plans',
    { publicationId: PUB, materialId: MID, copies: 100, kerf: 0.5 })).data.plan.id;
  const before2 = entries.length;
  const failResp = await api('POST', `/api/plans/${shortagePlan}/confirm`);
  assert.strictEqual(failResp.status, 409);
  entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  assert.strictEqual(entries.length, before2);

  // 取消：净预留减少，且重复取消不重复写
  await api('POST', `/api/plans/${planId}/cancel`);
  await api('POST', `/api/plans/${planId}/cancel`);
  entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  const cancels = typeOf(entries, 'plan_cancel');
  assert.strictEqual(cancels.length, 1);
  assert.strictEqual(cancels[0].reserveChange, -confirm.reserveChange);
  assert.strictEqual(cancels[0].reserveBalance, 0);
  assert.strictEqual(cancels[0].stockBalance, 10);
});

test('裁片订单确认/取消：逐色净预留流水，取消各释放一次', async () => {
  const orderId = (await api('POST', '/api/cut-orders',
    { publicationId: PUB, copies: 1, gap: 0 })).data.order.id;
  await api('POST', '/api/cut-orders/preview', { publicationId: PUB, copies: 1, gap: 0 });
  await api('POST', `/api/cut-orders/${orderId}/confirm`);

  for (const sid of [RID, GID]) {
    const entries = (await ledger({ type: 'glass', specId: sid })).data.entries;
    const c = typeOf(entries, 'order_confirm');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].reserveChange, 1);
    assert.strictEqual(c[0].stockChange, 0);
    assert.strictEqual(c[0].reserveBalance, 1);
    assert.strictEqual(c[0].sourceId, orderId);
  }
  await api('POST', `/api/cut-orders/${orderId}/cancel`);
  for (const sid of [RID, GID]) {
    const entries = (await ledger({ type: 'glass', specId: sid })).data.entries;
    assert.strictEqual(typeOf(entries, 'order_cancel').length, 1);
    assert.strictEqual(entries[entries.length - 1].reserveBalance, 0);
    assert.strictEqual(entries[entries.length - 1].stockBalance, 10);
  }
});

test('裁片换单：旧单释放 + 新单承接两笔流水，幂等重试不重复', async () => {
  const oldId = (await api('POST', '/api/cut-orders',
    { publicationId: PUB, copies: 1, gap: 0 })).data.order.id;
  await api('POST', `/api/cut-orders/${oldId}/confirm`);

  // 预览不写流水
  const before = new Map();
  for (const sid of [RID, GID, BID]) {
    before.set(sid, (await ledger({ type: 'glass', specId: sid })).data.entries.length);
  }
  await api('POST', `/api/cut-orders/${oldId}/replacement/preview`, { targetVersion: 2, copies: 1, gap: 0 });
  for (const sid of [RID, GID, BID]) {
    assert.strictEqual((await ledger({ type: 'glass', specId: sid })).data.entries.length, before.get(sid));
  }

  const rep = await api('POST', `/api/cut-orders/${oldId}/replacement`,
    { targetVersion: 2, copies: 1, gap: 0 });
  const newId = rep.data.order.id;

  // 旧单色：红保留（新单仍有红），绿退出
  const green = (await ledger({ type: 'glass', specId: GID })).data.entries;
  const gr = typeOf(green, 'replace_release');
  assert.strictEqual(gr.length, 1);
  assert.strictEqual(gr[0].reserveChange, -1);
  assert.strictEqual(gr[0].reserveBalance, 0);
  assert.strictEqual(typeOf(green, 'replace_reserve').length, 0);

  // 红：旧释放后新承接，两笔；中间余额先降后升，最终净预留=1
  const red = (await ledger({ type: 'glass', specId: RID })).data.entries;
  assert.strictEqual(typeOf(red, 'replace_release').length, 1);
  assert.strictEqual(typeOf(red, 'replace_reserve').length, 1);
  const rel = typeOf(red, 'replace_release')[0];
  const res = typeOf(red, 'replace_reserve')[0];
  assert.ok(rel.id < res.id);
  assert.strictEqual(rel.reserveBalance, 0);
  assert.strictEqual(res.reserveBalance, 1);

  // 蓝：仅新单承接一笔
  const blue = (await ledger({ type: 'glass', specId: BID })).data.entries;
  assert.strictEqual(typeOf(blue, 'replace_reserve').length, 1);
  assert.strictEqual(blue[blue.length - 1].reserveBalance, 1);

  // 相同参数重试：幂等返回原新单，不重复流水
  await api('POST', `/api/cut-orders/${oldId}/replacement`, { targetVersion: 2, copies: 1, gap: 0 });
  const redAgain = (await ledger({ type: 'glass', specId: RID })).data.entries;
  assert.strictEqual(typeOf(redAgain, 'replace_reserve').length, 1);
  assert.strictEqual(newId, (await api('GET', `/api/cut-orders/${newId}`)).data.order.id);

  // 不同参数重试冲突且不写流水
  const conflict = await api('POST', `/api/cut-orders/${oldId}/replacement`,
    { targetVersion: 2, copies: 2, gap: 0 });
  assert.strictEqual(conflict.status, 409);
  const blueAgain = (await ledger({ type: 'glass', specId: BID })).data.entries;
  assert.strictEqual(typeOf(blueAgain, 'replace_reserve').length, 1);
});

test('整套单确认/取消：铅条与逐色玻璃各一笔，幂等不重复，取消各释放一次', async () => {
  const reqId = `ledger-combo-${process.pid}-1`;
  const created = await api('POST', '/api/combo-orders', {
    publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5, gap: 0, requestId: reqId,
  });
  assert.strictEqual(created.status, 201);
  const comboId = created.data.combo.id;

  const lead = (await ledger({ type: 'lead', specId: MID })).data.entries;
  const lc = typeOf(lead, 'combo_confirm');
  assert.strictEqual(lc.length, 1);
  assert.ok(lc[0].reserveChange > 0);
  assert.strictEqual(lc[0].stockChange, 0);
  assert.strictEqual(lc[0].sourceId, comboId);

  for (const sid of [RID, GID]) {
    const e = (await ledger({ type: 'glass', specId: sid })).data.entries;
    const cc = typeOf(e, 'combo_confirm');
    assert.strictEqual(cc.length, 1);
    assert.strictEqual(cc[0].reserveChange, 1);
  }

  // 同 requestId 重试幂等，不重复流水
  await api('POST', '/api/combo-orders', {
    publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5, gap: 0, requestId: reqId,
  });
  assert.strictEqual(typeOf((await ledger({ type: 'lead', specId: MID })).data.entries, 'combo_confirm').length, 1);

  // 取消：两类各释放一次；重复取消不重复
  await api('POST', `/api/combo-orders/${comboId}/cancel`);
  await api('POST', `/api/combo-orders/${comboId}/cancel`);
  const lead2 = (await ledger({ type: 'lead', specId: MID })).data.entries;
  assert.strictEqual(typeOf(lead2, 'combo_cancel').length, 1);
  assert.strictEqual(typeOf(lead2, 'combo_cancel')[0].reserveChange, -lc[0].reserveChange);
  for (const sid of [RID, GID]) {
    const e = (await ledger({ type: 'glass', specId: sid })).data.entries;
    assert.strictEqual(typeOf(e, 'combo_cancel').length, 1);
  }
});

test('盘点确认：实物库存增减有流水（净预留不变），预览/失败/重复确认不重复', async () => {
  // 先确认一张计划形成净预留 1，再盘点：铅条 10 → 8
  const planId = (await api('POST', '/api/plans',
    { publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5 })).data.plan.id;
  await api('POST', `/api/plans/${planId}/confirm`);
  const required = (await api('GET', `/api/plans/${planId}`)).data.plan.requiredBars;

  const prev = await api('POST', '/api/stocktakes/preview', {
    name: '台账盘点', items: [{ type: 'lead', specId: MID, counted: 8 }],
  });
  const stId = prev.data.stocktake.id;
  // 预览不改库存、不写流水
  const beforeN = (await ledger({ type: 'lead', specId: MID })).data.entries.length;
  const matAfterPreview = await api('GET', `/api/materials/${MID}`);
  assert.strictEqual(matAfterPreview.data.material.stock, 10);

  await api('POST', `/api/stocktakes/${stId}/confirm`);
  let entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  assert.strictEqual(entries.length, beforeN + 1);
  const st = typeOf(entries, 'stocktake')[0];
  assert.strictEqual(st.stockChange, -2);
  assert.strictEqual(st.reserveChange, 0);
  assert.strictEqual(st.stockBalance, 8);
  assert.strictEqual(st.reserveBalance, required);
  assert.strictEqual(st.sourceId, stId);

  // 重复确认幂等：不再调整库存、不重复流水
  await api('POST', `/api/stocktakes/${stId}/confirm`);
  entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  assert.strictEqual(typeOf(entries, 'stocktake').length, 1);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 8);

  // 盘点失败（低于预留）整单不生效、不写流水：净预留 required，实盘 0 应被拒
  const bad = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID, counted: 0 }],
  });
  const badId = bad.data.stocktake.id;
  const n0 = (await ledger({ type: 'lead', specId: MID })).data.entries.length;
  assert.strictEqual((await api('POST', `/api/stocktakes/${badId}/confirm`)).status, 409);
  assert.strictEqual((await ledger({ type: 'lead', specId: MID })).data.entries.length, n0);
});

test('手工调库：库存增减有流水，改名称不产生流水；低于净预留被拒不写', async () => {
  const before = (await ledger({ type: 'lead', specId: MID })).data.entries.length;
  await api('PATCH', `/api/materials/${MID}`, { name: '300台账料改' });
  assert.strictEqual((await ledger({ type: 'lead', specId: MID })).data.entries.length, before);

  await api('PATCH', `/api/materials/${MID}`, { stock: 9 });
  let entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  const adj = typeOf(entries, 'adjust').slice(-1)[0];
  assert.strictEqual(adj.stockChange, 1);
  assert.strictEqual(adj.reserveChange, 0);
  assert.strictEqual(adj.stockBalance, 9);

  // 库存调成相同值不产生流水
  await api('PATCH', `/api/materials/${MID}`, { stock: 9 });
  entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  assert.strictEqual(entries[entries.length - 1].id, adj.id);

  // 低于净预留拒绝且不写流水
  const n0 = entries.length;
  const reject = await api('PATCH', `/api/materials/${MID}`, { stock: 0 });
  assert.strictEqual(reject.status, 409);
  assert.strictEqual((await ledger({ type: 'lead', specId: MID })).data.entries.length, n0);
});

test('领料确认：实物库存与净预留同减；同号幂等/冲突不重复流水；非法整次不写', async () => {
  // 上一测试中的计划仍 confirmed，净预留 required、实物 9
  // 直接查出当前 confirmed 独立计划
  const plans = (await api('GET', '/api/plans')).data.plans;
  const plan = plans.find((p) => p.status === 'confirmed' && !p.comboId);
  assert.ok(plan, '需要一张已确认独立计划');
  const matBefore = (await api('GET', `/api/materials/${MID}`)).data.material;
  const reserveBefore = matBefore.reserved;
  const stockBefore = matBefore.stock;
  const issueNo = `LL-LEDGER-${process.pid}-1`;

  const ok = await api('POST', `/api/plans/${plan.id}/issues`, { issueNo, leadBars: 1 });
  assert.strictEqual(ok.status, 201);
  let entries = (await ledger({ type: 'lead', specId: MID })).data.entries;
  const iss = typeOf(entries, 'issue');
  assert.strictEqual(iss.length, 1);
  assert.strictEqual(iss[0].stockChange, -1);
  assert.strictEqual(iss[0].reserveChange, -1);
  assert.strictEqual(iss[0].stockBalance, stockBefore - 1);
  assert.strictEqual(iss[0].reserveBalance, reserveBefore - 1);
  assert.ok(iss[0].sourceRef.includes(issueNo));

  // 同号同内容重试：幂等，不重复扣减、不重复流水
  const retry = await api('POST', `/api/plans/${plan.id}/issues`, { issueNo, leadBars: 1 });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);
  assert.strictEqual(typeOf((await ledger({ type: 'lead', specId: MID })).data.entries, 'issue').length, 1);

  // 超剩余：整次拒绝，不写流水
  const n0 = (await ledger({ type: 'lead', specId: MID })).data.entries.length;
  const bad = await api('POST', `/api/plans/${plan.id}/issues`, { issueNo: 'LL-LEDGER-BAD', leadBars: 9999 });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual((await ledger({ type: 'lead', specId: MID })).data.entries.length, n0);
});

test('流水顺序核对至当前余额：sequential/tailMatches 为真；时间范围与空结果正确', async () => {
  for (const [type, specId] of [['lead', MID], ['glass', RID], ['glass', GID], ['glass', BID]]) {
    const r = await ledger({ type, specId: String(specId) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.sequential, true, `${type}#${specId} 顺序核对失败`);
    assert.strictEqual(r.data.tailMatches, true, `${type}#${specId} 末笔与当前余额不一致`);
    if (r.data.entries.length) {
      assert.strictEqual(r.data.entries[r.data.entries.length - 1].stockBalance, r.data.current.stock);
      assert.strictEqual(r.data.entries[r.data.entries.length - 1].reserveBalance, r.data.current.reserved);
    }
  }

  // 时间范围：未来日期返回空结果（200，空数组）
  const future = await ledger({ type: 'lead', specId: MID, from: '2099-01-01' });
  assert.strictEqual(future.status, 200);
  assert.deepStrictEqual(future.data.entries, []);
  assert.strictEqual(future.data.opening.stock, future.data.current.stock);
  assert.strictEqual(future.data.opening.reserved, future.data.current.reserved);

  // 登记规格从未有过业务：空结果（仅 register 一笔存在，故这里取一张临时新规格验证筛选）
  const freshId = (await api('POST', '/api/glass-sheets',
    { color: '#123456', width: 300, height: 300, stock: 0 })).data.sheet.id;
  const fresh = await ledger({ type: 'glass', specId: freshId, from: '2099-01-01' });
  assert.deepStrictEqual(fresh.data.entries, []);
  assert.strictEqual(fresh.data.current.stock, 0);

  // from/to 时刻式过滤（UTC，'T' 或空格分隔均可；含端点）：首笔前一刻到首笔时刻只含首笔
  const all = (await ledger({ type: 'lead', specId: MID })).data.entries;
  const first = all[0];
  const [day] = first.occurredAt.split(' ');
  const tIso = first.occurredAt.replace(' ', 'T');
  const prev = (() => {
    const dt = new Date(first.occurredAt.replace(' ', 'T') + 'Z');
    dt.setUTCSeconds(dt.getUTCSeconds() - 1);
    const pad = (n) => String(n).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ` +
           `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
  })();
  const onlyFirst1 = await ledger({ type: 'lead', specId: MID, from: prev, to: tIso });
  assert.deepStrictEqual(onlyFirst1.data.entries.map((e) => e.id), [first.id]);
  const onlyFirst2 = await ledger({ type: 'lead', specId: MID, from: prev, to: first.occurredAt });
  assert.deepStrictEqual(onlyFirst2.data.entries.map((e) => e.id), [first.id]);
  // 日期式 from 取整天起点、to 取整天终点，能取到当天全部
  const dayRows = await ledger({ type: 'lead', specId: MID, from: day, to: day });
  assert.strictEqual(dayRows.data.entries.length, all.length);
});

test('非法筛选明确报错，且不影响既有库存接口', async () => {
  assert.strictEqual((await ledger({})).status, 400);
  assert.strictEqual((await ledger({ type: 'wood', specId: 1 })).status, 400);
  assert.strictEqual((await ledger({ type: 'lead' })).status, 400);
  assert.strictEqual((await ledger({ type: 'lead', specId: 'abc' })).status, 400);
  assert.strictEqual((await ledger({ type: 'lead', specId: '0' })).status, 400);
  assert.strictEqual((await ledger({ type: 'lead', specId: '999999' })).status, 404);
  // 铅条/玻璃 id 空间独立，故“类型不符”用两张表都不存在的 id 验证按该类型查不到 → 404
  assert.strictEqual((await ledger({ type: 'glass', specId: '987654' })).status, 404);
  assert.strictEqual((await ledger({ type: 'lead', specId: '987654' })).status, 404);
  assert.strictEqual((await ledger({ type: 'lead', specId: MID, from: '2026-13-01' })).status, 400);
  assert.strictEqual((await ledger({ type: 'lead', specId: MID, from: '2026-02-30' })).status, 400);
  assert.strictEqual((await ledger({ type: 'lead', specId: MID, from: '01/02/2026' })).status, 400);
  assert.strictEqual((await ledger({ type: 'lead', specId: MID, from: '2026-01-01 25:00:00' })).status, 400);
  assert.strictEqual((await ledger({ type: 'lead', specId: MID, from: '2026-01-02', to: '2026-01-01' })).status, 400);

  // 既有库存接口行为保持兼容
  const mats = await api('GET', '/api/materials');
  assert.strictEqual(mats.status, 200);
  assert.ok(Array.isArray(mats.data.materials));
  const m = mats.data.materials.find((x) => x.id === MID);
  assert.ok(m);
  for (const k of ['stock', 'reserved', 'grossReserved', 'picked', 'remainingReserved', 'available']) {
    assert.ok(typeof m[k] === 'number', `库存视图字段 ${k} 保持可用`);
  }
  const sheets = await api('GET', '/api/glass-sheets');
  assert.strictEqual(sheets.status, 200);
  assert.ok(sheets.data.sheets.some((s) => s.id === RID));
});

test('旧库首次启用：按当前实物库存与净预留建立基线，不倒推旧业务；重开不重复', () => {
  // 构造一个“台账启用前”的旧库（无 stock_ledger/app_meta 表），含已确认计划预留 3 根
  const legacyPath = process.env.DB_PATH.replace(/ledger-test-[^.]+\.db$/, `ledger-legacy-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(legacyPath + suffix, { force: true }); } catch { /* ignore */ }
  }
  const raw = new Database(legacyPath);
  raw.exec(`
    CREATE TABLE designs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      width_mm INTEGER NOT NULL, height_mm INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE publications (id INTEGER PRIMARY KEY AUTOINCREMENT, design_id INTEGER NOT NULL,
      version INTEGER NOT NULL, snapshot TEXT NOT NULL, published_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE lead_materials (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      length_h INTEGER NOT NULL, stock INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE lead_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT NOT NULL,
      publication_id INTEGER NOT NULL, design_id INTEGER NOT NULL, version INTEGER NOT NULL,
      material_id INTEGER NOT NULL, material_name TEXT NOT NULL, material_length_h INTEGER NOT NULL,
      copies INTEGER NOT NULL, kerf_h INTEGER NOT NULL, required_bars INTEGER NOT NULL,
      segment_count INTEGER NOT NULL, layout TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT, canceled_at TEXT);
    CREATE TABLE glass_sheets (id INTEGER PRIMARY KEY AUTOINCREMENT, color TEXT NOT NULL UNIQUE,
      width_mm INTEGER NOT NULL, height_mm INTEGER NOT NULL, stock INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE cut_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT NOT NULL,
      publication_id INTEGER NOT NULL, design_id INTEGER NOT NULL, version INTEGER NOT NULL,
      copies INTEGER NOT NULL, gap_mm INTEGER NOT NULL, total_sheets INTEGER NOT NULL, layout TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT, canceled_at TEXT, replaced_at TEXT);
    CREATE TABLE cut_order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
      sheet_id INTEGER NOT NULL, sheet_color TEXT NOT NULL, sheet_width_mm INTEGER NOT NULL,
      sheet_height_mm INTEGER NOT NULL, required_sheets INTEGER NOT NULL);
    INSERT INTO designs (name,width_mm,height_mm) VALUES ('基线旧窗',100,100);
    INSERT INTO publications (design_id,version,snapshot) VALUES (1,1,'{}');
    INSERT INTO lead_materials (name,length_h,stock) VALUES ('旧6m',600000,10);
    INSERT INTO lead_plans (name,status,publication_id,design_id,version,material_id,material_name,
      material_length_h,copies,kerf_h,required_bars,segment_count,layout)
      VALUES ('旧计划','confirmed',1,1,1,1,'旧6m',600000,1,0,3,1,'{}');
    INSERT INTO glass_sheets (color,width_mm,height_mm,stock) VALUES ('#abcdef',500,500,4);
  `);
  raw.close();

  db.init(legacyPath);
  const d = db.getDb();
  const rows = d.prepare('SELECT * FROM stock_ledger ORDER BY id').all();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].spec_type, 'lead');
  assert.strictEqual(rows[0].event_type, 'baseline');
  assert.strictEqual(rows[0].stock_balance, 10);
  assert.strictEqual(rows[0].reserve_balance, 3); // 已确认计划预留 3 根
  assert.strictEqual(rows[0].stock_change, 0);
  assert.strictEqual(rows[0].reserve_change, 0);
  assert.strictEqual(rows[1].spec_type, 'glass');
  assert.strictEqual(rows[1].stock_balance, 4);
  assert.strictEqual(rows[1].reserve_balance, 0);
  assert.ok(rows[0].source_ref.includes('基线'));

  // 基线之后再启用一次（模拟重开服务）不重复建基线
  db.init(legacyPath);
  assert.strictEqual(d.prepare("SELECT COUNT(*) n FROM stock_ledger WHERE event_type='baseline'").get().n, 2);

  // 基线之后的业务照常续记：确认新计划使净预留增加，余额可顺序核对
  const m2 = d.prepare("SELECT id FROM lead_materials WHERE name='旧6m'").get().id;
  db.getMaterial(m2); // sanity
  // 直接走 db 层确认一张新计划
  const pubId = d.prepare('SELECT id FROM publications').get().id;
  const info = d.prepare(`INSERT INTO lead_plans
    (name,status,publication_id,design_id,version,material_id,material_name,material_length_h,
     copies,kerf_h,required_bars,segment_count,layout)
    VALUES ('基线后计划','draft',?,1,1,?,'旧6m',600000,1,0,2,1,'{}')`).run(pubId, m2);
  const r = db.confirmPlan(info.lastInsertRowid);
  assert.strictEqual(r.code, 'ok');
  const led = d.prepare('SELECT * FROM stock_ledger WHERE spec_type=? AND spec_id=? ORDER BY id').all('lead', m2);
  assert.strictEqual(led.length, 2);
  assert.strictEqual(led[1].event_type, 'plan_confirm');
  assert.strictEqual(led[1].reserve_change, 2);
  assert.strictEqual(led[1].reserve_balance, 5); // 3（基线）+ 2
  assert.strictEqual(led[1].stock_balance, 10);
  d.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(legacyPath + suffix, { force: true }); } catch { /* ignore */ }
  }
});
