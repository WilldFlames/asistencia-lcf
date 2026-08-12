const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const raiz = path.join(__dirname, "..");
const leer = archivo => fs.readFileSync(path.join(raiz, archivo), "utf8");
const db = leer("db.js");
const padres = leer("routes/padres.js");
const push = leer("utils/push-familias.js");
const sw = leer("public/sw.js");
const pwa = leer("public/pwa.js");
const html = leer("public/index.html");
const conducta = leer("routes/conducta.js");
const estudiantes = leer("routes/estudiantes.js");
const asistencia = leer("routes/asistencia.js");
const anuncios = leer("routes/anuncios.js");
const porteria = leer("routes/porteria.js");
const citas = leer("routes/citas.js");

test("cada dispositivo familiar conserva una suscripción vinculada a su cuenta", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS push_suscripciones/);
  assert.match(db, /padre_acceso_id\s+INTEGER NOT NULL REFERENCES padres_acceso\(id\) ON DELETE CASCADE/);
  assert.match(db, /endpoint\s+TEXT UNIQUE NOT NULL/);
  assert.match(padres, /router\.post\("\/push\/suscribir", requirePadre/);
  assert.match(padres, /endpointUrl\.protocol!=="https:"/);
  assert.match(padres, /ON CONFLICT\(endpoint\) DO UPDATE SET\s+padre_acceso_id=EXCLUDED\.padre_acceso_id/);
});

test("las notificaciones se limitan al encargado del estudiante o de la sección", () => {
  assert.match(push, /enc\.estudiante_id=\$1/);
  assert.match(push, /e\.seccion_id=ANY\(\$1::int\[\]\)/);
  assert.match(push, /regexp_replace\(upper\(COALESCE\(enc\.cedula/);
  assert.match(push, /\[404, 410\][\s\S]*DELETE FROM push_suscripciones/);
});

test("la PWA pide permiso por acción del encargado y abre la sección correcta", () => {
  assert.match(html, /id="pp-push-action"[\s\S]*onclick="LCFPWA\.alternarNotificaciones\(\)"/);
  assert.match(pwa, /async function alternarNotificaciones\(\)[\s\S]*Notification\.requestPermission\(\)/);
  assert.match(pwa, /userVisibleOnly:\s*true/);
  assert.match(pwa, /esIOS\(\) && !instalada\(\)/);
  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /showNotification\(titulo, opciones\)/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  assert.match(sw, /ventana\.navigate\(destino\)/);
});

test("boletas, escapes, anuncios, citas y permisos disparan avisos familiares", () => {
  assert.match(conducta, /title:\s*"Nueva boleta de conducta"/);
  assert.match(asistencia, /tag:\s*`boleta-ausencia-/);
  assert.match(estudiantes, /title:\s*"⚠️ Alerta de escape de lección"/);
  assert.match(anuncios, /notificarSecciones\(todos \? null : secciones/);
  assert.match(porteria, /tag:`permiso-salida-/);
  assert.match(citas, /title:"📅 Nueva solicitud de cita"/);
  assert.match(citas, /title:"Respuesta a solicitud de cita"/);
});

test("las claves privadas de Web Push solo se leen de Railway", () => {
  const env = leer(".env.example");
  assert.match(push, /process\.env\.VAPID_PRIVATE_KEY/);
  assert.match(env, /VAPID_PUBLIC_KEY=\r?\nVAPID_PRIVATE_KEY=\r?\n/);
  assert.doesNotMatch(push, /VAPID_PRIVATE_KEY\s*=\s*[A-Za-z0-9_-]{20,}/);
});
