const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const raiz = path.join(__dirname,"..");
const leer = archivo => fs.readFileSync(path.join(raiz,archivo),"utf8");
const db = leer("db.js");
const matricula = leer("routes/matricula.js");
const horarios = leer("routes/horarios.js");
const frontend = leer("public/index.html");

test("convocatoria tiene estado, niveles y auditoría persistentes", () => {
  for(const campo of [
    "convocatoria", "convocatoria_estado", "nivel_solicitado", "nivel_origen",
    "convocatoria_resuelta_por", "convocatoria_resuelta_at"
  ]) assert.match(db,new RegExp(`ADD COLUMN IF NOT EXISTS ${campo}`));
  assert.match(db,/idx_matricula_convocatoria_pendiente/);
  assert.match(matricula,/estado:'?"?pendiente/);
});

test("solo una convocatoria pendiente puede resolverse y usa el nivel correcto", () => {
  assert.match(matricula,/router\.post\("\/convocatoria\/:id\/resolver"/);
  assert.match(matricula,/m\.convocatoria_estado !== "pendiente"/);
  assert.match(matricula,/resultado === "aprobado" \? parseInt\(m\.nivel_solicitado\) : parseInt\(m\.nivel_origen\)/);
  assert.match(matricula,/parseInt\(sr\.rows\[0\]\.nivel\) !== nivelDestino/);
  assert.match(matricula,/conflictosEnSeccion\(estudianteId,anio,seccionId,esActual,client\)/);
  assert.match(matricula,/cupo\.rows\[0\]\.c >= MAX_CUPO/);
  assert.match(matricula,/resolucion_convocatoria/);
});

test("la interfaz mantiene al pendiente sin sección y ofrece resolución exclusiva", () => {
  assert.match(frontend,/id="mat-convocatoria"/);
  assert.match(frontend,/id="modal-resolver-convocatoria"/);
  assert.match(frontend,/e\.convocatoria_estado==='pendiente'/);
  assert.match(frontend,/Sin sección · espera convocatoria/);
  assert.match(frontend,/function confirmarResolverConvocatoria/);
  assert.match(matricula,/Primero registre en febrero si aprobó o reprobó/);
});

test("la carta toma estudiante, sección, guía, directora y horario anual reales", () => {
  assert.match(matricula,/router\.get\("\/carta-horario\/:id\/:anio"/);
  assert.match(matricula,/m\.anio=\$2/);
  assert.match(matricula,/seccion_guia_anio/);
  assert.match(matricula,/director_nombre/);
  assert.match(matricula,/lecciones:obtenerLecciones\(anio\),celdas:cr\.rows/);
  assert.match(frontend,/function imprimirCartaHorarioMatricula/);
  assert.match(frontend,/Carta de bienvenida y horario de clases/);
  assert.match(frontend,/Nota aclaratoria:<\/strong> Durante las primeras semanas/);
  assert.match(frontend,/sidebar-shield/);
  assert.match(frontend,/✉️ Carta y horario/);
});

test("2027 usa las nuevas horas sin alterar el horario 2026", () => {
  assert.match(horarios,/const LECCIONES_2026/);
  assert.match(horarios,/\{ n: 11, ini: "14:55", fin: "15:35" \}/);
  assert.match(horarios,/\{ n: 12, ini: "15:35", fin: "16:15" \}/);
  assert.match(horarios,/LECCIONES_2027\[10\] = \{ n: 11, ini: "15:00", fin: "15:40" \}/);
  assert.match(horarios,/LECCIONES_2027\[11\] = \{ n: 12, ini: "15:40", fin: "16:20" \}/);
  assert.match(horarios,/Number\(anio\) >= 2027 \? LECCIONES_2027 : LECCIONES_2026/);
  assert.match(frontend,/horarios\/lecciones\?anio=\$\{a\}/);
  assert.match(frontend,/inicio:leccion\.fin,fin:siguiente\?\.ini/);
  assert.match(frontend,/hora:`\$\{lec\.fin\} - \$\{siguiente\?\.ini\|\|lec\.fin\}`/);
});
