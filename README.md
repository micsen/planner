<img src="assets/icon.svg" width="64" height="64" alt="">

# Project planner

**Open the editor: https://micsen.github.io/planner/**

A small browser tool for planning installation jobs, such as replacing an access control system. It lists what goes where, what is connected to what, what has to be done, and what it costs. **The project file is a PDF**: a readable report with all the project data embedded, so the same file can be sent to a customer and opened again in the editor.

Everything runs in your browser. Projects, photos and drawings are never uploaded anywhere.

## The model

- **Catalog:** the items you can use. Each has a name, description and price: either a fixed unit price, or cost + markup (0.25 = 25 % margin).
- **Structure:** a tree of **places** and **items** that shows where things are.
  - A place has a free-text type (Site, Building, Floor, Room, Door, …), a name and a description.
  - An item is a catalog entry with a quantity and an optional name/tag (e.g. `R1-B1`).
  - Anything can sit inside anything, e.g. Floor → Door, or Room → Controller → I/O board.
  - Every node can have a **job description**, **comments** and **photos**.
- **Connections:** loose links between any two nodes, separate from the tree, each with a note. For example, a board links to the doors it drives with the note `R1-R2, I1-I2`.

The report contains:
- totals per item and a price for each top-level place, with MVA/VAT on top;
- every top-level place's subtree with its notes and photos. Connections are shown on both ends as clickable links that jump to the other node.

## Using the editor

1. Open https://micsen.github.io/planner/, or `editor/index.html` from a local copy. It also works offline.
2. Click **Open PDF…**, or drag a project PDF onto the page. Use **New** to start a new project.
3. Edit the tabs:
   - **Structure:** the tree on the left and the selected node on the right.
     - Edit the node's fields, job description, comments, photos and connections.
     - Add places or items inside it, or paste a list of names to add several places at once.
     - **Drag and drop** rows. Drop on the top edge of a row to put the node before it, the middle to put it inside, and the bottom edge to put it after.
     - Hold **Alt** or **Shift** while dropping to **connect** the two nodes instead of moving one.
   - **Catalog:** the items and their prices.
   - **Project:** name, description and pricing.
   - **Drawings:** the drawing PDFs, appended to the report as pages.
   - **Preview:** the live report.
4. Click **Export PDF**. Export is blocked while the error box lists problems. The exported PDF is the project file.

**Photos:** the editor rotates each photo to the correct orientation, scales it down to at most 1600 px and saves it as JPEG. This also removes location data.

**Autosave:** the working project is saved in the browser (IndexedDB) after every change, so a reload or a closed tab brings it back. It holds one project per browser and site, and clearing browser data deletes it. The exported PDF is the copy to keep and share.

## File format

A project PDF contains the report pages, the drawings as the last pages, and these attachments:

| Attachment | What |
|---|---|
| `project.json` | All project data (format `project-planner/2`). This is what the editor reads back. |
| drawing PDFs | The original drawings, byte for byte |
| photos | JPEG/PNG, as referenced by the nodes |
| `bom.csv`, `structure.csv` | Generated tables for spreadsheets |

Most PDF viewers show the attachments in a paperclip or attachments panel.

## Command line and tests (Node.js)

The editor and the CLI share the same code: `editor/planner.js` (model, validation, pricing, report content) and `editor/pdf.js` (PDF export/import). [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 is vendored in `editor/vendor/` under the MIT license. There's no build step and nothing to install.

```sh
node tools/cli.js summary project.pdf          # place counts, items, totals
node tools/cli.js extract project.pdf out/     # write all attachments to out/
node tools/cli.js build out/ project.pdf       # build a PDF from out/project.json + drawings + photos
node tools/test.js                             # model + PDF round-trip tests (made-up demo data)
```

## Deployment

On every push to `main`, [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and publishes the `editor/` folder to GitHub Pages. Nothing else in the repository is published.

`projects/` and `drawings/` are gitignored, so real customer projects can stay in a local checkout without being pushed.
