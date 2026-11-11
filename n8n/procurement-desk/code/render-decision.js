
const req = $('Prepare Request').first().json;
const view = $('Render Review Page').first().json;
const d = $('Review and Decide').first().json;
const r = view.report || {};
const map = { 'Approve supplier': ['ok', '✓', 'Supplier approved', 'APPROVE'], 'Reject supplier': ['bad', '✕', 'Supplier rejected', 'REJECT'] };
const [tone, icon, title, code] = map[d.decision] || ['warn', '!', 'Escalated for enhanced due diligence', 'ESCALATE'];
const rec = String(r.verdict || '').toUpperCase();
const recText = { APPROVE: 'Approve', ESCALATE: 'Escalate', REJECT: 'Reject' }[rec] || rec || 'Unknown';
const tx = view.analystPaymentTxn;
const html = ddPage({
  tone, icon, eyebrow: 'Decision recorded', title,
  lead: '<b>' + esc(req.companyName) + '</b> is logged in the audit table with the signed report, every payment and every source signature.',
  note: rec && rec !== code ? 'Your decision differs from the Analyst recommendation (<b>' + esc(recText) + '</b>). Your comment is stored with the record.' : '',
  rows: [
    ['Request ID', '<code>' + esc(req.requestId) + '</code>'],
    ['Decision', esc(d.decision)],
    ['Analyst recommendation', esc(recText) + ' · risk ' + esc(r.riskScore != null ? r.riskScore : '?') + '/100'],
    ['Approver', esc(d.approver)],
    ['Comment', d.comment ? esc(d.comment) : ''],
    ['Signed sources', esc(r.sourcesVerified) + ' of ' + esc(r.sourcesTotal) + ' verified'],
    ['Cost', '$' + Number(view.analystPaidUsd || 0).toFixed(2) + ' aUSD'],
    ['Payment', tx ? '<a href="https://sepolia.basescan.org/tx/' + esc(tx) + '" target="_blank" rel="noopener"><code>' + esc(short(tx)) + '</code></a> on Base Sepolia' : ''],
    ['Recorded', new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'],
  ],
  foot: 'Procurement Desk · Zynd × AirnodeHub',
});
return [{ json: { html } }];
