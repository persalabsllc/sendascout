import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const home = readFileSync(new URL("../components/see-site.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/see-it.css", import.meta.url), "utf8");

test("mission choices are categories, not numbered process steps", () => {
  const choices = home.slice(home.indexOf("function MissionChoices"), home.indexOf("function IncludedChecklist"));
  assert.match(choices, /SEE_TEMPLATES\.map\(item/);
  assert.doesNotMatch(choices, /index|see-product-index/);
  assert.match(choices, /item\.priceCents \/ 100/);
  assert.match(choices, /item\.slug/);
  assert.match(home, /<IncludedChecklist template=\{template\} href=\{href\} \/> : <MissionChoices \/>/);
  assert.doesNotMatch(home, /see-benefit-bar/);
});

test("the public hero has illustrative imagery and actual template previews, not fabricated mission results", () => {
  assert.match(home, /AI-generated illustrative scene/);
  assert.match(home, /template\.tasks\.slice\(0, 4\)/);
  assert.match(home, /name="check" value=\{template.key\}/);
  assert.match(home, /action="\/request"/);
  assert.match(home, /name="address"/);
  assert.doesNotMatch(home, /Front exterior documented|Yard condition photographed/);
  assert.ok(statSync(new URL("../public/scout-on-location.webp", import.meta.url)).size < 300_000);
});

test("landing pages scale to large displays and use compact mobile category cards", () => {
  assert.match(css, /\.see-landing \.see-shell \{ width: min\(1660px/);
  assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /\.see-location-preview \{ display: none; \}/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /focus-visible/);
});
