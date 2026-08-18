const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const { RUTA_PLANTILLA, llenarPlantillaAlerta } = require("../utils/excelAlertaTemprana");

const root = path.join(__dirname, "..");

test("la descarga parte de la plantilla oficial completa de cinco hojas", async () => {
  const original = await JSZip.loadAsync(fs.readFileSync(RUTA_PLANTILLA));
  const workbook = await original.file("xl/workbook.xml").async("string");
  assert.match(workbook, /name="1\.GUÍA"/);
  assert.match(workbook, /name="PREGUNTAS FRECUENTES"/);
  assert.match(workbook, /name="2\.BOLETA_III_CICLO_Y_EDUC__DIV_"/);
  assert.match(workbook, /name="3\.BOLETA_DE_SEGUIMIENTO"/);
  assert.match(workbook, /name="4\.PLAN_DE_ATENCIÓN"/);
  assert.ok(original.file("xl/worksheets/sheet5.xml"));
  assert.ok(original.file("xl/media/image5.png"));
});

test("el llenado conserva todas las piezas, imágenes y configuración oficial", async () => {
  const original = await JSZip.loadAsync(fs.readFileSync(RUTA_PLANTILLA));
  const generado = await JSZip.loadAsync(await llenarPlantillaAlerta({
    "2.BOLETA_III_CICLO_Y_EDUC__DIV_": { C2: "ESTUDIANTE DE PRUEBA", H2: "123456789" },
    "3.BOLETA_DE_SEGUIMIENTO": { B17: "17/08/2026 · Activada: Seguimiento de prueba" },
    "4.PLAN_DE_ATENCIÓN": { D4: "ESTUDIANTE DE PRUEBA", B18: "INSTITUCIÓN DE PRUEBA" },
  }));
  assert.deepEqual(Object.keys(generado.files).sort(), Object.keys(original.files).sort());
  for (const nombre of [
    "xl/drawings/drawing1.xml","xl/drawings/drawing2.xml","xl/drawings/drawing3.xml",
    "xl/drawings/drawing4.xml","xl/drawings/drawing5.xml","xl/printerSettings/printerSettings1.bin",
  ]) {
    assert.ok(generado.file(nombre), `Debe conservar ${nombre}`);
  }
  const hojas = await Promise.all([3,4,5].map(n => generado.file(`xl/worksheets/sheet${n}.xml`).async("string")));
  assert.ok(hojas.some(xml => xml.includes("ESTUDIANTE DE PRUEBA")));
  assert.ok(hojas.some(xml => xml.includes("Seguimiento de prueba")));
  assert.ok(hojas.some(xml => xml.includes("INSTITUCIÓN DE PRUEBA")));
});

test("los datos superiores se escriben en las celdas visibles de la boleta oficial", () => {
  const ruta = fs.readFileSync(path.join(root, "routes", "alertaTemprana.js"), "utf8");
  assert.match(ruta, /E2:a\.estudiante_nombre,J2:a\.cedula,L2:a\.encargado_telefono/);
  assert.match(ruta, /E3:a\.edad\?\?"",J3:a\.seccion_nombre/);
  assert.match(ruta, /E4:a\.encargado_nombre/);
  assert.match(ruta, /K4:a\.encargado_telefono/);
  assert.match(ruta, /E5:cfg\.rows\[0\]\?\.nombre_centro/);
  assert.match(ruta, /K5:a\.profesor_nombre/);
  assert.doesNotMatch(ruta, /C2:a\.estudiante_nombre|H2:a\.cedula|C3:a\.edad|H3:a\.seccion_nombre|C5:cfg|H5:a\.profesor_nombre/);
});

test("la interfaz descarga el Excel generado en el servidor sin reconstruirlo con SheetJS", () => {
  const ui = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const inicio = ui.indexOf("async function atDescargarExcel()");
  const fin = ui.indexOf("\n}\n</script>", inicio);
  const funcion = ui.slice(inicio, fin + 2);
  assert.match(funcion, /\/api\/alerta-temprana\/alertas\/\$\{a\.id\}\/excel/);
  assert.doesNotMatch(funcion, /XLSX\.writeFile/);
  assert.match(funcion, /URL\.createObjectURL/);
});
