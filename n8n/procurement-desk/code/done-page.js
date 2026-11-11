// Shared by "Render Decision Page" and "Render Failure Page": the end page is shown as raw HTML
// (Form completion "showText"), so every value is escaped and the page brings its own styles.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const short = (h) => (h && h.length > 14 ? h.slice(0, 6) + '…' + h.slice(-4) : h || '');
const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");
:root{--bg:#f5f6f8;--sf:#fff;--sf2:#f9fafb;--bd:#e4e7ec;--tx:#101828;--tx2:#475467;--tx3:#667085;--ac:#3b5bdb;--ach:#2f4ac0;--onac:#fff;
--ok:#067647;--okb:#ecfdf3;--okd:#abefc6;--wa:#b54708;--wab:#fffaeb;--wad:#fedf89;--ba:#b42318;--bab:#fef3f2;--bad:#fecdca;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--sf:#131823;--sf2:#181e2b;--bd:#262d3b;--tx:#f2f4f7;--tx2:#c4c9d4;--tx3:#8d95a5;--ac:#7c93ff;--ach:#98a9ff;--onac:#0b0f17;
--ok:#4ade80;--okb:rgba(74,222,128,.1);--okd:rgba(74,222,128,.32);--wa:#fbbf24;--wab:rgba(251,191,36,.1);--wad:rgba(251,191,36,.32);--ba:#f87171;--bab:rgba(248,113,113,.1);--bad:rgba(248,113,113,.32);color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;color:var(--tx);background:var(--bg);min-height:100vh;display:block}
.dd-done{max-width:640px;margin:0 auto;padding:48px 24px}
.dd-card{background:var(--sf);border:1px solid var(--bd);border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);padding:32px}
.dd-icon{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-size:20px;font-weight:700;margin-bottom:16px;border:1px solid}
.dd-ok .dd-icon{color:var(--ok);background:var(--okb);border-color:var(--okd)}.dd-warn .dd-icon{color:var(--wa);background:var(--wab);border-color:var(--wad)}.dd-bad .dd-icon{color:var(--ba);background:var(--bab);border-color:var(--bad)}
.dd-eyebrow{font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--tx3)}
h1{font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-.01em;margin:4px 0 8px;color:var(--tx)}
.dd-lead{color:var(--tx2);font-size:15px}
.dd-note{margin-top:16px;padding:12px 14px;border-radius:8px;border:1px solid var(--wad);background:var(--wab);color:var(--tx);font-size:13.5px}
.dd-kv{margin-top:24px;border-top:1px solid var(--bd)}
.dd-kv div{display:grid;grid-template-columns:minmax(120px,38%) minmax(0,1fr);gap:12px;padding:10px 0;border-bottom:1px solid var(--bd)}
.dd-kv dt{color:var(--tx3);font-weight:500}.dd-kv dd{color:var(--tx);overflow-wrap:anywhere}
code{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;background:var(--sf2);border:1px solid var(--bd);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}
.dd-actions{margin-top:24px;display:flex;flex-wrap:wrap;gap:10px}
.dd-btn{display:inline-flex;align-items:center;justify-content:center;height:42px;padding:0 18px;border-radius:8px;background:var(--ac);color:var(--onac);font-weight:600}
.dd-btn:hover{background:var(--ach);text-decoration:none}
.dd-foot{margin-top:16px;text-align:center;color:var(--tx3);font-size:12.5px}
@media (max-width:600px){.dd-done{padding:16px}.dd-card{padding:22px 18px}h1{font-size:20px}.dd-kv div{grid-template-columns:1fr;gap:2px}.dd-btn{width:100%}}`;
const ddPage = ({ tone, icon, eyebrow, title, lead, note, rows, foot }) => '<style>' + CSS + '</style>'
  + '<main class="dd-done dd-' + tone + '"><div class="dd-card">'
  + '<div class="dd-icon" aria-hidden="true">' + icon + '</div>'
  + '<p class="dd-eyebrow">' + esc(eyebrow) + '</p><h1>' + esc(title) + '</h1><p class="dd-lead">' + lead + '</p>'
  + (note ? '<p class="dd-note">' + note + '</p>' : '')
  + '<dl class="dd-kv">' + rows.filter((r) => r[1] !== '' && r[1] != null).map((r) => '<div><dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd></div>').join('') + '</dl>'
  + '<div class="dd-actions"><a class="dd-btn" href="/form/supplier-due-diligence">Start a new request</a></div>'
  + '</div><p class="dd-foot">' + foot + '</p></main>';
