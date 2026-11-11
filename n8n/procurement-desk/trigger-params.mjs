// Parameters for the "Request Due Diligence" form trigger. Field order matters: theme.css lays out
// the grid by input id (#field-3, #field-4, #field-6, #field-7, #field-10).
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const section = (title, sub) => ({ fieldType: 'html', html: '<a href="#dd-section"></a><div><h3>' + title + '</h3><p>' + sub + '</p></div>' });

export const triggerParams = {
  formTitle: 'Supplier due diligence',
  formDescription: 'Run a signed, pay-per-use check on a new supplier before the first payment. The report comes back for your approval on the next page.',
  formFields: {
    values: [
      { fieldType: 'html', html: '<a href="#dd-request"></a><div><ol>'
        + '<li><b>Hire</b><span>The Due Diligence Analyst is found on Zynd and paid at most $0.20 in aUSD.</span></li>'
        + '<li><b>Verify</b><span>It hires Counterparty Check and Wallet Risk Screener, who buy signed records from AirnodeHub.</span></li>'
        + '<li><b>Decide</b><span>You review the signed report and approve, reject or escalate.</span></li>'
        + '</ol><p>Usually takes 1 to 2 minutes. Every payment and source signature is logged to the dd_audit table.</p></div>' },
      section('Supplier', 'Checked against Companies House and GLEIF.'),
      { fieldLabel: 'Company name', fieldName: 'companyName', fieldType: 'text', requiredField: true, defaultValue: 'Johnson Matthey PLC', placeholder: 'Registered company name' },
      { fieldLabel: 'UK company number', fieldName: 'companyNumber', fieldType: 'text', defaultValue: '00033774', placeholder: '8 characters, e.g. 00033774' },
      { fieldLabel: 'LEI (optional)', fieldName: 'lei', fieldType: 'text', placeholder: '20 characters' },
      section('Payment', 'The wallet that will receive the first payment, screened for sanctions and AML risk.'),
      { fieldLabel: 'Supplier wallet address', fieldName: 'walletAddress', fieldType: 'text', requiredField: true, defaultValue: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', placeholder: '0x…' },
      { fieldLabel: 'Chain', fieldName: 'chain', fieldType: 'dropdown', requiredField: true, defaultValue: 'ethereum', fieldOptions: { values: [{ option: 'ethereum' }, { option: 'bsc' }, { option: 'tron' }, { option: 'bitcoin' }, { option: 'solana' }] } },
      { fieldLabel: 'Purpose of payment', fieldName: 'purpose', fieldType: 'textarea', defaultValue: 'Onboard as catalyst supplier; first payment 25,000 USDC', placeholder: 'What the supplier is being onboarded for' },
      section('Requester', 'Recorded with the request in the audit log.'),
      { fieldLabel: 'Your name', fieldName: 'requestedBy', fieldType: 'text', requiredField: true, placeholder: 'e.g. Priya, Procurement' },
    ],
  },
  options: { appendAttribution: false, buttonLabel: 'Run due diligence', path: 'supplier-due-diligence', customCss: css },
};
