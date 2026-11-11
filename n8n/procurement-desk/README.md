# Procurement Desk form UI

Source for the pages of the n8n **Procurement Desk** workflow (`OUdZ8Xm6V9YX0aO6`, form at
`/form/supplier-due-diligence` on the n8n instance). The workflow in n8n is what runs; these files
are the copy you edit, preview and apply. Nothing here is part of the Gateway build.

| File | Goes into |
| --- | --- |
| `theme.css` | `Request Due Diligence` → Options → Custom CSS (via `trigger-params.mjs`). `Review and Decide` reuses it with `={{ $('Request Due Diligence').params.options.customCss }}` |
| `trigger-params.mjs` | All parameters of the `Request Due Diligence` form trigger (fields, texts, CSS) |
| `code/render-review.js` | Code node `Render Review Page` |
| `code/done-page.js` + `code/render-decision.js` | Code node `Render Decision Page` (the two files concatenated) |
| `code/done-page.js` + `code/render-failure.js` | Code node `Render Failure Page` |
| `preview/` | Local preview harness and the builder for the n8n update operations |

## Constraints that shape the code (n8n 2.47)

- The form shell is a fixed 448px column (`--container-width`); `theme.css` overrides it.
- The HTML field sanitizer strips **every** `class` and `style` attribute. It keeps `a[href]` and
  `td`/`th` `headers`/`scope`. So the report tags each section with a hidden marker,
  `<a href="#dd-NAME"></a>`, and the CSS styles the element right after it
  (`a[href="#dd-panel"] + div`). Phone table cards read their labels from `td[headers]`.
- Custom CSS is passed through the HTML sanitizer as text: never put HTML in CSS comments.
  The preview fails if the sanitizer changes `theme.css`.
- The end pages use completion "Show text", which is **not** sanitized: every value is escaped
  in `done-page.js`, and the page carries its own `<style>`.
- Field ids are positional (`field-0`, `field-1`, …). The request-form grid in `theme.css` targets
  `#field-3`, `#field-4`, `#field-6`, `#field-7` and `#field-10`; the review page's decision
  colours target `#option0_field-1` … `#option2_field-1`. Reordering fields means updating those.

## Preview

```sh
cd n8n/procurement-desk
npm run setup     # once: deps, Chromium, n8n 2.47.0 templates into .cache/
npm run preview   # renders every page into out/ and screenshots 1440/1024/390px, light and dark
```

The harness renders with n8n's own Handlebars templates and the same sanitizer settings, using the
real Analyst output in `preview/fixture-approve.json` plus a high-risk variant. It exits non-zero on
horizontal overflow or a sanitizer change to the theme. Set `CHROME_PATH` to use another Chromium.

## Apply to n8n

`npm run ops` writes `out/ops.json`: the operations for the n8n MCP `update_workflow` tool. The
first three (trigger, review page, review renderer) can be re-applied after any edit. The rest were
the one-off structure changes of the redesign. Then test with `test_workflow`, pinning the
trigger, `Log Request`, `Find Analyst on Zynd`, `Hire Due Diligence Analyst` and the data-table nodes so
nothing is paid or written, and publish.
