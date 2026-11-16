#!/usr/bin/env node
/* Command-line access to project PDFs (same code as the editor).
 *   node tools/cli.js extract <project.pdf> <dir>   write project.json, drawings and CSVs to <dir>
 *   node tools/cli.js build <dir> <project.pdf>     build a project PDF from <dir>/project.json + drawings + photos
 *   node tools/cli.js summary <project.pdf>         print place counts, items and totals
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Planner = require("../editor/planner.js");
const PlannerPdf = require("../editor/pdf.js");

async function extract(pdf, dir) {
  const bytes = fs.readFileSync(pdf);
  const { PDFDocument } = require("../editor/vendor/pdf-lib.min.js");
  const files = PlannerPdf.attachments(await PDFDocument.load(bytes, { updateMetadata: false }));
  await PlannerPdf.importPdf(bytes); // validates that it is a project PDF
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of files) {
    if (path.basename(name) !== name) throw new Error(`Refusing unsafe attachment name ${JSON.stringify(name)}`);
    fs.writeFileSync(path.join(dir, name), data);
    console.log(`wrote ${path.join(dir, name)}`);
  }
}

async function build(dir, out) {
  const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  const drawings = (project.drawings || []).map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, path.basename(name))) }));
  const images = new Map(Planner.photoRefs(project).filter((r) => r.photo && typeof r.photo.file === "string")
    .map((r) => [r.photo.file, fs.readFileSync(path.join(dir, path.basename(r.photo.file)))]));
  fs.writeFileSync(out, await PlannerPdf.exportPdf(project, drawings, images));
  console.log(`wrote ${out}`);
}

async function summary(pdf) {
  const { project } = await PlannerPdf.importPdf(fs.readFileSync(pdf));
  const res = Planner.analyze(project);
  if (res.errors.length) { console.log(res.errors.join("\n")); process.exitCode = 1; return; }
  console.log(Object.entries(res.typeCounts).map(([t, n]) => `${n} × ${t}`).join(", "));
  for (const l of res.lines.filter((x) => x.qty > 0)) console.log(`${l.qty} × ${l.name}`);
  for (const g of res.groups) console.log(`${g.name}: ${Planner.fmtPrice(g.price)} ${res.pricing.currency}`);
  console.log(`total ${Planner.fmtPrice(res.pricing.total)} ${res.pricing.currency} ex. MVA`);
}

const [cmd, a, b] = process.argv.slice(2);
const run = { extract: () => extract(a, b), build: () => build(a, b), summary: () => summary(a) }[cmd];
if (!run || !a || (cmd !== "summary" && !b)) {
  console.error(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 6).join("\n"));
  process.exit(2);
}
run().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
