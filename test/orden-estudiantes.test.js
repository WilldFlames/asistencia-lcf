const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const raiz = path.join(__dirname, "..");
const leer = archivo => fs.readFileSync(path.join(raiz, archivo), "utf8");
const frontend = leer("public/index.html");

test("el comparador institucional ordena primer apellido, segundo apellido y nombre", () => {
  const inicio = frontend.indexOf("const _collatorEstudiantes");
  const fin = frontend.indexOf("function htmlSeguro", inicio);
  assert.ok(inicio >= 0 && fin > inicio, "No se encontró el comparador institucional");

  const contexto = { Intl, resultado: null };
  const datos = [
    { id: 1, primer_apellido: "Mora", segundo_apellido: "Zúñiga", nombre: "Ana", cedula: "1" },
    { id: 2, primer_apellido: "Álvarez", segundo_apellido: "Rojas", nombre: "Luis", cedula: "2" },
    { id: 3, primer_apellido: "Mora", segundo_apellido: "Alfaro", nombre: "Zoe", cedula: "3" },
    { id: 4, primer_apellido: "Mora", segundo_apellido: "Alfaro", nombre: "Carlos", cedula: "4" },
  ];
  vm.runInNewContext(
    `${frontend.slice(inicio, fin)}\nresultado=ordenarEstudiantes(${JSON.stringify(datos)}).map(x=>x.id);`,
    contexto
  );
  assert.deepEqual(Array.from(contexto.resultado), [2, 4, 3, 1]);
});

test("las listas principales consultan los tres componentes del orden alfabético", () => {
  const archivos = [
    "routes/admin.js",
    "routes/estudiantes.js",
    "routes/matricula.js",
    "routes/padres.js",
    "routes/comedor.js",
    "routes/medidas.js",
    "routes/calificaciones.js",
  ];
  for (const archivo of archivos) {
    const fuente = leer(archivo);
    assert.doesNotMatch(
      fuente,
      /ORDER BY\s+e\.primer_apellido\s*,\s*e\.nombre/i,
      `${archivo} todavía omite el segundo apellido`
    );
  }

  assert.match(
    leer("routes/prematricula.js"),
    /ORDER BY p\.primer_apellido, p\.segundo_apellido, p\.nombre/
  );
  assert.match(
    leer("routes/asistencia.js"),
    /ORDER BY sub\.primer_apellido, sub\.segundo_apellido, sub\.nombre/
  );
  assert.match(
    leer("routes/reportes.js"),
    /ORDER BY primer_apellido,segundo_apellido,nombre/
  );
  assert.match(
    leer("routes/debidosProcesos.js"),
    /ORDER BY e\.primer_apellido, e\.segundo_apellido, e\.nombre/
  );
  assert.match(
    leer("routes/protocolos.js"),
    /e\.primer_apellido, e\.segundo_apellido, e\.nombre, pp\.id/
  );
});

test("las pantallas que vuelven a formar listas conservan el mismo orden", () => {
  assert.match(frontend, /const rows=ordenarEstudiantes\(respuesta\)/);
  assert.match(frontend, /matData = ordenarEstudiantes\(data\)/);
  assert.match(frontend, /registrosAsist=ordenarEstudiantes\(d\.estudiantes\)/);
  assert.match(frontend, /prematData = ordenarEstudiantes\(await api\("\/api\/prematricula"\)\)/);
  assert.match(frontend, /citasEstudiantes=ordenarEstudiantes/);
  assert.match(frontend, /archivoData=ordenarEstudiantes/);
});
