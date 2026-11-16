/* Project PDF: export (report pages + drawing pages + embedded project.json, drawings, CSVs) and import.
 * Shared by the browser editor (window.PlannerPdf) and the Node CLI (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports)
    module.exports = factory(require("./planner.js"), require("./vendor/pdf-lib.min.js"));
  else root.PlannerPdf = factory(root.Planner, root.PDFLib);
})(typeof self !== "undefined" ? self : this, function (Planner, PDFLib) {
  "use strict";
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
  const DATA_FILE = "project.json";

  const PAGE = [841.89, 595.28]; // A4 landscape
  const M = 36;
  const C = { text: rgb(0.11, 0.12, 0.14), muted: rgb(0.4, 0.43, 0.47), line: rgb(0.85, 0.87, 0.89),
    head: rgb(0.95, 0.96, 0.97), accent: rgb(0.18, 0.44, 0.87), warn: rgb(0.7, 0.42, 0) };

  // Standard PDF fonts only cover WinAnsi; map the few other characters we use and drop the rest.
  const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  const SUBST = { "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "Ω": "Ohm", "⚠": "!", "‑": "-", "\t": " " };
  function safe(s) {
    let out = "";
    for (const ch of String(s === null || s === undefined ? "" : s)) {
      if (SUBST[ch]) out += SUBST[ch];
      else if (ch === "\n" || (ch >= " " && ch.charCodeAt(0) < 0x7f) || (ch.charCodeAt(0) >= 0xa0 && ch.charCodeAt(0) <= 0xff)
        || WINANSI_EXTRA.includes(ch)) out += ch;
      else out += "?";
    }
    return out;
  }

  function wrap(text, font, size, width) {
    const lines = [];
    for (const para of safe(text).split("\n")) {
      let line = "";
      for (const word of para.split(/ +/)) {
        const cand = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(cand, size) <= width + 0.01) { line = cand; continue; }
        if (line) lines.push(line);
        line = word;
        while (font.widthOfTextAtSize(line, size) > width + 0.01 && line.length > 1) { // hard-break long words
          let n = line.length - 1;
          while (n > 1 && font.widthOfTextAtSize(line.slice(0, n), size) > width) n--;
          lines.push(line.slice(0, n));
          line = line.slice(n);
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function renderReport(doc, fonts, blocks, footer, photos) {
    const [W, H] = PAGE;
    const avail = W - 2 * M;
    const usable = H - 2 * M - 14;
    let page, y;
    const pages = [];
    const newPage = () => { page = doc.addPage(PAGE); pages.push(page); y = H - M; };
    const ensure = (h) => { if (y - h < M + 14) newPage(); };
    const draw = (s, x, yy, size, font, color = C.text) => page.drawText(safe(s), { x, y: yy, size, font, color });

    const P = { size: 9.5, lh: 13 };
    const paraLines = (blk) => wrap(blk.text, fonts.r, P.size, avail);
    const tables = new Map(blocks.filter((b) => b.type === "table").map((t) => [t, layoutTable(t)]));
    const PH = { cols: 3, gap: 12, maxH: 180, cap: 8, capLh: 10 };
    const photoW = (avail - PH.gap * (PH.cols - 1)) / PH.cols;
    const photoRows = (blk) => {
      const rows = [];
      blk.items.forEach((item, i) => {
        const img = photos.get(item.file);
        const k = Math.min(photoW / img.width, PH.maxH / img.height, 1);
        const cell = { img, w: img.width * k, h: img.height * k, caption: item.caption ? wrap(item.caption, fonts.r, PH.cap, photoW) : [] };
        if (i % PH.cols === 0) rows.push({ cells: [], h: 0 });
        const row = rows[rows.length - 1];
        row.cells.push(cell);
        row.h = Math.max(row.h, cell.h + (cell.caption.length ? 4 + cell.caption.length * PH.capLh : 0) + PH.gap);
      });
      return rows;
    };
    const height = (blk) => (!blk ? 0 : blk.type === "p" ? (blk.label ? P.lh : 0) + paraLines(blk).length * P.lh + 4
      : blk.type === "table" ? tables.get(blk).total + 6 : blk.type === "kpis" ? 52
      : blk.type === "photos" ? photoRows(blk)[0].h : 0);
    const followHeight = (i) => {
      let f = height(blocks[i + 1]);
      if (blocks[i + 1] && blocks[i + 1].type === "p" && blocks[i + 2] && ["table", "photos"].includes(blocks[i + 2].type)) f += height(blocks[i + 2]);
      return f;
    };

    newPage();
    blocks.forEach((blk, i) => {
      if (blk.type === "title") {
        draw(blk.text, M, y - 18, 18, fonts.b);
        y -= 30;
      } else if (blk.type === "h") {
        // Keep the heading with what follows (a paragraph and/or table) when that fits on one page.
        const follow = followHeight(i);
        ensure(30 + (follow <= usable - 30 ? follow : 60));
        y -= 10;
        draw(blk.text, M, y - 13, 13, fonts.b);
        y -= 20;
      } else if (blk.type === "h3") {
        const follow = followHeight(i);
        ensure(22 + (follow <= usable - 22 ? follow : 40));
        y -= 6;
        draw(blk.text, M, y - 11, 11, fonts.b);
        y -= 16;
      } else if (blk.type === "photos") {
        for (const row of photoRows(blk)) {
          ensure(row.h);
          row.cells.forEach((c, k) => {
            const x = M + k * (photoW + PH.gap);
            page.drawImage(c.img, { x, y: y - c.h, width: c.w, height: c.h });
            c.caption.forEach((line, li) => draw(line, x, y - c.h - 4 - PH.cap - li * PH.capLh, PH.cap, fonts.r, C.muted));
          });
          y -= row.h;
        }
      } else if (blk.type === "p") {
        if (blk.label) {
          ensure(P.lh * 2);
          draw(blk.label, M, y - P.size, P.size, fonts.b);
          y -= P.lh;
        }
        for (const line of paraLines(blk)) {
          ensure(P.lh);
          draw(line, M, y - P.size, P.size, fonts.r, blk.warn ? C.warn : C.text);
          y -= P.lh;
        }
        y -= 4;
      } else if (blk.type === "kpis") {
        ensure(48);
        const gap = 8;
        const w = (avail - gap * (blk.items.length - 1)) / blk.items.length;
        blk.items.forEach(([label, value], k) => {
          const x = M + k * (w + gap);
          page.drawRectangle({ x, y: y - 42, width: w, height: 42, color: C.head });
          draw(value, x + 10, y - 22, 16, fonts.b);
          draw(label, x + 10, y - 35, 8, fonts.r, C.muted);
        });
        y -= 52;
      } else if (blk.type === "table") {
        paintTable(tables.get(blk));
        y -= 6;
      }
    });

    function layoutTable(t) {
      const size = 8, pad = 4, lh = 10;
      const num = new Set(t.num || []), bold = new Set(t.bold || []), wrapCols = new Set(t.wrap || []);
      const fontFor = (ri) => (bold.has(ri) ? fonts.b : fonts.r);
      const natural = t.headers.map((h, ci) => Math.max(
        fonts.b.widthOfTextAtSize(safe(h), size),
        ...t.rows.map((r, ri) => Math.max(...safe(r[ci]).split("\n").map((x) => fontFor(ri).widthOfTextAtSize(x, size))))) + 2 * pad);
      let widths = natural.slice();
      let total = widths.reduce((a, x) => a + x, 0);
      if (total > avail) { // shrink wrappable columns first, then everything
        const fixed = widths.reduce((a, x, i) => a + (wrapCols.has(i) ? 0 : x), 0);
        const flex = total - fixed;
        if (flex > 0 && fixed < avail) widths = widths.map((x, i) => (wrapCols.has(i) ? Math.max(40, (x / flex) * (avail - fixed)) : x));
        total = widths.reduce((a, x) => a + x, 0);
        if (total > avail + 0.5) widths = widths.map((x) => (x * avail) / total);
      }
      const row = (cells, font, fill) => {
        const lines = cells.map((v, ci) => wrap(v, font, size, widths[ci] - 2 * pad));
        return { lines, font, fill, h: Math.max(...lines.map((l) => l.length)) * lh + 2 * pad - 2 };
      };
      const header = row(t.headers, fonts.b, C.head);
      const rows = t.rows.map((r, ri) => row(r, fontFor(ri)));
      return { size, pad, lh, num, widths, width: widths.reduce((a, x) => a + x, 0), header, rows,
        total: header.h + rows.reduce((a, r) => a + r.h, 0) };
    }

    function paintTable(L) {
      const paint = (r) => {
        if (r.fill) page.drawRectangle({ x: M, y: y - r.h, width: L.width, height: r.h, color: r.fill });
        let x = M;
        r.lines.forEach((ls, ci) => {
          ls.forEach((s, li) => {
            const tx = L.num.has(ci) ? x + L.widths[ci] - L.pad - r.font.widthOfTextAtSize(s, L.size) : x + L.pad;
            page.drawText(s, { x: tx, y: y - L.pad - L.size - li * L.lh + 1, size: L.size, font: r.font, color: C.text });
          });
          x += L.widths[ci];
        });
        page.drawLine({ start: { x: M, y: y - r.h }, end: { x: M + L.width, y: y - r.h }, thickness: 0.5, color: C.line });
        y -= r.h;
      };
      ensure(L.total <= usable ? L.total : L.header.h + (L.rows[0] ? L.rows[0].h : 0));
      paint(L.header);
      for (const r of L.rows) {
        if (y - r.h < M + 14) { newPage(); paint(L.header); }
        paint(r);
      }
    }

    pages.forEach((pg, i) => {
      pg.drawText(safe(`${footer}   ·   page ${i + 1} of ${pages.length}`), { x: M, y: M - 14, size: 7.5, font: fonts.r, color: C.muted });
    });
  }

  const utf8 = (s) => new TextEncoder().encode(s);

  const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const isJpg = (b) => b[0] === 0xff && b[1] === 0xd8;

  /** project: plain object; drawings: [{ name, bytes }] in project.drawings order;
   *  images: Map of photo file name -> bytes (JPEG or PNG) for every photo the project references. */
  async function exportPdf(project, drawings, images = new Map(), now = new Date()) {
    const res = Planner.analyze(project);
    if (res.errors.length) throw new Error("Fix these first:\n" + res.errors.join("\n"));
    const want = project.drawings || [];
    if (want.length !== drawings.length || want.some((n, i) => drawings[i].name !== n))
      throw new Error("Drawing list does not match project.drawings");

    const doc = await PDFDocument.create();
    doc.setTitle(project.root.name);
    doc.setCreator("project-planner");
    doc.setProducer("project-planner (pdf-lib)");
    doc.setCreationDate(now);
    doc.setModificationDate(now);
    const fonts = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold) };
    const photos = new Map();
    for (const { owner, photo } of Planner.photoRefs(project)) {
      if (!images.get(photo.file)) throw new Error(`${owner}: photo ${photo.file} is missing`);
      const bytes = new Uint8Array(images.get(photo.file)); // copy: pdf-lib's JPEG parser ignores byteOffset
      if (isJpg(bytes)) photos.set(photo.file, await doc.embedJpg(bytes));
      else if (isPng(bytes)) photos.set(photo.file, await doc.embedPng(bytes));
      else throw new Error(`${owner}: photo ${photo.file} is not a JPEG or PNG`);
    }
    renderReport(doc, fonts, Planner.report(project, res), `${project.root.name}   ·   generated ${now.toISOString().slice(0, 10)}`, photos);

    for (const d of drawings) {
      const src = await PDFDocument.load(d.bytes, { ignoreEncryption: true });
      for (const pg of await doc.copyPages(src, src.getPageIndices())) doc.addPage(pg);
    }

    const opts = (mimeType, description) => ({ mimeType, description, creationDate: now, modificationDate: now });
    await doc.attach(utf8(JSON.stringify(project, null, 2) + "\n"), DATA_FILE,
      opts("application/json", "Project data – import this PDF in the project planner editor"));
    for (const d of drawings) await doc.attach(d.bytes, d.name, opts("application/pdf", "Source drawing"));
    for (const { owner, photo } of Planner.photoRefs(project)) {
      const bytes = images.get(photo.file);
      await doc.attach(bytes, photo.file, opts(isPng(bytes) ? "image/png" : "image/jpeg", `Photo – ${owner}`));
    }
    for (const [name, text] of Object.entries(Planner.csvFiles(project, res))) await doc.attach(utf8(text), name, opts("text/csv", "Generated"));
    return doc.save();
  }

  function attachments(doc) {
    const out = new Map();
    const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
    const tree = names && names.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
    const walk = (node) => {
      const arr = node.lookupMaybe(PDFName.of("Names"), PDFArray);
      for (let i = 0; arr && i + 1 < arr.size(); i += 2) {
        const spec = arr.lookup(i + 1, PDFDict);
        const ef = spec.lookupMaybe(PDFName.of("EF"), PDFDict);
        const stream = ef && ef.lookup(PDFName.of("F"));
        if (stream instanceof PDFRawStream) out.set(arr.lookup(i).decodeText(), decodePDFRawStream(stream).decode());
      }
      const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
      for (let i = 0; kids && i < kids.size(); i++) walk(kids.lookup(i, PDFDict));
    };
    if (tree) walk(tree);
    return out;
  }

  /** Returns { project, drawings, images } from a PDF made by exportPdf. */
  async function importPdf(bytes) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const files = attachments(doc);
    const data = files.get(DATA_FILE);
    if (!data) throw new Error("This PDF has no embedded project.json, so it was not exported by the project planner.");
    const project = JSON.parse(new TextDecoder().decode(data));
    if (project.format !== Planner.FORMAT) throw new Error(`Unsupported project format ${JSON.stringify(project.format)}`);
    const drawings = (project.drawings || []).map((name) => {
      const b = files.get(name);
      if (!b) throw new Error(`Embedded drawing ${name} is missing`);
      return { name, bytes: b };
    });
    const images = new Map();
    for (const { owner, photo } of Planner.photoRefs(project)) {
      const b = files.get(photo && photo.file);
      if (!b) throw new Error(`${owner}: embedded photo ${photo && photo.file} is missing`);
      images.set(photo.file, b);
    }
    return { project, drawings, images };
  }

  /** Checks that bytes are a PDF we can copy pages from (used when adding a drawing). */
  async function checkDrawing(bytes) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return src.getPageCount();
  }

  return { exportPdf, importPdf, checkDrawing, attachments };
});
