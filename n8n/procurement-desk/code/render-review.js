// Builds the review page. n8n's form HTML sanitizer drops class/style attributes, so sections
// are tagged with hidden <a href="#dd-NAME"></a> markers that the theme CSS (on the form trigger) styles.
const call = $input.first().json;
const r = call.output || {};
const req = $('Prepare Request').first().json;
const analystName = $('Choose Analyst').first().json.analystName || 'Due Diligence Analyst';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mk = (k) => '<a href="#dd-' + k + '"></a>';
const short = (h) => (h && h.length > 14 ? h.slice(0, 6) + '…' + h.slice(-4) : h || '');
const txLink = (h) => (h ? '<a href="https://sepolia.basescan.org/tx/' + esc(h) + '" target="_blank" rel="noopener"><code>' + esc(short(h)) + '</code></a>' : '<em>none</em>');
const usd = (n) => '$' + Number(n || 0).toFixed(2);
const cap = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const nice = (s) => esc(cap(s));
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; };
const has = (v) => v !== undefined && v !== null && v !== '';
const kv = (rows) => mk('kv') + '<table><tbody>' + rows.filter((x) => has(x[1])).map((x) => '<tr><th scope="row">' + esc(x[0]) + '</th><td>' + x[1] + '</td></tr>').join('') + '</tbody></table>';
const AIRNODES = { gleif: 'GLEIF', 'companies-house': 'Companies House', publicaml: 'PublicAML', 'kleros-scout': 'Kleros Scout', web3bio: 'Web3.bio', briefpixel: 'Briefpixel' };
const airnodeName = (s) => { const k = String(s || '').replace(/^AirnodeHub\s+/, '').replace(/^airnode-/, ''); return AIRNODES[k] || k.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); };

const lvl = (level) => {
  const l = String(level || '').toLowerCase();
  if (l === 'info' || l === 'note' || !l) return ['note', 'Note'];
  if (['high', 'critical', 'severe', 'block', 'blocked', 'error', 'fail'].includes(l)) return ['bad', 'High'];
  return ['warn', l === 'warn' || l === 'warning' ? 'Warning' : l.charAt(0).toUpperCase() + l.slice(1)];
};
const findings = (flags, okText) => {
  const list = (flags || []).slice().sort((a, b) => (a.level === 'info') - (b.level === 'info'));
  const items = list.map((f) => { const [k, label] = lvl(f.level); return '<li>' + mk('lvl-' + k) + '<b>' + label + '</b><span>' + esc(f.message) + '</span></li>'; });
  if (!list.some((f) => f.level !== 'info')) items.unshift('<li>' + mk('lvl-ok') + '<b>Clear</b><span>' + esc(okText) + '</span></li>');
  return '<h4>Findings</h4>' + mk('findings') + '<ul>' + items.join('') + '</ul>';
};
const chip = (tone, text) => mk('chip-' + tone) + '<b>' + esc(text) + '</b>';

// verdict + risk
const verdict = String(r.verdict || 'UNKNOWN').toUpperCase();
const vTone = { APPROVE: 'ok', ESCALATE: 'warn', REJECT: 'bad' }[verdict] || 'warn';
const vText = { APPROVE: 'Approve', ESCALATE: 'Escalate', REJECT: 'Reject' }[verdict] || verdict;
const risk = Math.max(0, Math.min(100, Number(r.riskScore) || 0));
const band = risk >= 70 ? 'bad' : risk >= 30 ? 'warn' : 'ok';
const bandText = { ok: 'Low risk', warn: 'Medium risk', bad: 'High risk' }[band];
const bucket = Math.round(risk / 10) * 10;
const analystPaid = Number(call.paymentUsd || 0);
const netPayments = (r.payments || []).filter((p) => p.txn);
const subject = r.subject || {};
const srcVerified = Number(r.sourcesVerified || 0), srcTotal = Number(r.sourcesTotal || 0);

const hero = mk('hero') + '<div>'
  + '<p>Analyst recommendation</p>'
  + mk('v-' + vTone) + '<h2>' + esc(vText) + '</h2>'
  + '<h1>' + esc(subject.companyName || req.companyName) + '</h1>'
  + '<p>' + [subject.companyNumber && 'Company no. ' + esc(subject.companyNumber), subject.lei && 'LEI ' + esc(subject.lei), 'Request ' + esc(r.requestId || req.requestId)].filter(Boolean).map((x) => '<span>' + x + '</span>').join(' · ') + '</p>'
  + mk('stats') + '<ul>'
  + '<li><span>Risk score</span><strong>' + risk + '<sub>/ 100</sub></strong>' + mk('band-' + band) + mk('r-' + bucket) + '<span></span><em>' + bandText + '</em></li>'
  + '<li><span>Signed sources</span><strong>' + srcVerified + '<sub>/ ' + srcTotal + '</sub></strong><em>' + (srcTotal && srcVerified === srcTotal ? 'All signatures re-verified' : (srcTotal - srcVerified) + ' could not be verified') + '</em></li>'
  + '<li><span>Cost to you</span><strong>' + usd(analystPaid) + '</strong><em>Paid to the Analyst in aUSD</em></li>'
  + '<li><span>Analyst network spend</span><strong>' + usd(r.totalNetworkSpendUsd) + '</strong><em>' + netPayments.length + ' sub-payments, out of the $' + analystPaid.toFixed(2) + ' fee</em></li>'
  + '</ul></div>';

