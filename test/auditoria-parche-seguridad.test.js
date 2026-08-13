const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const leer=f=>fs.readFileSync(path.join(__dirname,"..",f),"utf8");

test("el cierre anual no borra datos si falla cualquier archivo",()=>{
  const src=leer("routes/matricula.js");
  const control=src.indexOf("if(erroresArchivo.length)");
  const borrado=src.indexOf("DELETE FROM boletas_conducta",control);
  assert.ok(control>0 && borrado>control);
  assert.match(src,/No se borró ningún dato/);
  assert.match(src,/res\.status\(e\.status \|\| 500\)/);
});

test("asistencia y calificaciones exigen propietario o administrador",()=>{
  const asistencia=leer("routes/asistencia.js");
  const calificaciones=leer("routes/calificaciones.js");
  assert.match(asistencia,/permitirAsignacion/);
  assert.match(asistencia,/Solo el docente asignado/);
  assert.match(asistencia,/no pertenece a esta asignación/);
  assert.doesNotMatch(calificaciones,/const esStaff = \["admin","administrativo","auxiliar"\]/);
  assert.match(calificaciones,/Solo el profesor a cargo/);
  assert.match(calificaciones,/u\.rol !== "admin"/);
});

test("los expedientes docentes se limitan a sus secciones",()=>{
  const helper=leer("utils/acceso-estudiantes.js");
  assert.match(helper,/SELECT seccion_id FROM asignaciones/);
  assert.match(helper,/seccion_guia/);
  assert.match(helper,/seccion_orientador/);
  for(const ruta of ["routes/encargados.js","routes/reportes.js","routes/observaciones.js"])
    assert.match(leer(ruta),/exigirAccesoEstudiante/);
});

test("Personal LCF se anuncia en teléfono y se oculta en computadora",()=>{
  assert.match(leer("public/pwa.js"),/max-width: 900px.*pointer: coarse/);
  assert.match(leer("public/pwa.js"),/if \(!modoPersonal && !esTelefono\)/);
  assert.match(leer("public/pwa.css"),/min-width:901px.*pointer:fine/);
});

test("los cambios de permisos revocan sesiones y las notificaciones escapan HTML",()=>{
  const admin=leer("routes/admin.js");
  const auth=leer("routes/auth.js");
  assert.match(admin,/DELETE FROM "session"/);
  assert.match(auth,/COALESCE\(eliminado,false\)=false/);
  assert.match(leer("public/index.html"),/htmlSeguro\(n\.mensaje\|\|""\)/);
});
