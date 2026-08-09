const { pool } = require("../db");

function fechaCR() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function anioCalendarioCR() {
  return Number(fechaCR().slice(0, 4));
}

async function obtenerAnioActivo(db = pool) {
  try {
    const r = await db.query(
      "SELECT anio FROM anios_lectivos WHERE estado='activo' ORDER BY anio DESC LIMIT 1"
    );
    if (r.rows.length) return Number(r.rows[0].anio);
  } catch (_) {
    // Compatibilidad durante el primer arranque, antes de terminar migraciones.
  }
  return anioCalendarioCR();
}

async function obtenerCalendario(anio, db = pool) {
  const a = Number(anio) || await obtenerAnioActivo(db);
  try {
    const r = await db.query(
      `SELECT anio, estado,
        periodo_i_inicio::text, periodo_i_fin::text,
        periodo_ii_inicio::text, periodo_ii_fin::text,
        aplicado_at, aplicado_por
       FROM anios_lectivos WHERE anio=$1`,
      [a]
    );
    if (r.rows.length) return r.rows[0];
  } catch (_) {}
  return { anio: a, estado: "preparacion" };
}

async function obtenerPeriodoActual(db = pool, fecha = fechaCR()) {
  const anio = await obtenerAnioActivo(db);
  const cal = await obtenerCalendario(anio, db);
  const i = cal.periodo_i_inicio && cal.periodo_i_fin
    ? { nombre: "I Período", desde: cal.periodo_i_inicio, hasta: cal.periodo_i_fin }
    : null;
  const ii = cal.periodo_ii_inicio && cal.periodo_ii_fin
    ? { nombre: "II Período", desde: cal.periodo_ii_inicio, hasta: cal.periodo_ii_fin }
    : null;

  if (i && fecha <= i.hasta) return { ...i, anio };
  if (ii && fecha >= ii.desde) return { ...ii, anio };
  // En vacaciones de medio año se conserva el I Período hasta que inicie el II.
  if (i) return { ...i, anio };
  if (ii) return { ...ii, anio };

  // Solo como respaldo para bases que todavía no hayan configurado calendario.
  return {
    nombre: "I Período",
    desde: `${anio}-01-01`,
    hasta: `${anio}-06-30`,
    anio,
    sin_configurar: true,
  };
}

async function obtenerRangoPeriodo(periodo, db = pool, anio = null) {
  const a = Number(anio) || await obtenerAnioActivo(db);
  const cal = await obtenerCalendario(a, db);
  if (periodo === "II Período") {
    return {
      nombre: periodo,
      desde: cal.periodo_ii_inicio || `${a}-07-01`,
      hasta: cal.periodo_ii_fin || `${a}-12-31`,
      anio: a,
      sin_configurar: !cal.periodo_ii_inicio || !cal.periodo_ii_fin,
    };
  }
  return {
    nombre: "I Período",
    desde: cal.periodo_i_inicio || `${a}-01-01`,
    hasta: cal.periodo_i_fin || `${a}-06-30`,
    anio: a,
    sin_configurar: !cal.periodo_i_inicio || !cal.periodo_i_fin,
  };
}

module.exports = {
  fechaCR,
  anioCalendarioCR,
  obtenerAnioActivo,
  obtenerCalendario,
  obtenerPeriodoActual,
  obtenerRangoPeriodo,
};
