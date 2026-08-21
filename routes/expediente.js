const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");
const { calcularPromedioEstudianteArchivado } = require("./calificaciones");

const canManage = requireRol("admin","auxiliar");

function promedioTieneDatos(est){
  const rubros=est?.rubros||{};
  if(est?.modo_simplificado) return Object.values(rubros).some(r=>r?.nota_100!==null&&r?.nota_100!==undefined);
  return Object.values(rubros).some(r=>Number(r?.cant_con_nota||0)>0);
}

// ── BUSCAR ESTUDIANTE POR CÉDULA ──────────────────────────────────────────────
router.get("/buscar/:cedula", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre, s.nivel
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.cedula=$1
  `, [req.params.cedula.trim()]);
  if (!r.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
  const est = r.rows[0];

  // Encargados actuales
  const encs = await pool.query(
    "SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC",
    [est.id]
  );

  // Historial de años
  const hist = await pool.query(
    "SELECT * FROM expediente_historico WHERE estudiante_id=$1 ORDER BY anio DESC",
    [est.id]
  );

  // Matrícula registrada
  const mat = await pool.query(
    "SELECT m.*, s.nombre AS sec_nombre, u.nombre AS conf_nombre, u.primer_apellido AS conf_ap1 FROM matricula m LEFT JOIN secciones s ON s.id=m.seccion_id LEFT JOIN usuarios u ON u.id=m.confirmado_por WHERE m.estudiante_id=$1 ORDER BY m.anio DESC",
    [est.id]
  );

  res.json({ estudiante: est, encargados: encs.rows, historial: hist.rows, matriculas: mat.rows });
});

// ── ARCHIVAR AÑO ACTUAL ───────────────────────────────────────────────────────
// Toma una foto de todos los estudiantes activos con su sección y encargados
router.post("/archivar-anio", canManage, async (req, res) => {
  const { anio } = req.body;
  if (!anio) return res.status(400).json({ error: "El año es requerido" });
  const uid = req.session.usuario.id;

  const estudiantes = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre, s.nivel
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.activo=true
  `);

  let archivados = 0, omitidos = 0;
  for (const est of estudiantes.rows) {
    const encs = await pool.query("SELECT * FROM encargados WHERE estudiante_id=$1", [est.id]);
    try {
      await pool.query(`
        INSERT INTO expediente_historico (estudiante_id, anio, seccion_nombre, nivel, encargados_snap, archivado_por)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (estudiante_id, anio) DO UPDATE SET
          seccion_nombre=$3, nivel=$4, encargados_snap=$5, archivado_por=$6
      `, [est.id, anio, est.seccion_nombre||"", est.nivel||null, JSON.stringify(encs.rows), uid]);
      archivados++;
    } catch(e) { omitidos++; }
  }

  res.json({ ok: true, archivados, omitidos, anio });
});

// ── REGISTRAR MATRÍCULA ───────────────────────────────────────────────────────
router.post("/matricula", canManage, async (req, res) => {
  const { estudiante_id, anio, seccion_id, num_boleta, observaciones } = req.body;
  if (!estudiante_id || !anio) return res.status(400).json({ error: "Datos incompletos" });
  const uid = req.session.usuario.id;

  // Obtener nombre de sección
  let secNombre = "";
  if (seccion_id) {
    const s = await pool.query("SELECT nombre FROM secciones WHERE id=$1", [seccion_id]);
    secNombre = s.rows[0]?.nombre || "";
  }

  await pool.query(`
    INSERT INTO matricula (estudiante_id, anio, seccion_id, seccion_nombre, num_boleta, confirmado_por, observaciones)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (estudiante_id, anio) DO UPDATE SET
      seccion_id=$3, seccion_nombre=$4, num_boleta=$5, confirmado_por=$6, observaciones=$7
  `, [estudiante_id, anio, seccion_id||null, secNombre, num_boleta||"", uid, observaciones||""]);

  res.json({ ok: true });
});

// ── APLICAR MATRÍCULAS (pasar sección de matrícula a estudiante) ──────────────
router.post("/aplicar-matriculas", canManage, async (req, res) => {
  const { anio } = req.body;
  if (!anio) return res.status(400).json({ error: "El año es requerido" });

  const mats = await pool.query(
    "SELECT * FROM matricula WHERE anio=$1 AND seccion_id IS NOT NULL", [anio]
  );

  let aplicados = 0;
  for (const m of mats.rows) {
    await pool.query("UPDATE estudiantes SET seccion_id=$1 WHERE id=$2", [m.seccion_id, m.estudiante_id]);
    aplicados++;
  }

  res.json({ ok: true, aplicados });
});

