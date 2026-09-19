import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const home=readFileSync(new URL("../components/see-site.tsx",import.meta.url),"utf8");
const request=readFileSync(new URL("../app/request/page.tsx",import.meta.url),"utf8");
test("homepage leads with remote eyes, included evidence, and clear fulfillment limits",()=>{assert.match(home,/Need eyes/);assert.match(home,/Get current photos, video, and answers/);assert.match(home,/PDF report included/);assert.match(home,/Availability varies by location/);assert.match(home,/full refund/);assert.match(home,/not mechanical inspections/);});
test("See It leads while existing Move It and Meet It entry points remain available",()=>{assert.match(home,/More ways to use a Scout/);assert.match(home,/\/request\?type=move-it/);assert.match(home,/\/request\?type=meet-it/);assert.match(home,/`\/request\?check=\$\{template.key\}`/);assert.match(request,/params\.type === "move-it" \? "move"/);assert.match(request,/params\.type === "meet-it" \? "meet"/);assert.match(request,/SeeRequest/);});
test("customers can browse the example report and Scouts can browse missions before signup",()=>{assert.match(home,/href="\/sample-report"/);assert.match(home,/href="\/missions"/);assert.match(home,/What we check/);assert.match(home,/How it works/);});
