/* Local project editor: open a project PDF, edit the catalog and the place/item tree, export a new PDF.
 * All data lives in the PDF; nothing is stored or uploaded. */
(function () {
  "use strict";
  const { Planner, PlannerPdf } = window;

  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  };

  const state = { project: Planner.newProject(), drawings: [], images: new Map(), fileName: null, dirty: false,
    tab: "structure", selected: null, collapsed: new Set(), drag: null };

  const TABS = [["structure", "Structure"], ["catalog", "Catalog"], ["project", "Project"], ["drawings", "Drawings"], ["preview", "Preview"]];

  // ---- helpers -----------------------------------------------------------------------------
  const num = (raw) => { const s = raw.trim().replace(",", "."); return s === "" ? undefined : Number(s); };
  const findNode = (id) => { let hit = null; Planner.walk(state.project.root, (n, parent) => { if (n.id === id) hit = { node: n, parent }; }); return hit; };
  const isInside = (node, id) => { let found = false; Planner.walk(node, (n) => { if (n.id === id) found = true; }); return found; };
  const placeTypes = () => { const s = new Set(["Building", "Floor", "Room", "Door"]); Planner.walk(state.project.root, (n) => { if (n.kind === "place" && n.type) s.add(n.type); }); return [...s]; };
  const usage = (catId) => { let q = 0; Planner.walk(state.project.root, (n) => { if (n.kind === "item" && n.item === catId) q += n.qty || 0; }); return q; };

  const urls = new Map();
  const photoUrl = (name) => {
    if (!urls.has(name) && state.images.has(name)) urls.set(name, URL.createObjectURL(new Blob([state.images.get(name)])));
    return urls.get(name) || "";
  };

  /** Browser-decodable image -> JPEG (orientation applied, EXIF/GPS stripped, max 1600 px). */
  async function normalizePhoto(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = el("canvas", { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ---- state changes -----------------------------------------------------------------------
  function load(project, drawings, images, fileName) {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
    Object.assign(state, { project, drawings, images, fileName, dirty: false, selected: project.root.id, collapsed: new Set() });
    render();
  }
  function changed() { state.dirty = true; refresh(); }
  function structural() { state.dirty = true; render(); }
  const confirmDiscard = () => !state.dirty || confirm("This project has changes that are not exported to a PDF yet. Replace it anyway?");

  // ---- autosave (IndexedDB: holds binary photos/drawings and far more than localStorage) -------
  const DB_NAME = "project-planner", STORE = "state", KEY = "current";
  let saveTimer = null, autosave = "pending", restoring = true; // no saving until the stored copy has been read
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbRun(mode, fn) {
    const d = await db();
    try {
      return await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { d.close(); }
  }
  function setSaved(status, detail = "") {
    autosave = status;
    const n = document.getElementById("saved");
    n.textContent = { saving: "Saving…", saved: "Saved in this browser", failed: "Autosave failed" }[status] || "";
    n.title = detail;
    n.className = status === "failed" ? "warn" : "";
  }
  function scheduleSave() {
    if (state.drag || restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
    if (autosave !== "failed") setSaved("saving");
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    const images = new Map(Planner.photoRefs(state.project).map((r) => r.photo.file).filter((f) => state.images.has(f))
      .map((f) => [f, state.images.get(f)])); // drop photos that were removed
    const snapshot = { project: state.project, drawings: state.drawings, images, fileName: state.fileName,
      dirty: state.dirty, tab: state.tab, selected: state.selected, collapsed: state.collapsed, savedAt: Date.now() };
    try {
      await dbRun("readwrite", (st) => st.put(snapshot, KEY));
      setSaved("saved");
    } catch (err) { setSaved("failed", String(err && err.message || err)); }
  }
  async function restore() {
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("browser storage did not respond")), 4000));
      const s = await Promise.race([dbRun("readonly", (st) => st.get(KEY)), timeout]);
      if (!s || !s.project || s.project.format !== Planner.FORMAT) return false;
      Object.assign(state, { project: s.project, drawings: s.drawings || [], images: s.images || new Map(), fileName: s.fileName || null,
        dirty: !!s.dirty, tab: s.tab || "structure", selected: s.selected, collapsed: s.collapsed || new Set() });
      notice(`Restored ${s.project.root.name} from this browser (last edited ${new Date(s.savedAt).toLocaleString()}).` +
        (s.dirty ? " It has changes that are not exported to a PDF yet." : ""));
      return true;
    } catch (err) { setSaved("failed", String(err && err.message || err)); return false; }
  }

  // ---- rendering ---------------------------------------------------------------------------
  function render() {
    document.getElementById("tabs").replaceChildren(...TABS.map(([id, text]) => el("button", { type: "button", role: "tab",
      textContent: text, "aria-selected": String(state.tab === id), onclick: () => { state.tab = id; render(); } })));
    const views = { structure: renderStructure, catalog: renderCatalog, project: renderProject, drawings: renderDrawings, preview: () => renderPreview() };
    document.getElementById("view").replaceChildren(views[state.tab]());
    refresh();
  }

  /** Updates derived output without rebuilding inputs (keeps focus while typing). */
  function refresh() {
    scheduleSave();
    const p = state.project;
    const res = Planner.analyze(p);
    document.getElementById("project-name").textContent = p.root && p.root.name ? `· ${p.root.name}` : "";
    document.getElementById("dirty").hidden = !state.dirty;
    document.getElementById("btn-export").disabled = res.errors.length > 0;
    const box = document.getElementById("errors");
    box.hidden = !res.errors.length;
    box.replaceChildren(el("b", { textContent: `${res.errors.length} problem${res.errors.length === 1 ? "" : "s"} to fix before export` }),
      el("ul", {}, res.errors.slice(0, 20).map((m) => el("li", { textContent: m }))));
    document.getElementById("summary").textContent = res.errors.length ? "" :
      [...Object.entries(res.typeCounts).map(([t, n]) => `${n} ${t}`), `${Planner.fmtPrice(res.pricing.total)} ${res.pricing.currency} ex. MVA`].join(" · ");
    const tree = document.getElementById("tree");
    if (tree) tree.replaceChildren(...treeRows());
    if (state.tab === "preview") document.getElementById("view").replaceChildren(renderPreview(res));
  }

  // ---- structure -----------------------------------------------------------------------------
  function renderStructure() {
    if (!findNode(state.selected)) state.selected = state.project.root.id;
    return el("div", { class: "layout" },
      el("div", { class: "tree", id: "tree", role: "tree", "aria-label": "Project structure" }, treeRows()),
      el("div", { class: "details" }, renderDetails(findNode(state.selected))));
  }

  function treeRows() {
    const rows = [];
    const p = state.project;
    const linkCount = new Map();
    for (const c of Planner.connections(p)) for (const x of [c.from, c.to]) linkCount.set(x.id, (linkCount.get(x.id) || 0) + 1);
    const visit = (n, depth) => {
      const kids = n.children || [];
      const open = !state.collapsed.has(n.id);
      const nLinks = (linkCount.get(n.id) || 0);
      const badges = [nLinks ? `⇄ ${nLinks}` : "", (n.photos || []).length ? `📷 ${n.photos.length}` : "", (n.job || n.comments) ? "✎" : ""]
        .filter(Boolean).join(" ");
      const name = n.kind === "item"
        ? [el("span", { class: "k item", textContent: "Item" }), " ", Planner.label(p, n)]
        : [el("span", { class: "k", textContent: n.type || "?" }), " ", n.name || ""];
      const select = () => { state.selected = n.id; render(); };
      const row = el("div", { class: "row" + (n.id === state.selected ? " sel" : ""), style: `padding-left:${depth * 18 + 4}px`,
        draggable: n !== p.root },
        kids.length ? el("button", { type: "button", class: "tog", "aria-label": open ? "Collapse" : "Expand", "aria-expanded": String(open),
          textContent: open ? "▾" : "▸", onclick: () => { open ? state.collapsed.add(n.id) : state.collapsed.delete(n.id); refresh(); } })
          : el("span", { class: "tog" }),
        // Not a <button>: Firefox will not start a drag from a button.
        el("div", { class: "pick", role: "treeitem", tabIndex: 0, "aria-selected": String(n.id === state.selected),
          onclick: select, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } } },
          name, n.description ? el("span", { class: "d", textContent: n.description }) : null,
          badges ? el("span", { class: "b", textContent: badges }) : null));
      dragTarget(row, n);
      rows.push(row);
      if (open) for (const c of kids) visit(c, depth + 1);
    };
    visit(p.root, 0);
    return rows;
  }

  // ---- drag and drop in the tree ---------------------------------------------------------------
  const DROP = ["drop-before", "drop-inside", "drop-after", "drop-link"];
  const linkMode = (e) => e.altKey || e.shiftKey; // hold Alt or Shift while dropping to connect instead of move
  /** Where a drop on this row goes: top quarter before, bottom quarter after, otherwise inside. */
  function dropPosition(e, row, n) {
    if (n === state.project.root) return "inside";
    const r = row.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    return f < 0.25 ? "before" : f > 0.75 ? "after" : "inside";
  }
  function canDrop(dragId, n, e) {
    const src = dragId && findNode(dragId);
    if (!src) return false;
    if (linkMode(e)) return src.node !== n;
    return !isInside(src.node, n.id);
  }
  function dragTarget(row, n) {
    row.addEventListener("dragstart", (e) => {
      if (n === state.project.root) return e.preventDefault();
      state.drag = n.id;
      e.dataTransfer.effectAllowed = "linkMove";
      e.dataTransfer.setData("text/plain", Planner.label(state.project, n));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      state.drag = null;
      for (const r of document.querySelectorAll(".row")) r.classList.remove("dragging", ...DROP);
    });
    row.addEventListener("dragover", (e) => {
      row.classList.remove(...DROP);
      if (!canDrop(state.drag, n, e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = linkMode(e) ? "link" : "move";
      row.classList.add(linkMode(e) ? "drop-link" : `drop-${dropPosition(e, row, n)}`);
    });
    row.addEventListener("dragleave", (e) => { if (!row.contains(e.relatedTarget)) row.classList.remove(...DROP); });
    row.addEventListener("drop", (e) => {
      if (!canDrop(state.drag, n, e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (linkMode(e)) connect(findNode(state.drag).node, n);
      else moveNode(state.drag, n, dropPosition(e, row, n));
      state.drag = null;
    });
  }
  function connect(from, to, note = "") {
    from.links = from.links || [];
    if (from === to || from.links.some((l) => l.to === to.id)) return;
    from.links.push({ to: to.id, note });
    state.selected = from.id;
    structural();
  }

  function moveNode(id, target, pos) {
    const { node, parent } = findNode(id);
    parent.children.splice(parent.children.indexOf(node), 1);
    if (pos === "inside") {
      target.children.push(node);
      state.collapsed.delete(target.id);
    } else {
      const siblings = findNode(target.id).parent.children;
      siblings.splice(siblings.indexOf(target) + (pos === "after" ? 1 : 0), 0, node);
    }
    state.selected = id;
    structural();
  }

  function field(text, control, wide) { return el("label", { class: wide ? "wide" : "" }, text, control); }
  function textInput(obj, key, after) {
    return el("input", { type: "text", value: obj[key] || "", oninput: (e) => { obj[key] = e.target.value; changed(); if (after) after(); } });
  }
  function textArea(obj, key, placeholder) {
    return el("textarea", { value: obj[key] || "", placeholder, oninput: (e) => { obj[key] = e.target.value; changed(); } });
  }

  function renderDetails(hit) {
    const { node: n, parent } = hit;
    const p = state.project;
    const isRoot = n === p.root;
    const out = [el("h2", { textContent: Planner.label(p, n) })];

    if (n.kind === "place") {
      const types = el("datalist", { id: "place-types" }, placeTypes().map((t) => el("option", { value: t })));
      const typeIn = textInput(n, "type");
      typeIn.setAttribute("list", "place-types");
      out.push(el("div", { class: "fields" }, field("Type", typeIn), types, field("Name", textInput(n, "name")),
        field("Description", textInput(n, "description"), true)));
    } else {
      out.push(el("div", { class: "fields" },
        field("Item", el("select", { onchange: (e) => { n.item = e.target.value; changed(); } },
          p.catalog.map((c) => el("option", { value: c.id, textContent: c.name, selected: c.id === n.item })))),
        field("Quantity", el("input", { type: "text", inputMode: "decimal", value: String(n.qty),
          oninput: (e) => { n.qty = num(e.target.value) ?? null; changed(); } })),
        field("Name / tag (optional, e.g. A2-B1)", textInput(n, "name")),
        field("Description (address, notes, …)", textInput(n, "description"), true)));
    }
    out.push(el("div", { class: "fields" }, field("Job description", textArea(n, "job", "What to do here"), true),
      field("Comments", textArea(n, "comments", "Observations, risks, notes"), true)));
    out.push(photoEditor(n));
    out.push(connectionsEditor(n));

    // add children
    const itemSel = el("select", {}, p.catalog.map((c) => el("option", { value: c.id, textContent: c.name })));
    const addPlaceType = el("input", { type: "text", value: "Door", "aria-label": "Type for new places" });
    addPlaceType.setAttribute("list", "place-types");
    const bulk = el("textarea", { placeholder: "One place per line: name, or name ⇥ description" });
    const add = (child) => { n.children.push(child); state.collapsed.delete(n.id); state.selected = child.id; structural(); };
    out.push(el("fieldset", {}, el("legend", { textContent: "Add inside" }),
      el("div", { class: "toolbar" },
        el("button", { type: "button", textContent: "+ Place", onclick: () => add(Planner.newPlace(addPlaceType.value || "Place", "")) }),
        el("span", { class: "hint", textContent: "of type" }), addPlaceType),
      el("div", { class: "toolbar" },
        p.catalog.length ? [el("button", { type: "button", textContent: "+ Item", onclick: () => add(Planner.newItem(itemSel.value)) }), itemSel]
          : el("span", { class: "hint", textContent: "Add items to the catalog first." })),
      el("details", {}, el("summary", { textContent: "Add several places from a list…" }), bulk,
        el("button", { type: "button", textContent: "Add places", onclick: () => {
          const lines = bulk.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            const [name, ...rest] = line.split("\t");
            const c = Planner.newPlace(addPlaceType.value || "Place", name.trim());
            c.description = rest.join(" ").trim();
            n.children.push(c);
          }
          state.collapsed.delete(n.id);
          structural();
        } }))));

    if (!isRoot) {
      const siblings = parent.children;
      const i = siblings.indexOf(n);
      const targets = [];
      Planner.walk(p.root, (t, _par, depth) => { if (!isInside(n, t.id)) targets.push([t, depth]); });
      out.push(el("fieldset", {}, el("legend", { textContent: "Arrange" }),
        el("div", { class: "toolbar" },
          el("button", { type: "button", textContent: "↑ Up", disabled: i === 0, onclick: () => { siblings.splice(i - 1, 0, ...siblings.splice(i, 1)); structural(); } }),
          el("button", { type: "button", textContent: "↓ Down", disabled: i === siblings.length - 1, onclick: () => { siblings.splice(i + 1, 0, ...siblings.splice(i, 1)); structural(); } }),
          el("button", { type: "button", textContent: "Duplicate", onclick: () => {
            const copy = cloneNode(n); siblings.splice(i + 1, 0, copy); state.selected = copy.id; structural(); } }),
          el("button", { type: "button", class: "danger", textContent: "Delete", onclick: () => {
            const count = Planner.nodes({ root: n }).length - 1;
            if (!confirm(`Delete ${Planner.label(p, n)}${count ? ` and the ${count} node${count === 1 ? "" : "s"} inside it` : ""}?`)) return;
            siblings.splice(i, 1); Planner.pruneLinks(p); state.selected = parent.id; structural(); } })),
        field("Move into", el("select", { onchange: (e) => {
          const target = findNode(e.target.value).node;
          siblings.splice(i, 1); target.children.push(n); state.collapsed.delete(target.id); structural(); } },
          targets.map(([t, depth]) => el("option", { value: t.id, selected: t === parent,
            textContent: "  ".repeat(depth) + Planner.label(p, t) }))))));
    }
    return out;
  }

  /** Outgoing links are stored on this node; incoming ones are shown (and editable) here too. */
  function connectionsEditor(n) {
    const p = state.project;
    const conns = Planner.connections(p);
    const jump = (target) => el("button", { type: "button", class: "linkto", textContent: Planner.label(p, target),
      onclick: () => { state.selected = target.id; render(); } });
    const row = (c, other, arrow, owner) => {
      const link = owner.links.find((l) => l.to === c.to.id);
      return el("div", { class: "conn" }, el("span", { class: "arrow", textContent: arrow }), jump(other),
        el("input", { type: "text", value: link.note || "", placeholder: "Note (outputs, port, …)", "aria-label": "Connection note",
          oninput: (e) => { link.note = e.target.value; changed(); } }),
        el("button", { type: "button", class: "icon", textContent: "×", "aria-label": "Remove connection",
          onclick: () => { owner.links.splice(owner.links.indexOf(link), 1); structural(); } }));
    };
    const outgoing = conns.filter((c) => c.from === n).map((c) => row(c, c.to, "→", n));
    const incoming = conns.filter((c) => c.to === n).map((c) => row(c, c.from, "←", c.from));
    const linked = new Set((n.links || []).map((l) => l.to));
    const options = [];
    Planner.walk(p.root, (t, _par, depth) => {
      if (t !== n && !linked.has(t.id)) options.push(el("option", { value: t.id, textContent: "\u00a0\u00a0".repeat(depth) + Planner.label(p, t) }));
    });
    const target = el("select", { "aria-label": "Connect to" }, options);
    return el("fieldset", {}, el("legend", { textContent: `Connections (${outgoing.length + incoming.length})` }),
      outgoing, incoming,
      el("div", { class: "toolbar" }, el("button", { type: "button", textContent: "Connect to", disabled: !options.length,
        onclick: () => connect(n, findNode(target.value).node) }), target),
      el("p", { class: "hint", textContent: "Connections are loose links (e.g. a board to the doors it drives), separate from where things are. Tip: hold Alt or Shift while dropping one tree row on another to connect them." }));
  }

  /** Deep copy with fresh ids; photos are copied under new names. */
  function cloneNode(n) {
    const c = JSON.parse(JSON.stringify(n));
    Planner.walk(c, (x) => {
      x.id = Planner.newId();
      x.photos = (x.photos || []).map((ph) => {
        const name = `${Planner.newId("p")}.${ph.file.split(".").pop()}`;
        state.images.set(name, state.images.get(ph.file));
        return { ...ph, file: name };
      });
    });
    return c;
  }

  function photoEditor(n) {
    const picker = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onchange: async (e) => {
      for (const f of e.target.files) {
        try {
          const name = `${Planner.newId("p")}.jpg`;
          state.images.set(name, await normalizePhoto(f));
          (n.photos = n.photos || []).push({ file: name, caption: "" });
        } catch (err) { alert(`Could not read ${f.name} as an image (${err.message || err}). Try a JPEG or PNG.`); }
      }
      structural();
    } });
    const cards = (n.photos || []).map((ph, i) => el("figure", { class: "ph" },
      el("img", { src: photoUrl(ph.file), alt: ph.caption || "Photo" }),
      el("input", { type: "text", value: ph.caption || "", placeholder: "Caption", "aria-label": "Caption",
        oninput: (e) => { ph.caption = e.target.value; changed(); } }),
      el("div", { class: "toolbar" },
        el("button", { type: "button", class: "icon", textContent: "←", "aria-label": "Move left", disabled: i === 0,
          onclick: () => { n.photos.splice(i - 1, 0, ...n.photos.splice(i, 1)); structural(); } }),
        el("button", { type: "button", class: "icon", textContent: "→", "aria-label": "Move right", disabled: i === n.photos.length - 1,
          onclick: () => { n.photos.splice(i + 1, 0, ...n.photos.splice(i, 1)); structural(); } }),
        el("button", { type: "button", class: "icon danger", textContent: "Remove",
          onclick: () => { if (confirm("Remove this photo?")) { n.photos.splice(i, 1); structural(); } } }))));
    return el("fieldset", {}, el("legend", { textContent: `Photos (${(n.photos || []).length})` }),
      el("div", { class: "photos" }, cards),
      el("div", { class: "toolbar" }, el("button", { type: "button", textContent: "Add photos…", onclick: () => picker.click() }), picker,
        el("span", { class: "hint", textContent: "Resized to max 1600 px and saved as JPEG; location data is removed." })));
  }

  // ---- catalog -----------------------------------------------------------------------------
  function renderCatalog() {
    const cat = state.project.catalog;
    const cols = [["name", "Name", "text"], ["description", "Description", "text"], ["unit_price", "Unit price", "num"],
      ["cost", "Cost", "num"], ["markup", "Markup", "num"], ["notes", "Notes", "text"]];
    const body = cat.map((c, ri) => el("tr", {},
      cols.map(([k, , type]) => el("td", {}, el("input", { type: "text", inputMode: type === "num" ? "decimal" : "text",
        value: c[k] === undefined || c[k] === null ? "" : String(c[k]), "aria-label": k,
        oninput: (e) => { if (type === "num") { const v = num(e.target.value); if (v === undefined) delete c[k]; else c[k] = v; } else c[k] = e.target.value; changed(); } }))),
      el("td", { class: "n", textContent: String(usage(c.id)) }),
      el("td", {}, el("button", { type: "button", class: "icon", textContent: "×", "aria-label": `Delete ${c.name}`, onclick: () => {
        if (usage(c.id)) { alert(`${c.name} is used in the structure. Remove it there first.`); return; }
        cat.splice(ri, 1); structural(); } }))));
    return el("div", {},
      el("div", { class: "toolbar" },
        el("button", { type: "button", textContent: "Add item", onclick: () => { cat.push({ id: Planner.newId("c"), name: "", description: "" }); structural(); } }),
        el("span", { class: "hint", textContent: "Items you can place in the structure. Price with a unit price, or cost + markup (0.25 = 25 % margin)." })),
      cat.length ? el("div", { class: "tw" }, el("table", {},
        el("thead", {}, el("tr", {}, cols.map(([, t]) => el("th", { textContent: t })), el("th", { class: "n", textContent: "Used" }), el("th"))),
        el("tbody", {}, body))) : el("p", { class: "empty", textContent: "No items yet." }));
  }

  // ---- project -----------------------------------------------------------------------------
  function renderProject() {
    const p = state.project;
    const vat = el("input", { type: "text", inputMode: "decimal", value: String(p.pricing.vat_rate ?? ""),
      oninput: (e) => { p.pricing.vat_rate = num(e.target.value) ?? null; changed(); } });
    return el("div", {},
      el("fieldset", {}, el("legend", { textContent: "Project" }), el("div", { class: "fields" },
        field("Name", textInput(p.root, "name")), field("Description (top of the report)", textArea(p.root, "description"), true))),
      el("fieldset", {}, el("legend", { textContent: "Pricing (excl. MVA)" }), el("div", { class: "fields" },
        field("Currency", textInput(p.pricing, "currency")), field("MVA rate (0.25 = 25 %)", vat))),
      el("p", { class: "hint", textContent: "Job description, comments and photos for the whole project: select the top node in Structure." }));
  }

  // ---- drawings ----------------------------------------------------------------------------
  function renderDrawings() {
    const picker = el("input", { type: "file", accept: "application/pdf,.pdf", multiple: true, hidden: true,
      onchange: async (e) => {
        for (const f of e.target.files) {
          try {
            const bytes = new Uint8Array(await f.arrayBuffer());
            await PlannerPdf.checkDrawing(bytes);
            if (state.drawings.some((d) => d.name === f.name) || Planner.RESERVED_FILES.includes(f.name))
              throw new Error("a drawing with that name already exists or the name is reserved");
            state.drawings.push({ name: f.name, bytes });
          } catch (err) { alert(`Could not add ${f.name}: ${err.message}`); }
        }
        syncDrawings();
        render();
      } });
    const rows = state.drawings.map((d, i) => el("tr", {},
      el("td", { textContent: d.name }), el("td", { class: "n", textContent: `${Math.round(d.bytes.length / 1024)} kB` }),
      el("td", {}, el("button", { type: "button", textContent: "Download", onclick: () => download(d.bytes, d.name) }), " ",
        el("button", { type: "button", textContent: "Remove", onclick: () => {
          if (!confirm(`Remove ${d.name} from the project?`)) return;
          state.drawings.splice(i, 1); syncDrawings(); render(); } }))));
    return el("div", {},
      el("div", { class: "toolbar" }, el("button", { type: "button", textContent: "Add drawing PDF…", onclick: () => picker.click() }), picker,
        el("span", { class: "hint", textContent: "Drawings are embedded in the exported PDF and appended as pages." })),
      rows.length ? el("div", { class: "tw" }, el("table", {}, el("thead", {}, el("tr", {},
        el("th", { textContent: "File" }), el("th", { class: "n", textContent: "Size" }), el("th"))), el("tbody", {}, rows)))
        : el("p", { class: "empty", textContent: "No drawings." }));
  }
  function syncDrawings() { state.project.drawings = state.drawings.map((d) => d.name); state.dirty = true; }

  // ---- preview -----------------------------------------------------------------------------
  function renderPreview(res = Planner.analyze(state.project)) {
    if (res.errors.length) return el("p", { class: "empty", textContent: "Fix the problems above to see the report." });
    const pvId = (id) => (id ? `pv-${id}` : undefined);
    const cell = (c) => (c && typeof c === "object" && c.parts
      ? c.parts.map((pt) => el("div", {}, pt.link ? el("a", { href: `#${pvId(pt.link)}`, textContent: pt.text, onclick: (e) => {
        e.preventDefault();
        const t = document.getElementById(pvId(pt.link));
        if (t) { t.scrollIntoView({ block: "center" }); t.classList.add("flash"); setTimeout(() => t.classList.remove("flash"), 1200); }
      } }) : pt.text))
      : String(c));
    return el("div", { class: "pv" }, Planner.report(state.project, res).map((b) => {
      if (b.type === "title") return el("h1", { textContent: b.text, id: pvId(b.anchor) });
      if (b.type === "h") return el("h2", { textContent: b.text, id: pvId(b.anchor) });
      if (b.type === "h3") return el("h3", { textContent: b.text });
      if (b.type === "p") return el("p", { class: b.warn ? "warn" : "" }, b.label ? [el("b", { textContent: b.label }), el("br")] : null, b.text);
      if (b.type === "kpis") return el("div", { class: "kpis" }, b.items.map(([k, v]) =>
        el("div", { class: "kpi" }, el("b", { textContent: String(v) }), el("span", { textContent: k }))));
      if (b.type === "photos") return el("div", { class: "photos" }, b.items.map((ph) =>
        el("figure", { class: "ph" }, el("img", { src: photoUrl(ph.file), alt: ph.caption || "Photo" }),
          ph.caption ? el("figcaption", { textContent: ph.caption }) : null)));
      const numCols = new Set(b.num || []), bold = new Set(b.bold || []);
      return el("div", { class: "tw" }, el("table", {},
        el("thead", {}, el("tr", {}, b.headers.map((h, i) => el("th", { class: numCols.has(i) ? "n" : "", textContent: h })))),
        el("tbody", {}, b.rows.map((r, ri) => el("tr", { class: bold.has(ri) ? "tot" : "", id: pvId((b.anchors || [])[ri]) },
          r.map((c, i) => el("td", { class: numCols.has(i) ? "n" : "" }, cell(c))))))));
    }));
  }

  // ---- files -------------------------------------------------------------------------------
  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream" }));
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function openFile(file) {
    if (!file || !confirmDiscard()) return;
    try {
      const { project, drawings, images } = await PlannerPdf.importPdf(new Uint8Array(await file.arrayBuffer()));
      notice(`Opened ${file.name}.`);
      load(project, drawings, images, file.name);
    } catch (err) { alert(`Could not open ${file.name}: ${err.message}`); }
  }

  async function exportPdf() {
    const btn = document.getElementById("btn-export");
    btn.disabled = true;
    try {
      const bytes = await PlannerPdf.exportPdf(state.project, state.drawings, state.images);
      const slug = state.project.root.name.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "project";
      const name = state.fileName || `${slug}.pdf`;
      download(bytes, name);
      state.fileName = name;
      state.dirty = false;
      notice(`Exported ${name}. Keep this PDF: it is the project file.`);
    } catch (err) { alert(`Export failed: ${err.message}`); }
    refresh();
  }

  function notice(text) {
    const n = document.getElementById("notice");
    n.textContent = text;
    n.hidden = false;
  }

  // ---- wiring ------------------------------------------------------------------------------
  const fileInput = document.getElementById("file-open");
  document.getElementById("btn-open").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { openFile(fileInput.files[0]); fileInput.value = ""; });
  document.getElementById("btn-export").addEventListener("click", exportPdf);
  document.getElementById("btn-new").addEventListener("click", () => {
    if (confirmDiscard()) { load(Planner.newProject(), [], new Map(), null); notice("Started a new project."); }
  });
  let dragDepth = 0;
  const isFileDrag = (e) => !state.drag && [...(e.dataTransfer ? e.dataTransfer.types : [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add("drag"); });
  window.addEventListener("dragleave", (e) => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("drag"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f && /\.pdf$/i.test(f.name)) openFile(f);
  });
  // Work is kept in the browser; only warn on leaving if the last autosave did not succeed.
  window.addEventListener("beforeunload", (e) => { if (autosave !== "saved" && state.dirty) { e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });

  // Draw right away; swap in the autosaved project once browser storage has answered.
  notice("Open a project PDF (button or drag & drop) or build a new project. Everything stays on this computer and is autosaved in this browser.");
  state.selected = state.project.root.id;
  render();
  restore().then((restored) => {
    restoring = false;
    if (restored) render();
    else if (autosave !== "failed") scheduleSave();
  });
})();