// ── ESTADÍSTICAS DE MATRÍCULA ─────────────────────────────────────────────────
router.get("/matricula/stats/:anio", canManage, async (req, res) => {
  const anio = req.params.anio;
  // Contar estudiantes activos
  const total = await pool.query(
    "SELECT COUNT(*) AS c FROM estudiantes WHERE activo=true AND (archivado=false OR archivado IS NULL)"
  );
  // Solo contar matrículas de estudiantes que SIGUEN activos (evita pendientes negativos)
  const matriculados = await pool.query(`
    SELECT COUNT(*) AS c FROM matricula m
    JOIN estudiantes e ON e.id=m.estudiante_id
    WHERE m.anio=$1 AND e.activo=true AND (e.archivado=false OR e.archivado IS NULL)
  `, [anio]);
  const totalN = parseInt(total.rows[0].c);
  const matN   = parseInt(matriculados.rows[0].c);
  res.json({
    total: totalN,
    matriculados: matN,
    pendientes: Math.max(0, totalN - matN)   // nunca negativo
  });
});

// ── HISTORIAL ACADÉMICO (auxiliares/admin) ──────────────────────────────
// Devuelve las notas archivadas por año/período/materia de un estudiante,
// con totales de asistencia (ausencias, tardías, justificadas).
router.get("/:id/historial-academico", canManage, async (req, res) => {
  const r = await pool.query(`
    SELECT anio, periodo, seccion_nombre, materia_nombre, profesor_nombre,
      nota_cotidiano, nota_tareas, nota_pruebas, nota_proyecto, nota_asistencia,
      nota_total, ausencias, ausencias_just, tardias, conducta_nota
    FROM expediente_academico
    WHERE estudiante_id = $1
    ORDER BY anio DESC, periodo, materia_nombre
  `, [req.params.id]);
  const filas=new Map(r.rows.map(x=>[`${x.anio}|${x.periodo}|${x.materia_nombre}`,x]));

  // Si el retiro ocurrió durante el curso actual, las notas todavía viven en
  // las tablas operativas. Las calculamos incluyendo expresamente al estudiante
  // archivado (su seccion_id ya es NULL) y las mezclamos con el histórico.
  const estR=await pool.query(`
    SELECT e.id,e.subgrupo,e.seccion_archivo,
      COALESCE(e.seccion_id,s_arch.id) AS consulta_seccion_id,
      COALESCE(s_actual.nombre,e.seccion_archivo,s_arch.nombre) AS consulta_seccion_nombre
    FROM estudiantes e
    LEFT JOIN secciones s_actual ON s_actual.id=e.seccion_id
    LEFT JOIN secciones s_arch ON s_arch.nombre=e.seccion_archivo
    WHERE e.id=$1
  `,[req.params.id]);
  if(estR.rows.length&&estR.rows[0].consulta_seccion_id){
    const est=estR.rows[0],anio=await obtenerAnioActivo();
    const bases=await pool.query(`
      SELECT DISTINCT a.profesor_id,a.seccion_id,a.materia_id,a.subgrupo,
        m.nombre AS materia_nombre,s.nombre AS seccion_nombre,
        u.nombre AS prof_nombre,u.primer_apellido AS prof_ap1,u.segundo_apellido AS prof_ap2
      FROM asignaciones a
      JOIN materias m ON m.id=a.materia_id
      JOIN secciones s ON s.id=a.seccion_id
      JOIN usuarios u ON u.id=a.profesor_id
      WHERE a.anio=$1 AND a.seccion_id=$2
        AND (a.subgrupo IS NULL OR a.subgrupo=$3)
      ORDER BY m.nombre,a.profesor_id,a.subgrupo
    `,[anio,est.consulta_seccion_id,est.subgrupo||null]);
    for(const a of bases.rows){
      for(const periodo of ["I Período","II Período"]){
        try{
          const data=await calcularPromedioEstudianteArchivado(
            a.profesor_id,a.seccion_id,a.materia_id,a.subgrupo,periodo,req.params.id
          );
          const nota=data?.estudiantes?.find(x=>Number(x.estudiante_id)===Number(req.params.id));
          if(!nota||!promedioTieneDatos(nota)) continue;
          const rb=nota.rubros||{};
          const fila={
            anio,periodo,seccion_nombre:a.seccion_nombre,materia_nombre:a.materia_nombre,
            profesor_nombre:[a.prof_nombre,a.prof_ap1,a.prof_ap2].filter(Boolean).join(" "),
            nota_cotidiano:rb.cotidiano?.nota_100??null,
            nota_tareas:rb.tarea?.nota_100??null,
            nota_pruebas:rb.examen?.nota_100??null,
            nota_proyecto:rb.proyecto?.nota_100??null,
            nota_asistencia:nota.asistencia?.puntos_mep??nota.asistencia?.pct??null,
            nota_total:nota.total??null,
            ausencias:nota.asistencia?.lecciones_ausentes_injust||0,
            ausencias_just:0,tardias:0,conducta_nota:null
          };
          filas.set(`${anio}|${periodo}|${a.materia_nombre}`,fila);
        }catch(error){
          console.warn(`Consulta académica archivada ${req.params.id}, ${a.materia_nombre}, ${periodo}:`,error.message);
        }
      }
    }
  }
  // Agrupar por año → período → materias
  const porAnio = {};
  [...filas.values()].sort((a,b)=>Number(b.anio)-Number(a.anio)||String(a.periodo).localeCompare(String(b.periodo))||String(a.materia_nombre).localeCompare(String(b.materia_nombre))).forEach(row => {
    if(!porAnio[row.anio]) porAnio[row.anio] = { I: [], II: [], seccion: row.seccion_nombre };
    const p = row.periodo === "I Período" ? "I" : "II";
    porAnio[row.anio][p].push(row);
  });
  res.json({ estudiante_id: parseInt(req.params.id), historial: porAnio });
});

