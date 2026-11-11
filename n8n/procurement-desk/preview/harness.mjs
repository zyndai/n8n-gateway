// Renders the Procurement Desk form pages with n8n's own templates and HTML sanitizer, then
// screenshots them at desktop and phone widths in light and dark mode.
// Exits non-zero when a page scrolls sideways or the CSS sanitizer changes the theme.
// Run `npm run setup` once (installs deps, fetches the n8n templates), then `npm run preview`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import Handlebars from 'handlebars';
import sanitize from 'sanitize-html';
import { chromium } from 'playwright';
import { triggerParams } from '../trigger-params.mjs';

const here = (p) => new URL(p, import.meta.url).pathname;
const TPL = here('../.cache/n8n/package/templates/');
const OUT = here('../out/');
if (!existsSync(TPL)) {
  console.error('n8n templates missing: run `npm run setup` first');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
let failed = false;

Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('includes', (a, b) => String(a || '').includes(b));
Handlebars.registerPartial('formHostNavigation', readFileSync(TPL + 'partials/formHostNavigation.handlebars', 'utf8'));
const formTpl = Handlebars.compile(readFileSync(TPL + 'form-trigger.handlebars', 'utf8'));
const doneTpl = Handlebars.compile(readFileSync(TPL + 'form-trigger-completion.handlebars', 'utf8'));

// --- mirrors n8n-nodes-base 2.47.0 dist/nodes/Form/utils/utils.js (sanitizeHtml, sanitizeCustomCss, prepareFormData) ---
const sanitizeHtml = (text) => sanitize(text, {
  allowedTags: ['b', 'div', 'i', 'iframe', 'img', 'video', 'source', 'em', 'strong', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'u', 'sub', 'sup', 'code', 'pre', 'span', 'br', 'ul', 'ol', 'li', 'p', 'table', 'thead', 'tbody', 'tfoot', 'td', 'tr', 'th'],
  allowedAttributes: {
    a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'], video: ['controls', 'autoplay', 'loop', 'muted', 'poster', 'width', 'height'],
    iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'referrerpolicy'], source: ['src', 'type'],
    td: ['colspan', 'rowspan', 'scope', 'headers'], th: ['colspan', 'rowspan', 'scope', 'headers'],
  },
  allowedSchemes: ['https', 'http'], allowedSchemesByTag: { source: ['https', 'http'], iframe: ['https', 'http'] }, allowProtocolRelative: false,
});
const sanitizeCustomCss = (css) => sanitize(css, { allowedTags: [], allowedAttributes: {} }).replace(/&gt;/g, '>').replace(/&amp;(?!(?:lt|gt|amp);)/g, '&');
const prepareFields = (fields) => fields.map((field, index) => {
  const input = { id: `field-${index}`, errorId: `error-field-${index}`, label: field.fieldLabel, inputRequired: field.requiredField ? 'form-required' : '', defaultValue: field.defaultValue ?? '', placeholder: field.placeholder };
  const t = field.fieldType;
  if (t === 'radio' || t === 'checkbox') {
    input.isMultiSelect = true;
    input.multiSelectOptions = field.fieldOptions.values.map((e, i) => ({ id: `option${i}_${input.id}`, label: e.option }));
    if (t === 'radio') input.radioSelect = 'radio';
  } else if (t === 'dropdown') { input.isSelect = true; input.selectOptions = field.fieldOptions.values.map((e) => e.option); }
  else if (t === 'textarea') input.isTextarea = true;
  else if (t === 'html') { input.isHtml = true; input.html = sanitizeHtml(field.html); }
  else { input.isInput = true; input.type = t || 'text'; }
  return input;
});
// ---------------------------------------------------------------------------------------------------------------

const css = triggerParams.options.customCss;
const cleanCss = sanitizeCustomCss(css);
if (cleanCss !== css) {
  failed = true;
  const a = css.split('\n'), b = cleanCss.split('\n');
  a.forEach((l, i) => { if (l !== b[i]) console.error('theme.css line', i + 1, 'is changed by n8n\'s CSS sanitizer:\n  ', l, '\n->', b[i]); });
}
const renderForm = ({ title, description, fields, button }) => formTpl({
  formTitle: title, formDescription: description, formSubmittedText: 'Your response has been recorded', formFields: prepareFields(fields),
  useResponseData: true, appendAttribution: false, buttonLabel: button, dangerousCustomCss: cleanCss, testRun: false,
});

// Run a Code node body with n8n-like $ / $input. `nodes` maps node name -> json (branch 1 via __branch1).
const runCode = (file, nodes, input, prelude = '') => {
  const body = prelude + readFileSync(here('../code/' + file), 'utf8');
  const $ = (name) => ({
    first: (branch) => {
      if (!(name in nodes)) throw new Error('no node ' + name);
      const v = nodes[name];
      return { json: branch === 1 && v.__branch1 ? v.__branch1 : v };
    },
  });
  return new Function('$', '$input', body)($, { first: () => ({ json: input }) })[0].json;
};

