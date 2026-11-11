
const req = $('Prepare Request').first().json;
// the failure arrives on the Hire node's error output (branch 1)
let hire = {};
try { hire = $('Hire Due Diligence Analyst').first(1).json || {}; } catch (e) { try { hire = $('Hire Due Diligence Analyst').first().json || {}; } catch (e2) { hire = {}; } }
const chosen = $('Choose Analyst').first().json;
const reason = hire.error || (chosen.found === false ? 'No Due Diligence Analyst was found on Zynd.' : 'The Analyst did not answer.');
const html = ddPage({
  tone: 'bad', icon: '✕', eyebrow: 'Request failed', title: 'Due diligence could not be completed',
  lead: 'The Due Diligence Analyst could not finish the check for <b>' + esc(req.companyName) + '</b>. Nothing was charged for the failed job.',
  note: '',
  rows: [
    ['Request ID', '<code>' + esc(req.requestId) + '</code>'],
    ['Reason', esc(reason)],
    ['Status', 'Logged as FAILED in the audit table'],
  ],
  foot: 'Procurement Desk · Zynd × AirnodeHub',
});
return [{ json: { html } }];
