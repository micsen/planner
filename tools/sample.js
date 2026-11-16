/* Made-up demo project for tests: two equipment rooms, two floors of doors, boards connected to doors. */
"use strict";
const { PDFDocument, StandardFonts, rgb } = require("../editor/vendor/pdf-lib.min.js");

function sampleProject() {
  const node = (id, kind, extra) => ({ id, kind, ...(kind === "item" ? { name: "" } : {}), description: "", job: "", comments: "",
    photos: [], links: [], children: [], ...extra });
  const door = (name) => node(`d-${name}`, "place", { type: "Door", name, description: "Demo door" });
  const board = (name, addr, doors) => node(name, "item", { item: "io", qty: 1, name, description: `OSDP addr ${addr}`,
    links: doors.map((d, i) => ({ to: `d-${d}`, note: `R${2 * i + 1}-R${2 * i + 2}, I${2 * i + 1}-I${2 * i + 2}` })) });
  const room = (id, desc, boards) => node(id, "place", { type: "Room", name: id, description: desc, children: [
    node(`${id}-cab`, "item", { item: "cabinet", qty: 1 }),
    node(`${id}-ctl`, "item", { item: "ctl", qty: 1, name: `${id}-C`, children: boards }),
  ] });
  return {
    format: "project-planner/2",
    pricing: { currency: "NOK", vat_rate: 0.25 },
    catalog: [
      { id: "ctl", name: "Controller", description: "Demo controller", unit_price: 3000 },
      { id: "io", name: "I/O board", description: "8 inputs / 8 relays", unit_price: 2000 },
      { id: "cabinet", name: "Cabinet", description: "DIN rail cabinet", cost: 1000, markup: 0.25 },
    ],
    drawings: [],
    root: node("site", "place", { type: "Site", name: "Demo building", description: "Made-up project used by the tests.", children: [
      room("R1", "Plant room", [board("R1-B1", 1, ["1.01", "1.02", "1.03", "1.04"]), board("R1-B2", 2, ["1.05", "2.01"])]),
      room("R2", "Server room", [board("R2-B1", 1, ["2.02", "2.03", "2.04"])]),
      node("floor-1", "place", { type: "Floor", name: "1", children: ["1.01", "1.02", "1.03", "1.04", "1.05"].map(door) }),
      node("floor-2", "place", { type: "Floor", name: "2", children: ["2.01", "2.02", "2.03", "2.04"].map(door) }),
    ] }),
  };
}

/** A one-page PDF standing in for a drawing. */
async function sampleDrawing() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Demo drawing", { x: 50, y: 780, size: 24, font });
  page.drawRectangle({ x: 50, y: 400, width: 300, height: 200, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  return doc.save({ useObjectStreams: false });
}

module.exports = { sampleProject, sampleDrawing };