const reviewFields = (html) => [
  { fieldType: 'html', html },
  { fieldLabel: 'Choose an outcome. It is saved with the report.', fieldName: 'decision', fieldType: 'radio', requiredField: true, fieldOptions: { values: [{ option: 'Approve supplier' }, { option: 'Reject supplier' }, { option: 'Escalate for enhanced due diligence' }] } },
  { fieldLabel: 'Approver name', fieldName: 'approver', fieldType: 'text', requiredField: true, placeholder: 'Your full name' },
  { fieldLabel: 'Comment', fieldName: 'comment', fieldType: 'textarea', placeholder: 'Optional. Explain your reasoning, especially if you differ from the Analyst.' },
];
const reviewPage = (html) => renderForm({ title: 'Due diligence report', description: 'Procurement Desk · review the signed report, then record your decision.', fields: reviewFields(html), button: 'Record decision' });

const pages = {};
pages.request = renderForm({ title: triggerParams.formTitle, description: triggerParams.formDescription, fields: triggerParams.formFields.values, button: triggerParams.options.buttonLabel });

const fx = JSON.parse(readFileSync(here('./fixture-approve.json'), 'utf8'));
const review = (f) => runCode('render-review.js', { 'Prepare Request': f.prepare, 'Choose Analyst': f.analyst }, f.call);
const rv = review(fx);
pages.review = reviewPage(rv.html);

// Risky variant: blocked wallet, warnings, one failed signature, adverse news.
const bad = structuredClone(fx);
const o = bad.call.output;
o.verdict = 'REJECT'; o.riskScore = 100;
o.wallet.verdict = 'blocked';
o.wallet.screening = { ...o.wallet.screening, label: 'Tornado Cash: Router', riskLevel: 'HIGH', riskScore: 100, sanctioned: true, sanctionedCounterparties: 12, mixerCounterparties: 340 };
o.wallet.flags = [{ level: 'high', message: 'Address is on the OFAC SDN list (Tornado Cash)' }, { level: 'warn', message: 'Direct exposure to mixers: 340 counterparties' }, { level: 'info', message: 'Kleros Scout tag: Tornado Cash Router' }];
o.wallet.identity = [];
o.subject.walletAddress = '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b';
o.company.flags.unshift({ level: 'warn', message: 'Confirmation statement overdue by 23 days' });
o.sources[5].verified = false; o.sources[5].error = 'Signer mismatch'; o.sourcesVerified = 8;
o.news = { status: 'checked', total: 4, adverse: [{ title: 'Regulator opens probe into supplier payments routed through mixer', url: 'https://example.com/news/1' }] };
pages['review-reject'] = reviewPage(review(bad).html);

const done = readFileSync(here('../code/done-page.js'), 'utf8');
const dec = runCode('render-decision.js', { 'Prepare Request': fx.prepare, 'Render Review Page': rv, 'Review and Decide': { decision: 'Reject supplier', approver: 'James Okafor', comment: 'Wallet resolves to a private individual, not the supplier. Ask for a corporate wallet.' } }, {}, done);
pages.decision = doneTpl({ formTitle: 'Supplier due diligence', responseText: dec.html, appendAttribution: false });
const fail = runCode('render-failure.js', { 'Prepare Request': fx.prepare, 'Choose Analyst': fx.analyst, 'Hire Due Diligence Analyst': { __branch1: { error: 'Payment failed: insufficient aUSD balance on the developer wallet' } } }, {}, done);
pages.failure = doneTpl({ formTitle: 'Supplier due diligence', responseText: fail.html, appendAttribution: false });

for (const [k, v] of Object.entries(pages)) writeFileSync(OUT + k + '.html', v);

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const shots = [
  ['request', 1440, 900, true], ['request', 390, 844, true],
  ['review', 1440, 900, false], ['review', 1024, 800, true], ['review', 390, 844, true],
  ['review-reject', 1440, 900, false], ['review-reject', 390, 844, true],
  ['decision', 1440, 900, true], ['decision', 390, 844, true], ['failure', 390, 844, true],
];
for (const scheme of ['light', 'dark']) {
  for (const [page, w, h, full] of shots) {
    if (scheme === 'dark' && !['request', 'review', 'decision'].includes(page)) continue;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
    const p = await ctx.newPage();
    await p.goto('file://' + OUT + page + '.html');
    await p.waitForTimeout(400);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) { failed = true; console.error(`horizontal overflow: ${page} at ${w}px (${scheme}) by ${overflow}px`); }
    await p.screenshot({ path: `${OUT}${page}-${w}-${scheme}.png`, fullPage: full });
    await ctx.close();
  }
}
// Waiting overlay: n8n shows its spinner by setting an inline display style on the button's span.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto('file://' + OUT + 'request.html');
  await p.evaluate(() => { document.querySelector('#submit-btn span').style.display = 'inline-block'; window.scrollTo(0, 600); });
  await p.waitForTimeout(100);
  await p.screenshot({ path: OUT + 'request-busy-1440.png' });
  await ctx.close();
}
await browser.close();
console.log(failed ? 'FAILED' : 'ok', '- pages and screenshots in', OUT);
process.exit(failed ? 1 : 0);
