/* Project model: a catalog of items plus a tree of places and item instances.
 * Validation, BOM, pricing, report content and CSV outputs. Shared by the browser editor (window.Planner)
 * and the Node CLI (require). No dependencies. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT = "project-planner/2";
  const RESERVED_FILES = ["project.json", "bom.csv", "structure.csv"];
  const PHOTO_NAME = /^[\w.-]+\.(jpe?g|png)$/i; // embedded as a PDF attachment under this name
  const NBSP = " ";

  const has = (v) => v !== undefined && v !== null && v !== "";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  let seq = 0;
  /** New unique node/catalog id. */
  const newId = (prefix = "n") => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function newPlace(type = "Place", name = "") {
    return { id: newId(), kind: "place", type, name, description: "", job: "", comments: "", photos: [], links: [], children: [] };
  }
  /** An item instance; name is an optional tag (e.g. "A2-B1") so connections read clearly. */
  function newItem(item, qty = 1) {
    return { id: newId(), kind: "item", item, qty, name: "", description: "", job: "", comments: "", photos: [], links: [], children: [] };
  }

  function newProject() {
    return {
      format: FORMAT,
      pricing: { currency: "NOK", vat_rate: 0.25 },
      catalog: [],
      drawings: [],
      root: { ...newPlace("Site", "New project") },
    };
  }

  /** Depth-first walk: fn(node, parent, depth). */
  function walk(node, fn, parent = null, depth = 0) {
    fn(node, parent, depth);
    for (const c of node.children || []) walk(c, fn, node, depth + 1);
  }
  const nodes = (p) => { const out = []; if (p.root) walk(p.root, (n) => out.push(n)); return out; };

  function itemOf(p, node) { return (p.catalog || []).find((c) => c.id === node.item); }

  function unitPrice(entry) {
    if (has(entry.cost)) return Math.round(entry.cost * (1 + (has(entry.markup) ? entry.markup : 0)));
    return has(entry.unit_price) ? entry.unit_price : null;
  }

  /** Short display name for a node. */
  function label(p, node) {
    if (node.kind === "item") {
      const c = itemOf(p, node);
      const name = (has(node.name) ? `${node.name} – ` : "") + (c ? c.name : `? ${node.item}`);
      return node.qty === 1 ? name : `${name} ×${node.qty}`;
    }
    return [node.type, node.name].filter(has).join(" ") || "Place";
  }

  /** All connections as { from, to, note } with resolved nodes, in tree order. Links are stored on the "from" node. */
  function connections(p) {
    const byId = new Map(nodes(p).map((n) => [n.id, n]));
    const out = [];
    for (const n of nodes(p)) for (const l of n.links || []) if (byId.has(l.to)) out.push({ from: n, to: byId.get(l.to), note: l.note || "" });
    return out;
  }
  /** Removes links whose target no longer exists (after deleting nodes). */
  function pruneLinks(p) {
    const ids = new Set(nodes(p).map((n) => n.id));
    for (const n of nodes(p)) if (n.links) n.links = n.links.filter((l) => ids.has(l.to));
  }
  /** "→ X (note); ← Y (note)" summary of a node's connections. */
  function linkSummary(p, n, conns = connections(p)) {
    const part = (c, other, arrow) => `${arrow} ${label(p, other)}${c.note ? ` (${c.note})` : ""}`;
    return [...conns.filter((c) => c.from === n).map((c) => part(c, c.to, "→")),
      ...conns.filter((c) => c.to === n).map((c) => part(c, c.from, "←"))].join("; ");
  }

  /** Every photo in the project with a label for its owner. */
  function photoRefs(p) {
    const refs = [];
    for (const n of nodes(p)) for (const photo of n.photos || []) refs.push({ owner: label(p, n), photo });
    return refs;
  }

  function validate(p) {
    const errors = [];
    const err = (m) => errors.push(m);
    if (p.format !== FORMAT) err(`Unknown project format ${JSON.stringify(p.format)} (expected ${FORMAT})`);
    const pr = p.pricing || {};
    if (!has(pr.currency)) err("Pricing: currency is required");
    if (!(isNum(pr.vat_rate) && pr.vat_rate >= 0)) err("Pricing: MVA rate must be a number ≥ 0");

    const catIds = new Set();
    for (const [i, c] of (p.catalog || []).entries()) {
      const name = has(c.name) ? `Item ${c.name}` : `Catalog item #${i + 1}`;
      if (!has(c.id)) err(`${name}: id is missing`);
      else if (catIds.has(c.id)) err(`${name}: duplicate id ${c.id}`);
      catIds.add(c.id);
      if (!has(c.name)) err(`${name}: name is required`);
      for (const k of ["unit_price", "cost", "markup"])
        if (has(c[k]) && !(isNum(c[k]) && c[k] >= 0)) err(`${name}: ${k.replace("_", " ")} must be a number ≥ 0`);
      if (has(c.unit_price) && has(c.cost)) err(`${name}: set either unit price or cost + markup, not both`);
      if (has(c.markup) && !has(c.cost)) err(`${name}: markup needs a cost`);
    }

    if (!p.root || p.root.kind !== "place") err("Structure: the top node must be a place");
    else if (!has(p.root.name)) err("Project: name is required");
    const nodeIds = new Set();
    if (p.root) walk(p.root, (n) => {
      const who = n.kind === "item" ? `Item ${label(p, n)}` : `${label(p, n)}`;
      if (!has(n.id)) err(`${who}: id is missing`);
      else if (nodeIds.has(n.id)) err(`${who}: duplicate node id ${n.id}`);
      nodeIds.add(n.id);
      if (n.kind === "place") {
        if (!has(n.type)) err(`Place ${n.name || "?"}: type is required`);
      } else if (n.kind === "item") {
        if (!catIds.has(n.item)) err(`${who}: not in the catalog`);
        if (!(isNum(n.qty) && n.qty > 0)) err(`${who}: quantity must be a number above 0`);
      } else err(`Node ${n.id}: kind must be place or item`);
      if (!Array.isArray(n.children)) err(`${who}: children must be a list`);
    });
    if (p.root) walk(p.root, (n) => {
      const seen = new Set();
      for (const l of n.links || []) {
        if (!l || !nodeIds.has(l.to)) err(`${label(p, n)}: connection to a node that does not exist`);
        else if (l.to === n.id) err(`${label(p, n)}: cannot connect to itself`);
        else if (seen.has(l.to)) err(`${label(p, n)}: duplicate connection`);
        if (l) seen.add(l.to);
      }
    });

    const names = new Set();
    for (const n of p.drawings || []) {
      if (RESERVED_FILES.includes(n)) err(`Drawing ${n}: name is reserved`);
      if (names.has(n)) err(`Drawing ${n}: duplicate name`);
      names.add(n);
    }
    for (const { owner, photo } of photoRefs(p)) {
      const f = photo && photo.file;
      if (typeof f !== "string" || !PHOTO_NAME.test(f)) { err(`${owner}: photo ${JSON.stringify(f)} must be a .jpg/.png file name`); continue; }
      if (names.has(f) || RESERVED_FILES.includes(f)) err(`${owner}: photo name ${f} is already used`);
      names.add(f);
    }
    return errors;
  }

  /** Item quantities per catalog id within a subtree. */
  function itemQty(node) {
    const q = {};
    walk(node, (n) => { if (n.kind === "item") q[n.item] = (q[n.item] || 0) + n.qty; });
    return q;
  }

  /** Everything derived from a project. errors non-empty => nothing else is set. */
  function analyze(p) {
    const errors = validate(p);
    if (errors.length) return { errors };
    const totals = itemQty(p.root);
    const lines = p.catalog.map((c) => {
      const unit = unitPrice(c);
      const notes = has(c.cost)
        ? `Cost ${fmtPrice(c.cost)} + ${Math.round((has(c.markup) ? c.markup : 0) * 100)}% margin. ${c.notes || ""}`.trim()
        : c.notes || "";
      const qty = totals[c.id] || 0;
      return { id: c.id, name: c.name, description: c.description || "", qty, unit, total: unit === null ? null : unit * qty, notes };
    });
    const unitOf = Object.fromEntries(lines.map((l) => [l.id, l.unit]));
    const subtotal = (node) => Object.entries(itemQty(node)).reduce((s, [id, q]) => s + (unitOf[id] || 0) * q, 0);

    // Price per top-level group: each place directly under the root, plus loose items under the root.
    const hasItems = (n) => Object.keys(itemQty(n)).length > 0;
    const groups = p.root.children.filter((n) => n.kind === "place" && hasItems(n)).map((n) => ({ name: label(p, n), node: n, price: subtotal(n) }));
    const loose = p.root.children.filter((n) => n.kind === "item");
    if (loose.length) groups.push({ name: "Site items", node: null,
      price: loose.reduce((s, n) => s + subtotal(n), 0) });

    const typeCounts = {};
    walk(p.root, (n) => { if (n.kind === "place" && n !== p.root) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
    const total = lines.reduce((s, l) => s + (l.total || 0), 0);
    const vat = p.pricing.vat_rate;
    return { errors: [], lines, groups, typeCounts,
      pricing: { currency: p.pricing.currency, vatRate: vat, total, vat: total * vat, incl: total * (1 + vat),
        unpriced: lines.filter((l) => l.unit === null && l.qty > 0) }, subtotal };
  }

  function fmtPrice(v) {
    if (v === null || v === undefined) return "";
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  const hasNotes = (n) => has(n.job) || has(n.comments) || (n.photos || []).length > 0;

  /** Report blocks for a node's job description, comments and photos. */
  function notesBlocks(n) {
    const out = [];
    if (has(n.job)) out.push({ type: "p", label: "Job description", text: n.job });
    if (has(n.comments)) out.push({ type: "p", label: "Comments", text: n.comments });
    if ((n.photos || []).length) out.push({ type: "photos", items: n.photos });
    return out;
  }

  /** Report content as blocks; rendered to HTML by the editor and to PDF by pdf.js. */
  function report(p, res) {
    const pr = res.pricing;
    const cur = pr.currency;
    const r = p.root;
    const blocks = [
      { type: "title", text: r.name, anchor: r.id },
      ...(has(r.description) ? [{ type: "p", text: r.description }] : []),
      { type: "kpis", items: [...Object.entries(res.typeCounts).map(([t, n]) => [t, n]),
        ["Items", res.lines.reduce((s, l) => s + l.qty, 0)], [`Total ${cur} ex. MVA`, fmtPrice(pr.total)]].slice(-6) },
      ...(hasNotes(r) ? [{ type: "h", text: "Job" }, ...notesBlocks(r)] : []),
      { type: "h", text: "Bill of materials" },
      { type: "table", headers: ["Item", "Description", "Qty", `Unit (${cur})`, "Total", "Notes"], num: [2, 3, 4], wrap: [1, 5],
        rows: res.lines.filter((l) => l.qty > 0).map((l) => [l.name, l.description, l.qty, fmtPrice(l.unit), fmtPrice(l.total), l.notes]) },
      { type: "h", text: "Pricing" },
      { type: "p", text: `Prices in ${cur} excl. MVA. Hardware only, no labour.` },
      { type: "table", headers: ["Group", `Price (${cur} ex. MVA)`], num: [1], bold: [res.groups.length, res.groups.length + 2],
        rows: res.groups.map((g) => [g.name, fmtPrice(g.price)]).concat([["Total ex. MVA", fmtPrice(pr.total)],
          [`MVA ${Math.round(pr.vatRate * 100)}%`, fmtPrice(pr.vat)], ["Total incl. MVA", fmtPrice(pr.incl)]]) },
    ];
    if (pr.unpriced.length)
      blocks.push({ type: "p", warn: true, text: "Not yet priced: " + pr.unpriced.map((l) => `${l.name} (${l.qty})`).join(", ") });

    const conns = connections(p);
    /** Linked "→ X (note)" / "← Y (note)" lines for a node's connections. */
    const linkParts = (n) => ({ parts: [
      ...conns.filter((c) => c.from === n).map((c) => ({ text: `→ ${label(p, c.to)}${c.note ? ` (${c.note})` : ""}`, link: c.to.id })),
      ...conns.filter((c) => c.to === n).map((c) => ({ text: `← ${label(p, c.from)}${c.note ? ` (${c.note})` : ""}`, link: c.from.id })),
    ] });
    const outline = (top) => {
      const rows = [];
      const anchors = [];
      for (const c of top.children) walk(c, (n, _parent, depth) => {
        const c2 = n.kind === "item" ? itemOf(p, n) : null;
        const unit = c2 ? unitPrice(c2) : null;
        anchors.push(n.id);
        rows.push([NBSP.repeat(depth * 4) + (depth ? "› " : "") + label(p, n),
          n.kind === "item" ? "Item" : n.type, n.description || "", linkParts(n), n.kind === "item" ? n.qty : "",
          n.kind === "item" && unit !== null ? fmtPrice(unit * n.qty) : ""]);
      });
      const anyItem = rows.some((r) => r[4] !== "");
      if (!anyItem) return { type: "table", headers: ["Structure", "Type", "Description", "Connections"], wrap: [0, 2, 3],
        rows: rows.map((r) => r.slice(0, 4)), anchors };
      return { type: "table", headers: ["Structure", "Type", "Description", "Connections", "Qty", `Price (${cur})`],
        num: [4, 5], wrap: [0, 2, 3], rows, anchors };
    };
    const details = (top) => {
      const out = [];
      for (const c of top.children) walk(c, (n) => {
        if (!hasNotes(n)) return;
        out.push({ type: "h3", text: label(p, n) + (has(n.description) ? ` – ${n.description}` : "") });
        out.push(...notesBlocks(n));
      });
      return out;
    };

    for (const top of r.children.filter((n) => n.kind === "place")) {
      blocks.push({ type: "h", anchor: top.id, text: label(p, top) + (has(top.description) ? ` – ${top.description}` : "") });
      // Text first, then the structure table, then the (large) photos.
      const notes = notesBlocks(top);
      blocks.push(...notes.filter((b) => b.type !== "photos"));
      if (top.children.length) blocks.push(outline(top));
      blocks.push(...notes.filter((b) => b.type === "photos"));
      blocks.push(...details(top));
    }
    const loose = r.children.filter((n) => n.kind === "item");
    if (loose.length) {
      const fake = { children: loose };
      blocks.push({ type: "h", text: "Site items" }, outline(fake), ...details(fake));
    }

    if (conns.length) {
      blocks.push({ type: "h", text: "Connections" });
      blocks.push({ type: "table", headers: ["From", "To", "Note"], wrap: [0, 1, 2],
        rows: conns.map((c) => [{ parts: [{ text: label(p, c.from), link: c.from.id }] },
          { parts: [{ text: label(p, c.to), link: c.to.id }] }, c.note]) });
    }

    const nPhotos = photoRefs(p).length;
    const files = ["project.json", ...(p.drawings || []), ...(nPhotos ? [`${nPhotos} photo${nPhotos === 1 ? "" : "s"}`] : []),
      "bom.csv", "structure.csv"];
    blocks.push({ type: "h", text: "About this file" });
    blocks.push({ type: "p", text: "This PDF is the project file. It embeds " + files.join(", ") +
      ". To change it, open it in the project planner editor (https://micsen.github.io/planner/) and export a new PDF." +
      ((p.drawings || []).length ? " The source drawings follow as the last pages." : "") });
    return blocks;
  }

  function toCsv(fields, rows) {
    const q = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [fields.map(q).join(","), ...rows.map((r) => fields.map((f) => q(r[f])).join(","))].join("\r\n") + "\r\n";
  }

  function csvFiles(p, res) {
    const rows = [];
    const path = [];
    const conns = connections(p);
    walk(p.root, (n, _parent, depth) => {
      path.length = depth;
      path.push(label(p, n));
      const c = n.kind === "item" ? itemOf(p, n) : null;
      const unit = c ? unitPrice(c) : null;
      rows.push({ path: path.join(" / "), depth, kind: n.kind, type: n.kind === "item" ? c.name : n.type,
        name: n.name || "", description: n.description || "", connections: linkSummary(p, n, conns), qty: n.kind === "item" ? n.qty : "",
        unit_price: unit, total: unit === null || n.kind !== "item" ? "" : unit * n.qty, job: n.job || "", comments: n.comments || "" });
    });
    return {
      "bom.csv": toCsv(["name", "description", "qty", "unit_price", "total", "notes"],
        res.lines.map((l) => ({ name: l.name, description: l.description, qty: l.qty, unit_price: l.unit, total: l.total, notes: l.notes }))),
      "structure.csv": toCsv(["path", "depth", "kind", "type", "name", "description", "connections", "qty", "unit_price", "total", "job", "comments"], rows),
    };
  }

  return { FORMAT, RESERVED_FILES, PHOTO_NAME, newProject, newPlace, newItem, newId, walk, nodes, label, unitPrice,
    connections, pruneLinks, linkSummary,
    analyze, report, csvFiles, fmtPrice, photoRefs, hasNotes };
});
