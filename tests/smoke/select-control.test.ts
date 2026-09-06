import assert from "node:assert/strict";
import test from "node:test";

import { selectControlBootstrap, selectControlCss } from "../../src/views/select-control.ts";

test("branded select progressively enhances a native form control", () => {
  const bootstrap = selectControlBootstrap();
  assert.doesNotThrow(() => new Function(bootstrap));
  assert.match(bootstrap, /HTMLSelectElement/);
  assert.match(bootstrap, /showPopover/);
  assert.match(bootstrap, /CSS\.supports/);
  assert.doesNotMatch(bootstrap, /\.style\./);
  assert.match(bootstrap, /aria-haspopup','listbox'/);
  assert.match(bootstrap, /setAttribute\('role','option'\)/);
  assert.match(bootstrap, /new Event\('change',\{bubbles:true\}\)/);
  assert.match(bootstrap, /event\.stopPropagation\(\)/);
  assert.match(bootstrap, /event\.key==='Escape'/);
  assert.match(bootstrap, /event\.key==='Tab'/);

  const css = selectControlCss();
  assert.match(css, /select\[data-ui-select\]/);
  assert.match(css, /data-ui-select-enhanced="true"/);
  assert.match(css, /\.ui-select\[data-state="open"\]/);
  assert.match(css, /anchor-scope:--ui-select-anchor/);
  assert.match(css, /position-anchor:--ui-select-anchor/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /pointer:coarse/);
});
