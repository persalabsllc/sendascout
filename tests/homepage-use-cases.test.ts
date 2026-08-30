import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const requestPage = readFileSync(new URL("../app/request/page.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("homepage explains recognizable customer pain points across every mission type", () => {
  assert.match(home, />Request a Scout <IconArrowRight/);
  assert.doesNotMatch(home, />Start a mission <IconArrowRight/);
  assert.match(home, /Real-life errands, solved/i);
  assert.match(home, /No truck\? Not nearby\? Can’t wait around\?/i);
  assert.match(home, /BBQ grill/i);
  assert.match(home, /picnic table/i);
  assert.match(home, /jobsite/i);
  assert.match(home, /small package/i);
  assert.match(home, /rental home/i);
  assert.match(home, /business sign/i);
  assert.match(home, /contractor/i);
  assert.match(home, /internet installer/i);
  assert.match(home, /purchase and prepay/i);
  assert.match(home, /SUV, van or pickup/i);
});

test("use-case calls to action open the matching preselected mission flow", () => {
  assert.match(home, /\/request\?type=move-it/);
  assert.match(home, /\/request\?type=see-it/);
  assert.match(home, /\/request\?type=meet-it/);
  assert.match(requestPage, /params\.type === "move-it" \? "move"/);
  assert.match(requestPage, /params\.type === "meet-it" \? "meet"/);
  assert.match(requestPage, /: "see"/);
});

test("use-case section keeps semantic labels, keyboard focus, and responsive layouts", () => {
  assert.match(home, /<section className="mission-section" id="missions" aria-labelledby="use-cases-title">/);
  assert.match(home, /<h2 id="use-cases-title">/);
  assert.match(home, /<article className="use-case-card use-case-featured">/);
  assert.match(home, /<article className={`use-case-card use-case-\$\{useCase\.size\}`}/);
  assert.match(home, /aria-hidden="true"/);
  assert.match(styles, /\.use-case-grid \{ display: grid; grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.use-case-link:focus-visible/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.use-case-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*?\.use-case-grid \{ grid-template-columns: 1fr; \}/);
});