const summary = mk('summary') + '<div><h3>Analyst summary</h3><p>' + esc(r.narrative || 'No summary was returned.') + '</p>'
  + ((r.reasons || []).length ? '<ul>' + r.reasons.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '')
  + '<p><em>Written by ' + esc(r.narrativeBy || r.preparedBy || analystName) + (r.preparedAt ? ' · ' + fmtDate(r.preparedAt) : '') + '</em></p></div>';

// company
const c = r.company || {}, co = c.company || {}, ent = c.entity || {};
const ratingTone = { low: 'ok', medium: 'warn', high: 'bad' }[String(c.rating || '').toLowerCase()] || 'neutral';
const officers = (c.officers && c.officers.current) || [];
const officerList = officers.slice(0, 4).map((o) => esc(o.name) + ' <em>' + esc(o.role) + '</em>').join('<br>') + (officers.length > 4 ? '<br><em>+' + (officers.length - 4) + ' more</em>' : '');
const companyPanel = mk('panel') + '<div>'
  + '<div><h3>Company</h3>' + (c.rating ? chip(ratingTone, cap(c.rating) + ' risk') : chip('neutral', 'Not available')) + '<p>Counterparty Check · Companies House and GLEIF</p></div>'
  + (c.company || c.entity ? kv([
    ['Registered name', esc(co.name || ent.legalName)],
    ['Status', co.status ? nice(co.status) + (co.accountsOverdue || co.confirmationStatementOverdue ? ' · filings overdue' : ' · filings current') : ''],
    ['Incorporated', esc(co.incorporatedOn) + (co.type ? ' · ' + esc(String(co.type).toUpperCase()) : '')],
    ['Registered office', esc(co.registeredOffice)],
    ['LEI', ent.lei ? '<code>' + esc(ent.lei) + '</code>' + (ent.status ? ' ' + nice(ent.status) : '') : ''],
    ['Officers', c.officers ? esc(c.officers.activeCount) + ' active' + (officerList ? '<br>' + officerList : '') : ''],
    ['Significant control', c.controllers ? esc(c.controllers.activeCount) + ' registrable person(s)' : ''],
    ['Ultimate parent', c.parent ? esc(c.parent.parentLei || nice(c.parent.reason)) : ''],
    ['Insolvency / charges', co.name ? (co.hasInsolvencyHistory ? 'Insolvency history' : 'No insolvency') + ' · ' + (co.hasCharges ? 'charges registered' : 'no charges') : ''],
  ]) : '<p>' + esc(c.summary || 'The company check did not return data.') + '</p>')
  + findings(c.flags, 'No company issues found') + '</div>';

// wallet
const w = r.wallet || {}, ws = w.screening || {};
const wv = String(w.verdict || '').toLowerCase();
const wTone = wv === 'clean' ? 'ok' : ['blocked', 'high', 'sanctioned', 'reject'].includes(wv) ? 'bad' : wv ? 'warn' : 'neutral';
const walletPanel = mk('panel') + '<div>'
  + '<div><h3>Payment wallet</h3>' + chip(wTone, w.verdict ? cap(w.verdict) : 'Not available') + '<p>Wallet Risk Screener · PublicAML, Kleros Scout and Web3.bio</p></div>'
  + kv([
    ['Address', '<code>' + esc(subject.walletAddress || req.walletAddress) + '</code>'],
    ['Chain', nice(subject.chain || req.chain)],
    ['AML risk score', has(ws.riskScore) ? esc(ws.riskScore) + ' / 100' + (ws.riskLevel ? ' · ' + nice(ws.riskLevel) : '') : ''],
    ['Label', esc(ws.label)],
    ['Known names', (w.identity || []).length ? esc(w.identity.map((i) => i.name).join(', ')) : ''],
    ['Sanctions', has(ws.sanctioned) ? (ws.sanctioned ? 'Sanctioned' : 'Not sanctioned') + ' · ' + esc(ws.sanctionedCounterparties || 0) + ' sanctioned counterparties' : ''],
    ['Mixer exposure', has(ws.mixerCounterparties) ? esc(ws.mixerCounterparties) + ' counterparties' : ''],
  ])
  + findings(w.flags, 'No wallet issues found') + '</div>';

