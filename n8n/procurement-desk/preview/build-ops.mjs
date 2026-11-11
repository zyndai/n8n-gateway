// Builds the n8n MCP `update_workflow` operations that apply these files to the live
// Procurement Desk workflow (OUdZ8Xm6V9YX0aO6), written to out/ops.json.
// The 2026-11-12 redesign was applied with these operations (later runs only need the
// updateNodeParameters / setNodeParameter ops; the addNode / connection ops are one-off).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { triggerParams } from '../trigger-params.mjs';

const f = (p) => readFileSync(new URL('../code/' + p, import.meta.url), 'utf8');
const done = f('done-page.js');
const reviewParams = {
  operation: 'page', defineForm: 'fields',
  formFields: { values: [
    { fieldType: 'html', elementName: 'report', html: '={{ $json.html }}' },
    { fieldLabel: 'Choose an outcome. It is saved with the report.', fieldName: 'decision', fieldType: 'radio', requiredField: true, fieldOptions: { values: [{ option: 'Approve supplier' }, { option: 'Reject supplier' }, { option: 'Escalate for enhanced due diligence' }] } },
    { fieldLabel: 'Approver name', fieldName: 'approver', fieldType: 'text', requiredField: true, placeholder: 'Your full name' },
    { fieldLabel: 'Comment', fieldName: 'comment', fieldType: 'textarea', placeholder: 'Optional. Explain your reasoning, especially if you differ from the Analyst.' },
  ] },
  options: {
    formTitle: 'Due diligence report', formDescription: 'Procurement Desk · review the signed report, then record your decision.', buttonLabel: 'Record decision', appendAttribution: false,
    customCss: "={{ $('Request Due Diligence').params.options.customCss }}",
  },
};
const completion = { operation: 'completion', respondWith: 'showText', responseText: '={{ $json.html }}' };

const ops = [
  // content (safe to re-apply)
  { type: 'updateNodeParameters', nodeName: 'Request Due Diligence', replace: true, parameters: triggerParams },
  { type: 'updateNodeParameters', nodeName: 'Review and Decide', replace: true, parameters: reviewParams },
  { type: 'setNodeParameter', nodeName: 'Render Review Page', path: '/jsCode', value: f('render-review.js') },
  // one-off structure changes from the redesign
  { type: 'setNodeSettings', nodeName: 'Record Decision', settings: { alwaysOutputData: true } },
  { type: 'setNodeSettings', nodeName: 'Mark Failed', settings: { alwaysOutputData: true } },
  { type: 'addNode', node: { name: 'Render Decision Page', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1980, 200], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: done + f('render-decision.js') } } },
  { type: 'addNode', node: { name: 'Render Failure Page', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1540, 420], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: done + f('render-failure.js') } } },
  { type: 'setNodePosition', nodeName: 'Decision Recorded', position: [2200, 200] },
  { type: 'setNodePosition', nodeName: 'Analyst Unavailable', position: [1760, 420] },
  { type: 'removeConnection', source: 'Record Decision', target: 'Decision Recorded' },
  { type: 'addConnection', source: 'Record Decision', target: 'Render Decision Page' },
  { type: 'addConnection', source: 'Render Decision Page', target: 'Decision Recorded' },
  { type: 'removeConnection', source: 'Mark Failed', target: 'Analyst Unavailable' },
  { type: 'addConnection', source: 'Mark Failed', target: 'Render Failure Page' },
  { type: 'addConnection', source: 'Render Failure Page', target: 'Analyst Unavailable' },
  { type: 'updateNodeParameters', nodeName: 'Decision Recorded', replace: true, parameters: completion },
  { type: 'updateNodeParameters', nodeName: 'Analyst Unavailable', replace: true, parameters: completion },
  { type: 'updateNodeGroup', groupName: 'Human approval', nodeNames: ['Render Review Page', 'Review and Decide', 'Record Decision', 'Render Decision Page', 'Decision Recorded'] },
  { type: 'updateNodeGroup', groupName: 'If the Analyst fails', nodeNames: ['Mark Failed', 'Render Failure Page', 'Analyst Unavailable'] },
];

// Syntax-check each Code node body the way n8n wraps it.
for (const op of ops) {
  const code = op.value ?? op.node?.parameters?.jsCode;
  if (code) new Function('$', '$input', code);
}
const out = new URL('../out/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('ops.json', out), JSON.stringify(ops, null, 1));
console.log(ops.length, 'operations ->', new URL('ops.json', out).pathname);