// Conducta detallada por año y período. Une las boletas aún operativas con el
// retrato histórico conservado antes del cierre anual. Para años anteriores
// donde solo existe el resumen legado, muestra la nota sin inventar boletas.
router.get("/:id/conducta-desglosada", canManage, async (req,res)=>{
  const [hist,actual,resumen]=await Promise.all([
    pool.query(`SELECT boleta_origen_id,anio,periodo,fecha::text,infraccion_tipo,puntos,
      infraccion_descripcion,observacion,materia_nombre,responsable_nombre,registrado_por_nombre
      FROM expediente_conducta_detalle WHERE estudiante_id=$1 ORDER BY fecha DESC,id DESC`,[req.params.id]),
    pool.query(`SELECT b.id AS boleta_origen_id,EXTRACT(YEAR FROM b.fecha)::int AS anio,
      CASE
        WHEN al.periodo_i_inicio IS NOT NULL AND b.fecha BETWEEN al.periodo_i_inicio AND al.periodo_i_fin THEN 'I Período'
        WHEN al.periodo_ii_inicio IS NOT NULL AND b.fecha BETWEEN al.periodo_ii_inicio AND al.periodo_ii_fin THEN 'II Período'
        WHEN EXTRACT(MONTH FROM b.fecha)::int<=7 THEN 'I Período' ELSE 'II Período'
      END AS periodo,b.fecha::text,i.tipo AS infraccion_tipo,i.puntos,
      i.descripcion AS infraccion_descripcion,b.observacion,m.nombre AS materia_nombre,
      NULLIF(TRIM(CONCAT_WS(' ',COALESCE(u.nombre,ap.nombre),COALESCE(u.primer_apellido,ap.primer_apellido),COALESCE(u.segundo_apellido,ap.segundo_apellido))), '') AS responsable_nombre,
      NULLIF(TRIM(CONCAT_WS(' ',reg.nombre,reg.primer_apellido,reg.segundo_apellido)), '') AS registrado_por_nombre
      FROM boletas_conducta b
      JOIN infracciones i ON i.id=b.infraccion_id
      LEFT JOIN asignaciones a ON a.id=b.asignacion_id
      LEFT JOIN materias m ON m.id=a.materia_id
      LEFT JOIN usuarios u ON u.id=a.profesor_id
      LEFT JOIN usuarios ap ON ap.id=b.usuario_apoyo_id
      LEFT JOIN usuarios reg ON reg.id=b.registrado_por
      LEFT JOIN anios_lectivos al ON al.anio=EXTRACT(YEAR FROM b.fecha)::int
      WHERE b.estudiante_id=$1 ORDER BY b.fecha DESC,b.id DESC`,[req.params.id]),
    pool.query(`SELECT anio,periodo,conducta_nota,nota_total FROM expediente_academico
      WHERE estudiante_id=$1 AND materia_nombre='Conducta' ORDER BY anio DESC,periodo`,[req.params.id])
  ]);
  const boletas=new Map();
  hist.rows.forEach(x=>boletas.set(Number(x.boleta_origen_id),x));
  actual.rows.forEach(x=>boletas.set(Number(x.boleta_origen_id),x));
  const historial={};
  const grupo=(anio,periodo)=>{
    if(!historial[anio]) historial[anio]={};
    const clave=periodo==="I Período"?"I":"II";
    if(!historial[anio][clave]) historial[anio][clave]={periodo,boletas:[],total_rebajado:0,nota:100,solo_resumen:false};
    return historial[anio][clave];
  };
  [...boletas.values()].sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha))).forEach(b=>{
    const g=grupo(b.anio,b.periodo);g.boletas.push(b);g.total_rebajado+=Number(b.puntos||0);g.nota=Math.max(0,100-g.total_rebajado);
  });
  resumen.rows.forEach(x=>{
    const g=grupo(x.anio,x.periodo);
    if(!g.boletas.length){g.nota=Number(x.conducta_nota??x.nota_total??100);g.solo_resumen=true;}
  });
  res.json({estudiante_id:Number(req.params.id),historial});
});

module.exports = router;