// news + request
const news = r.news || {};
const adverse = news.adverse || [];
const newsPanel = mk('panel') + '<div>'
  + '<div><h3>Adverse media</h3>' + (news.status === 'checked' ? chip(adverse.length ? 'warn' : 'ok', adverse.length ? adverse.length + ' possibly adverse' : 'None found') : chip('neutral', 'Not checked')) + '<p>Briefpixel news search</p></div>'
  + (news.status === 'checked'
    ? '<p>' + esc(news.total || 0) + ' recent article(s) found, ' + adverse.length + ' possibly adverse.</p>'
      + (adverse.length ? mk('findings') + '<ul>' + adverse.slice(0, 5).map((a) => '<li>' + mk('lvl-warn') + '<b>News</b><span>' + (a.url ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.title || a.url) + '</a>' : esc(a.title || '')) + '</span></li>').join('') + '</ul>' : '')
    : '<p>News was not checked for this request.</p>')
  + '</div>';
const requestPanel = mk('panel') + '<div><div><h3>Request</h3><p>As submitted to the Procurement Desk</p></div>'
  + kv([['Requested by', esc(req.requestedBy)], ['Purpose', esc(subject.purpose || req.purpose)], ['Request ID', '<code>' + esc(r.requestId || req.requestId) + '</code>'], ['Analyst task', call.taskId ? '<code>' + esc(call.taskId) + '</code>' : '']])
  + '</div>';

// payments
const srcByTx = {};
(r.sources || []).forEach((s) => { if (s.paymentTxn) srcByTx[s.paymentTxn] = s.label; });
const payRows = [{ from: 'Procurement Desk', to: analystName, what: 'Due diligence report', usd: analystPaid, txn: call.paymentTxn }]
  .concat((r.payments || []).map((p) => ({ from: p.from, to: /airnode/i.test(p.to) ? 'AirnodeHub · ' + airnodeName(p.to) : p.to, what: p.what === 'hire' ? 'Hired for this request' : srcByTx[p.txn] || p.what, usd: p.usd, txn: p.txn })));
const paymentsPanel = mk('panel') + '<div><div><h3>Payment trail</h3>' + chip('neutral', payRows.filter((p) => p.txn).length + ' on-chain payments') + '<p>Every hire and data purchase, settled in aUSD on Base Sepolia over x402</p></div>'
  + mk('table') + '<div><table><thead><tr><th>Payer → payee</th><th>For</th><th>Amount</th><th>Transaction</th></tr></thead><tbody>'
  + payRows.map((p) => '<tr><td headers="Payment"><b>' + esc(p.from) + '</b><em>→ ' + esc(p.to) + '</em></td><td headers="For">' + esc(p.what) + '</td><td headers="Amount">' + usd(p.usd) + '</td><td headers="Transaction">' + txLink(p.txn) + '</td></tr>').join('')
  + '</tbody></table></div>'
  + mk('total') + '<p><span>Cost to you <b>' + usd(analystPaid) + '</b></span><span>Analyst passed on <b>' + usd(r.totalNetworkSpendUsd) + '</b> to specialists and AirnodeHub</span></p></div>';

// sources
const sourcesPanel = mk('panel') + '<div><div><h3>Signed sources</h3>' + chip(srcTotal && srcVerified === srcTotal ? 'ok' : 'warn', srcVerified + ' of ' + srcTotal + ' verified') + '<p>Each record is signed by its AirnodeHub airnode; the Analyst re-checked every signature</p></div>'
  + mk('table') + '<div><table><thead><tr><th>Source</th><th>Fetched by</th><th>Signed</th><th>Signer</th><th>Signature</th></tr></thead><tbody>'
  + (r.sources || []).map((s) => '<tr><td headers="Source"><b>' + esc(s.label) + '</b><em>' + esc(airnodeName(s.airnode)) + '</em></td><td headers="Fetched by">' + esc(s.agent) + '</td><td headers="Signed">' + fmtDate(s.signedAt) + '</td><td headers="Signer"><code>' + esc(short(s.signer)) + '</code></td><td headers="Signature">' + (s.verified ? mk('ok') + '<b>Verified</b>' : mk('fail') + '<b>' + esc(s.error || 'Failed') + '</b>') + '</td></tr>').join('')
  + '</tbody></table></div></div>';

const html = mk('report') + '<div>' + hero + summary
  + mk('grid') + '<div>' + companyPanel + walletPanel + '</div>'
  + mk('grid') + '<div>' + newsPanel + requestPanel + '</div>'
  + paymentsPanel + sourcesPanel + '</div>';

return [{ json: { html, report: r, analystPaidUsd: analystPaid, analystPaymentTxn: call.paymentTxn || null, analystTaskId: call.taskId || null } }];
