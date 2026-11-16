#!/usr/bin/env node
/* Round-trip and validation checks for the project model and PDF format (made-up demo data).  Run: node tools/test.js */
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const Planner = require("../editor/planner.js");
const PlannerPdf = require("../editor/pdf.js");
const { sampleProject, sampleDrawing } = require("./sample.js");

const JPG = fs.readFileSync(path.join(__dirname, "fixtures", "photo.jpg"));
const PNG = fs.readFileSync(path.join(__dirname, "fixtures", "photo.png"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const find = (p, pred) => Planner.nodes(p).find(pred);

/** The demo project exported to a PDF with one drawing, then imported again. */
async function sample() {
  const project = sampleProject();
  project.drawings = ["plan.pdf"];
  const bytes = await PlannerPdf.exportPdf(project, [{ name: "plan.pdf", bytes: await sampleDrawing() }]);
  return PlannerPdf.importPdf(bytes);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("demo project: structure, BOM, pricing and connections", async () => {
  const { project } = await sample();
  const res = Planner.analyze(project);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.typeCounts, { Room: 2, Floor: 2, Door: 9 });
  assert.deepEqual(res.lines.map((l) => [l.name, l.qty, l.unit]), [["Controller", 2, 3000], ["I/O board", 3, 2000], ["Cabinet", 2, 1250]]);
  // floors hold no items, so only the rooms are priced
  assert.deepEqual(res.groups.map((g) => [g.name, g.price]), [["Room R1", 8250], ["Room R2", 6250]]);
  assert.equal(res.pricing.total, 14500);
  assert.equal(res.pricing.incl, 18125);
  const conns = Planner.connections(project);
  assert.equal(conns.length, 9);
  assert.ok(conns.every((c) => c.from.item === "io" && c.to.type === "Door"));
});

test("item quantity counts in totals and in the place's group", async () => {
  const project = sampleProject();
  project.root.children[0].children.push(Planner.newItem("io", 2));
  const res = Planner.analyze(project);
  assert.equal(res.lines.find((l) => l.id === "io").qty, 5);
  assert.equal(res.groups[0].price, 8250 + 4000);
  project.root.children.push(Planner.newItem("ctl"));
  assert.equal(Planner.analyze(project).groups.at(-1).name, "Site items");
});

test("export -> import keeps project and drawings byte-identical", async () => {
  const first = await sample();
  const project = clone(first.project);
  project.root.children[0].comments = "Ærlig talt – æøå → ok";
  const back = await PlannerPdf.importPdf(await PlannerPdf.exportPdf(project, first.drawings, first.images));
  assert.deepEqual(back.project, project);
  assert.deepEqual(Buffer.from(back.drawings[0].bytes), Buffer.from(first.drawings[0].bytes));
});

test("job, comments and photos on any node survive export -> import", async () => {
  const first = await sample();
  const project = clone(first.project);
  const door = find(project, (n) => n.type === "Door");
  const board = find(project, (n) => n.item === "io");
  project.root.job = "Replace all controllers.\nKeep existing PSUs.";
  project.root.photos = [{ file: "site-1.jpg", caption: "Entrance" }];
  board.photos = [{ file: "board.png", caption: "" }];
  door.job = "Move lock wiring.";
  door.photos = [{ file: "door-1.jpg", caption: "Lock side" }, { file: "door-2.jpg", caption: "Frame" }];
  const images = new Map([["site-1.jpg", JPG], ["board.png", PNG], ["door-1.jpg", JPG], ["door-2.jpg", JPG]]);
  const back = await PlannerPdf.importPdf(await PlannerPdf.exportPdf(project, first.drawings, images));
  assert.deepEqual(back.project, project);
  for (const [name, b] of images) assert.deepEqual(Buffer.from(back.images.get(name)), Buffer.from(b));
  const blocks = Planner.report(project, Planner.analyze(project));
  assert.ok(blocks.some((b) => b.type === "h3" && b.text.startsWith(`Door ${door.name}`)));
  assert.equal(blocks.filter((b) => b.type === "photos").length, 3);
});

test("new project with nested places and items exports and imports", async () => {
  const p = Planner.newProject();
  p.catalog.push({ id: "c1", name: "Lock", unit_price: 100 });
  const floor = Planner.newPlace("Floor", "1");
  const room = Planner.newPlace("Room", "101");
  room.children.push(Planner.newItem("c1", 3));
  floor.children.push(room);
  p.root.children.push(floor);
  const back = await PlannerPdf.importPdf(await PlannerPdf.exportPdf(p, []));
  assert.deepEqual(back.project, p);
  assert.equal(Planner.analyze(back.project).pricing.total, 300);
});

test("connections: validation, pruning after delete, report table", async () => {
  const project = sampleProject();
  const p1 = clone(project);
  find(p1, (n) => n.name === "R1-B1").links.push({ to: "nope" });
  assert.ok(Planner.analyze(p1).errors.some((e) => /does not exist/.test(e)));
  const p2 = clone(project);
  const b2 = find(p2, (n) => n.name === "R1-B1");
  b2.links.push({ to: b2.id });
  assert.ok(Planner.analyze(p2).errors.some((e) => /cannot connect to itself/.test(e)));
  b2.links.splice(-1, 1, { ...b2.links[0] });
  assert.ok(Planner.analyze(p2).errors.some((e) => /duplicate connection/.test(e)));
  // deleting a floor and pruning removes the board links to its doors
  const p3 = clone(project);
  p3.root.children = p3.root.children.filter((n) => n.name !== "2");
  Planner.pruneLinks(p3);
  assert.deepEqual(Planner.analyze(p3).errors, []);
  assert.equal(Planner.connections(p3).length, 5);
  const blocks = Planner.report(project, Planner.analyze(project));
  const table = blocks[blocks.findIndex((b) => b.type === "h" && b.text === "Connections") + 1];
  assert.equal(table.rows.length, 9);
  assert.deepEqual(table.rows[0], ["R1-B1 – I/O board", "Door 1.01", "R1-R2, I1-I2"]);
});

test("photos: missing bytes, bad names and duplicates are rejected", async () => {
  const p = sampleProject();
  const [d1, d2] = Planner.nodes(p).filter((n) => n.type === "Door");
  d1.photos = [{ file: "x.jpg" }];
  await assert.rejects(PlannerPdf.exportPdf(p, [], new Map()), /photo x\.jpg is missing/);
  await assert.rejects(PlannerPdf.exportPdf(p, [], new Map([["x.jpg", Buffer.from("nope")]])), /not a JPEG or PNG/);
  d2.photos = [{ file: "x.jpg" }];
  assert.ok(Planner.analyze(p).errors.some((e) => /already used/.test(e)));
  d2.photos = [{ file: "../evil.jpg" }];
  assert.ok(Planner.analyze(p).errors.some((e) => /must be a \.jpg\/\.png file name/.test(e)));
});

test("PDFs that are not v2 project files are rejected", async () => {
  await assert.rejects(PlannerPdf.importPdf(await sampleDrawing()), /no embedded project\.json/);
  const p = Planner.newProject();
  p.format = "project-planner/1";
  await assert.rejects(PlannerPdf.exportPdf(p, []), /Unknown project format/);
});

test("validation catches bad data", async () => {
  const project = sampleProject();
  const cases = [
    [(p) => { find(p, (n) => n.kind === "item").item = "nope"; }, /not in the catalog/],
    [(p) => { find(p, (n) => n.kind === "item").qty = 0; }, /quantity must be a number above 0/],
    [(p) => { find(p, (n) => n.type === "Door").type = ""; }, /type is required/],
    [(p) => { const [a, b] = Planner.nodes(p).filter((n) => n.type === "Door"); b.id = a.id; }, /duplicate node id/],
    [(p) => { p.catalog[0].cost = 10; }, /not both/],
    [(p) => { p.catalog[1].markup = 0.2; }, /markup needs a cost/],
    [(p) => { p.catalog[1].unit_price = NaN; }, /unit price must be a number/],
    [(p) => { p.catalog.push({ id: "ctl", name: "Dup" }); }, /duplicate id/],
    [(p) => { p.drawings.push("project.json"); }, /reserved/],
    [(p) => { p.root.name = ""; }, /name is required/],
    [(p) => { p.root = Planner.newItem("ctl"); }, /top node must be a place/],
  ];
  for (const [mutate, re] of cases) {
    const p = clone(project);
    mutate(p);
    const res = Planner.analyze(p);
    assert.ok(res.errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(res.errors)}`);
  }
});

test("CSV output: BOM and full structure, quoted correctly", async () => {
  const project = sampleProject();
  project.catalog[0].notes = 'a, "b"';
  const files = Planner.csvFiles(project, Planner.analyze(project));
  assert.ok(files["bom.csv"].includes('"a, ""b"""'));
  const lines = files["structure.csv"].trim().split("\r\n");
  assert.equal(lines.length, 1 + Planner.nodes(project).length);
  assert.ok(lines.some((l) => l.startsWith("Site Demo building / Floor 1 / Door 1.01,") && l.includes("← R1-B1 – I/O board (R1-R2, I1-I2)")));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  }
  console.log(failed ? `${failed} failed` : `${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
