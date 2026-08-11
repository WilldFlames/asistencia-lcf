const webpush = require("web-push");
const { pool } = require("../db");

const clavePublica = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const clavePrivada = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const contactoVapid = String(process.env.VAPID_SUBJECT || "https://www.liccallefallas.com").trim();
let errorConfiguracion = "";

if (clavePublica && clavePrivada) {
  try {
    webpush.setVapidDetails(contactoVapid, clavePublica, clavePrivada);
  } catch (error) {
    errorConfiguracion = error.message;
    console.error("Web Push de familias no pudo configurarse:", error.message);
  }
}

function estaConfigurado() {
  return Boolean(clavePublica && clavePrivada && !errorConfiguracion);
}

function estadoConfiguracion() {
  return {
    configurada: estaConfigurado(),
    publicKey: estaConfigurado() ? clavePublica : "",
  };
}

function payloadVisible(datos = {}) {
  return JSON.stringify({
    title: String(datos.title || "Liceo de Calle Fallas").slice(0, 120),
    body: String(datos.body || "Tiene una nueva notificación institucional.").slice(0, 500),
    url: String(datos.url || "/?app=familias").slice(0, 500),
    tag: String(datos.tag || `lcf-${Date.now()}`).slice(0, 120),
    urgency: datos.urgency === "high" ? "high" : "normal",
    requireInteraction: datos.requireInteraction === true,
  });
}

async function enviarFilas(filas, datos) {
  if (!estaConfigurado() || !filas?.length) return { enviadas: 0, eliminadas: 0 };
  const mensaje = payloadVisible(datos);
  let enviadas = 0;
  let eliminadas = 0;

  await Promise.allSettled(filas.map(async fila => {
    const suscripcion = {
      endpoint: fila.endpoint,
      keys: { p256dh: fila.p256dh, auth: fila.auth },
    };
    try {
      await webpush.sendNotification(suscripcion, mensaje, {
        TTL: datos?.urgency === "high" ? 60 * 60 : 24 * 60 * 60,
        urgency: datos?.urgency === "high" ? "high" : "normal",
      });
      enviadas += 1;
      await pool.query(
        "UPDATE push_suscripciones SET last_success_at=NOW(), updated_at=NOW() WHERE endpoint=$1",
        [fila.endpoint]
      ).catch(() => {});
    } catch (error) {
      if ([404, 410].includes(Number(error.statusCode))) {
        eliminadas += 1;
        await pool.query("DELETE FROM push_suscripciones WHERE endpoint=$1", [fila.endpoint]).catch(() => {});
      } else {
        console.error("Web Push familias:", error.statusCode || "error", error.message);
      }
    }
  }));

  return { enviadas, eliminadas };
}

async function suscripcionesPorEstudiante(estudianteId) {
  const r = await pool.query(`
    SELECT DISTINCT ps.endpoint, ps.p256dh, ps.auth
    FROM push_suscripciones ps
    JOIN padres_acceso pa ON pa.id=ps.padre_acceso_id AND pa.activo=true
    WHERE EXISTS (
      SELECT 1 FROM encargados enc
      WHERE enc.estudiante_id=$1
        AND COALESCE(enc.es_principal,false)=true
        AND regexp_replace(upper(COALESCE(enc.cedula,'')),'[^0-9A-Z]','','g')
          = regexp_replace(upper(pa.cedula),'[^0-9A-Z]','','g')
    )
  `, [Number(estudianteId)]);
  return r.rows;
}

async function suscripcionesPorCedula(cedula) {
  const limpia = String(cedula || "").replace(/[\s\-.\/\\]/g, "");
  const r = await pool.query(`
    SELECT DISTINCT ps.endpoint, ps.p256dh, ps.auth
    FROM push_suscripciones ps
    JOIN padres_acceso pa ON pa.id=ps.padre_acceso_id AND pa.activo=true
    WHERE regexp_replace(upper(pa.cedula),'[^0-9A-Z]','','g')=$1
  `, [limpia.toUpperCase()]);
  return r.rows;
}

async function suscripcionesPorSecciones(secciones = null) {
  const ids = Array.isArray(secciones) && secciones.length ? secciones.map(Number).filter(Boolean) : null;
  const r = await pool.query(`
    SELECT DISTINCT ps.endpoint, ps.p256dh, ps.auth
    FROM push_suscripciones ps
    JOIN padres_acceso pa ON pa.id=ps.padre_acceso_id AND pa.activo=true
    JOIN encargados enc
      ON regexp_replace(upper(COALESCE(enc.cedula,'')),'[^0-9A-Z]','','g')
       = regexp_replace(upper(pa.cedula),'[^0-9A-Z]','','g')
    JOIN estudiantes e ON e.id=enc.estudiante_id
    WHERE COALESCE(enc.es_principal,false)=true
      AND e.activo=true AND COALESCE(e.archivado,false)=false
      AND ($1::int[] IS NULL OR e.seccion_id=ANY($1::int[]))
  `, [ids]);
  return r.rows;
}

async function nombreCortoEstudiante(estudianteId) {
  const r = await pool.query(
    "SELECT nombre, primer_apellido FROM estudiantes WHERE id=$1",
    [Number(estudianteId)]
  );
  if (!r.rows.length) return "el estudiante";
  return [r.rows[0].nombre, r.rows[0].primer_apellido].filter(Boolean).join(" ").trim() || "el estudiante";
}

async function notificarEstudiante(estudianteId, datos = {}) {
  try {
    const nombre = await nombreCortoEstudiante(estudianteId);
    const preparado = {
      ...datos,
      body: String(datos.body || "Tiene una nueva notificación sobre {estudiante}.")
        .replaceAll("{estudiante}", nombre),
    };
    return await enviarFilas(await suscripcionesPorEstudiante(estudianteId), preparado);
  } catch (error) {
    console.error("Notificación familiar de estudiante:", error.message);
    return { enviadas: 0, eliminadas: 0 };
  }
}

async function notificarCedula(cedula, datos = {}) {
  try {
    return await enviarFilas(await suscripcionesPorCedula(cedula), datos);
  } catch (error) {
    console.error("Notificación familiar por cédula:", error.message);
    return { enviadas: 0, eliminadas: 0 };
  }
}

async function notificarSecciones(secciones, datos = {}) {
  try {
    return await enviarFilas(await suscripcionesPorSecciones(secciones), datos);
  } catch (error) {
    console.error("Notificación familiar de anuncio/sección:", error.message);
    return { enviadas: 0, eliminadas: 0 };
  }
}

module.exports = {
  estadoConfiguracion,
  estaConfigurado,
  notificarEstudiante,
  notificarCedula,
  notificarSecciones,
};
