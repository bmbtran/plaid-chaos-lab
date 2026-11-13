// Probe real Sandbox behavior. Prints only counts, codes and timings — never credentials.
import { SandboxApi, loadSandboxCredentials, PlaidHttpError } from '../src/sandbox/api.ts';
const api = new SandboxApi(loadSandboxCredentials());
const t0 = Date.now(); const el = () => `${((Date.now()-t0)/1000).toFixed(1)}s`;
const summarize = (d: Awaited<ReturnType<typeof api.drain>>) => {
  const pending = d.transactions.filter(t=>t.pending).length;
  const linked = d.transactions.filter(t=>t.pending_transaction_id).length;
  const accts = new Set(d.transactions.map(t=>t.account_id)).size;
  return `n=${d.transactions.length} pending=${pending} postedWithPendingId=${linked} accounts=${accts} pages(500)=${d.pages} status=${d.status}`;
};
try {
  const item = await api.createItem();
  console.log(el(), 'item created', item.itemId.slice(0,6)+'…');
  let d = await api.drain(item.accessToken);
  console.log(el(), 'drain #0', summarize(d));
  for (let i=0; i<20 && d.status !== 'HISTORICAL_UPDATE_COMPLETE'; i++) { await new Promise(r=>setTimeout(r,2000)); d = await api.drain(item.accessToken); }
  console.log(el(), 'drain ready', summarize(d));
  const p1 = await api.transactionsSync({ access_token: item.accessToken, cursor: '', count: 100 });
  console.log(el(), 'app-style page1 count=100: added', p1.added.length, 'has_more', p1.has_more);
  console.log(el(), 'sample txn keys:', Object.keys(d.transactions[0]).join(','));
  const before = new Set(d.transactions.map(t=>t.transaction_id));
  const pendingBefore = d.transactions.filter(t=>t.pending).map(t=>t.transaction_id);
  await api.createTransactions(item.accessToken, [{amount: 12.34, date_transacted: new Date().toISOString().slice(0,10), date_posted: new Date().toISOString().slice(0,10), description: 'CHAOS LAB COFFEE'}]);
  console.log(el(), 'created 1 txn');
  let d2 = await api.drain(item.accessToken);
  console.log(el(), 'after create (no refresh):', summarize(d2), 'new ids', d2.transactions.filter(t=>!before.has(t.transaction_id)).length);
  await api.refreshTransactions(item.accessToken);
  console.log(el(), 'refresh called');
  for (let i=0;i<15;i++){ await new Promise(r=>setTimeout(r,2000)); d2 = await api.drain(item.accessToken); const nw = d2.transactions.filter(t=>!before.has(t.transaction_id)); if (nw.length) { console.log(el(), `poll ${i}: new=${nw.length}`); break; } }
  const after = new Map(d2.transactions.map(t=>[t.transaction_id,t]));
  const nowPosted = pendingBefore.filter(id => !after.has(id)).length;
  const replacements = d2.transactions.filter(t => t.pending_transaction_id && pendingBefore.includes(t.pending_transaction_id)).length;
  const created = d2.transactions.find(t => t.name?.includes('CHAOS LAB'));
  console.log(el(), 'after refresh', summarize(d2), `pendingRemoved=${nowPosted} replacementsOfOldPending=${replacements} createdFound=${!!created} createdPending=${created?.pending}`);
  const fw = await api.fireWebhook(item.accessToken, 'SYNC_UPDATES_AVAILABLE').catch(e=>e);
  console.log(el(), 'fire_webhook SYNC (no webhook url):', fw instanceof PlaidHttpError ? fw.body.error_code : JSON.stringify(fw));
  await api.resetLogin(item.accessToken);
  const ig = await api.itemGet(item.accessToken);
  console.log(el(), 'after reset_login item.error=', ig.item.error?.error_code);
  const s = await api.transactionsSync({ access_token: item.accessToken, cursor: '' }).catch(e=>e);
  console.log(el(), 'sync during login required:', s instanceof PlaidHttpError ? s.body.error_code : 'succeeded');
  const fr = await api.fireWebhook(item.accessToken, 'LOGIN_REPAIRED').catch(e=>e);
  console.log(el(), 'fire LOGIN_REPAIRED:', fr instanceof PlaidHttpError ? fr.body.error_code : JSON.stringify(fr), 'item.error now=', (await api.itemGet(item.accessToken)).item.error?.error_code ?? null);
  await api.removeItem(item.accessToken); console.log(el(), 'item removed');
} catch (e) { console.log('ERROR', e instanceof PlaidHttpError ? `${e.endpoint} ${e.body.error_code} ${e.body.error_message}` : (e as Error).message); }
