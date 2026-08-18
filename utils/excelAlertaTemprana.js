const fs = require("fs/promises");
const path = require("path");
const JSZip = require("jszip");

const RUTA_PLANTILLA = path.join(__dirname, "..", "public", "assets", "alerta-temprana-mep.xlsx");

function escaparRegex(valor) {
  return String(valor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escaparXml(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rutaHoja(workbookXml, relacionesXml, nombreHoja) {
  const hoja = new RegExp(`<sheet\\b[^>]*\\bname="${escaparRegex(nombreHoja)}"[^>]*\\br:id="([^"]+)"[^>]*/?>`).exec(workbookXml);
  if (!hoja) throw new Error(`La plantilla oficial no contiene la hoja ${nombreHoja}.`);
  const relacion = new RegExp(`<Relationship\\b[^>]*\\bId="${escaparRegex(hoja[1])}"[^>]*\\bTarget="([^"]+)"[^>]*/?>`).exec(relacionesXml);
  if (!relacion) throw new Error(`No se encontró la relación interna de la hoja ${nombreHoja}.`);
  const destino = relacion[1].replace(/\\/g, "/").replace(/^\//, "");
  return destino.startsWith("xl/") ? destino : `xl/${destino}`;
}

function escribirCelda(xml, referencia, valor) {
  const ref = escaparRegex(referencia);
  // Primero se buscan las celdas autocerradas. Si se intentara antes el
  // patrón de celda abierta, podría abarcar accidentalmente celdas vecinas.
  const patron = new RegExp(`<c\\b(?=[^>]*\\br="${ref}")([^>]*?)\\/>|<c\\b(?=[^>]*\\br="${ref}")([^>]*?)>([\\s\\S]*?)<\\/c>`);
  const encontrada = patron.exec(xml);
  if (!encontrada) throw new Error(`La celda ${referencia} no existe en la plantilla oficial.`);
  const atributos = String(encontrada[1] || encontrada[2] || "").replace(/\\s+t="[^"]*"/g, "");
  const contenido = escaparXml(valor);
  const celda = `<c${atributos} t="inlineStr"><is><t xml:space="preserve">${contenido}</t></is></c>`;
  return xml.replace(patron, celda);
}

async function llenarPlantillaAlerta(celdasPorHoja) {
  const original = await fs.readFile(RUTA_PLANTILLA);
  const zip = await JSZip.loadAsync(original);
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const relacionesXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");

  for (const [nombreHoja, celdas] of Object.entries(celdasPorHoja)) {
    const ruta = rutaHoja(workbookXml, relacionesXml, nombreHoja);
    const archivo = zip.file(ruta);
    if (!archivo) throw new Error(`No se encontró el archivo interno de la hoja ${nombreHoja}.`);
    let xml = await archivo.async("string");
    for (const [referencia, valor] of Object.entries(celdas)) xml = escribirCelda(xml, referencia, valor);
    zip.file(ruta, xml, { createFolders: false });
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

module.exports = { RUTA_PLANTILLA, llenarPlantillaAlerta };
