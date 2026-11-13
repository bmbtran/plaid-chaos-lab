// How does /transactions/refresh post pending transactions over time? Prints counts only.
import { SandboxApi, loadSandboxCredentials } from '../src/sandbox/api.ts';
const api = new SandboxApi(loadSandboxCredentials());
const t0 = Date.now(); const el = () => `${((Date.now()-t0)/1000).toFixed(0)}s`;
const item = await api.createItem();
let d = await api.drain(item.accessToken);
while (d.status !== 'HISTORICAL_UPDATE_COMPLETE') { await new Promise(r=>setTimeout(r,1500)); d = await api.drain(item.accessToken); }
const show = (lbl: string, x: typeof d) => console.log(el(), lbl, `n=${x.transactions.length} pending=${x.transactions.filter(t=>t.pending).length} linked=${x.transactions.filter(t=>t.pending_transaction_id).length}`);
show('ready', d);
for (const round of [1,2]) {
  await api.refreshTransactions(item.accessToken); console.log(el(), `refresh #${round}`);
  for (let i=0;i<20;i++) { await new Promise(r=>setTimeout(r,3000)); const x = await api.drain(item.accessToken).catch(e=>null); if (!x) { console.log(el(),'drain error'); continue; } if (x.transactions.length !== d.transactions.length || x.transactions.filter(t=>t.pending_transaction_id).length) { show(`  changed after poll ${i}`, x); d = x; break; } if (i===19) show('  no change after 60s', x); }
}
await api.removeItem(item.accessToken);
