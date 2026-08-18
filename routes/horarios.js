const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

// ── HORAS OFICIALES DE LECCIÓN POR CURSO LECTIVO ─────────────────────────
// En 2027 cambian las dos últimas lecciones. Se conservan ambos catálogos para
// que consultar o imprimir 2026 nunca muestre las horas nuevas por accidente.
const LECCIONES_2026 = [
  { n: 1,  ini: "07:00", fin: "07:40" },
  { n: 2,  ini: "07:40", fin: "08:20" },
  { n: 3,  ini: "08:35", fin: "09:15" },
  { n: 4,  ini: "09:15", fin: "09:55" },
  { n: 5,  ini: "10:00", fin: "10:40" },
  { n: 6,  ini: "10:40", fin: "11:20" },
  { n: 7,  ini: "12:00", fin: "12:40" },
  { n: 8,  ini: "12:40", fin: "13:20" },
  { n: 9,  ini: "13:30", fin: "14:10" },
  { n: 10, ini: "14:10", fin: "14:50" },
  { n: 11, ini: "14:55", fin: "15:35" },
  { n: 12, ini: "15:35", fin: "16:15" },
];

const LECCIONES_2027 = LECCIONES_2026.map(l => ({...l}));
LECCIONES_2027[10] = { n: 11, ini: "15:00", fin: "15:40" };
LECCIONES_2027[11] = { n: 12, ini: "15:40", fin: "16:20" };

function obtenerLecciones(anio){
  return Number(anio) >= 2027 ? LECCIONES_2027 : LECCIONES_2026;
}

function enteroRango(valor,min,max){
  const n=Number(valor);
  return Number.isInteger(n)&&n>=min&&n<=max?n:null;
}

function resumenDocente(celdas,bloques){
  const lecciones=new Set(celdas.map(c=>`${c.dia}-${c.leccion}`)).size;
  const club=bloques.filter(b=>b.tipo==='club').length;
  const coordinacion=bloques.filter(b=>b.tipo==='coordinacion').length;
  return {lecciones,club,coordinacion,total_semanal:lecciones+club+coordinacion};
}

async function horarioCompletoDocente(profesorId,anio){
  const [clases,bloques]=await Promise.all([
    pool.query(`
      SELECT h.dia,h.leccion,h.aula,s.nombre AS seccion_nombre,m.nombre AS materia_nombre
      FROM horarios h
      JOIN asignaciones a ON a.id=h.asignacion_id
      JOIN secciones s ON s.id=h.seccion_id
      JOIN materias m ON m.id=a.materia_id
      WHERE a.profesor_id=$1 AND h.anio=$2 AND COALESCE(a.activa,true)=true
      ORDER BY h.dia,h.leccion,s.nombre,m.nombre`,[profesorId,anio]),
    pool.query(`SELECT id,profesor_id,anio,dia,leccion,tipo,detalle,lugar
      FROM horario_bloques_docente WHERE profesor_id=$1 AND anio=$2
      ORDER BY dia,leccion,id`,[profesorId,anio])
  ]);
  return {celdas:clases.rows,bloques:bloques.rows,resumen:resumenDocente(clases.rows,bloques.rows)};
}

async function validarBloque(body,idExcluir=null){
  const profesorId=enteroRango(body?.profesor_id,1,2147483647);
  const anio=enteroRango(body?.anio,2000,2100);
  const dia=enteroRango(body?.dia,1,5),leccion=enteroRango(body?.leccion,1,12);
  const tipo=String(body?.tipo||'').trim().toLowerCase();
  const detalle=String(body?.detalle||'').trim(),lugar=String(body?.lugar||'').trim();
  if(!profesorId||!anio||!dia||!leccion||!['club','coordinacion'].includes(tipo))
    return {error:'Complete docente, año, día, lección y tipo de bloque.'};
  if(detalle.length>120||lugar.length>80) return {error:'El nombre o lugar del bloque es demasiado extenso.'};
  const docente=await pool.query(`SELECT id FROM usuarios WHERE id=$1 AND activo=true`,[profesorId]);
  if(!docente.rows.length) return {error:'El docente seleccionado no está activo.'};
  const clase=await pool.query(`SELECT s.nombre AS seccion,m.nombre AS materia
    FROM horarios h JOIN asignaciones a ON a.id=h.asignacion_id
    JOIN secciones s ON s.id=h.seccion_id JOIN materias m ON m.id=a.materia_id
    WHERE a.profesor_id=$1 AND h.anio=$2 AND h.dia=$3 AND h.leccion=$4 LIMIT 1`,[profesorId,anio,dia,leccion]);
  if(clase.rows.length) return {error:`El docente ya tiene ${clase.rows[0].materia} con la sección ${clase.rows[0].seccion} en esa lección.`};
  const params=[profesorId,anio,dia,leccion];let excluir='';
  if(idExcluir){params.push(idExcluir);excluir=' AND id<>$5';}
  const ocupado=await pool.query(`SELECT tipo FROM horario_bloques_docente
    WHERE profesor_id=$1 AND anio=$2 AND dia=$3 AND leccion=$4${excluir} LIMIT 1`,params);
  if(ocupado.rows.length) return {error:'El docente ya tiene un bloque adicional en esa lección.'};
  return {profesorId,anio,dia,leccion,tipo,detalle,lugar};
}

// Solo administración puede preparar o consultar un horario futuro. Para
// cualquier otro perfil se ignora el año enviado por la pantalla o escrito a
// mano en la URL y se utiliza siempre el curso lectivo marcado como activo.
async function anioVisiblePara(req){
  const activo=await obtenerAnioActivo();
  const solicitado=parseInt(req.query.anio);
  return req.session?.usuario?.rol==='admin' && solicitado ? solicitado : activo;
}

// Fecha/hora actual en Costa Rica (UTC-6) — mismo patrón que comedor.js
function fechaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  return new Date(localMs).toISOString().slice(0,10);
}
// ── CATÁLOGO DE LECCIONES (horas) ──────────────────────────────────────────
router.get("/lecciones", requireAuth, async (req, res) => {
  const anio = await anioVisiblePara(req);
  res.json(obtenerLecciones(anio));
});

// ── DOCENTES DISPONIBLES PARA ADMINISTRAR SU HORARIO ────────────────────
router.get("/docentes", requireRol("admin"), asyncRoute(async (req,res)=>{
  const anio=parseInt(req.query.anio)||await obtenerAnioActivo();
  const r=await pool.query(`SELECT DISTINCT u.id,u.nombre,u.primer_apellido,u.segundo_apellido
    FROM usuarios u
    WHERE u.activo=true AND (
      u.rol IN ('profesor','profesor_guia','orientador')
      OR EXISTS (SELECT 1 FROM asignaciones a WHERE a.profesor_id=u.id AND a.anio=$1 AND COALESCE(a.activa,true)=true)
    )
    ORDER BY u.primer_apellido,u.segundo_apellido,u.nombre`,[anio]);
  res.json(r.rows);
}));

router.get("/docente/:id", requireRol("admin"), asyncRoute(async (req,res)=>{
  const profesorId=enteroRango(req.params.id,1,2147483647);
  const anio=parseInt(req.query.anio)||await obtenerAnioActivo();
  if(!profesorId) return res.status(400).json({error:'Docente inválido.'});
  const docente=await pool.query(`SELECT id,nombre,primer_apellido,segundo_apellido FROM usuarios WHERE id=$1 AND activo=true`,[profesorId]);
  if(!docente.rows.length) return res.status(404).json({error:'Docente no encontrado.'});
  res.json({anio,docente:docente.rows[0],...(await horarioCompletoDocente(profesorId,anio))});
}));

router.post("/bloques", requireRol("admin"), asyncRoute(async (req,res)=>{
  const datos=await validarBloque(req.body);
  if(datos.error) return res.status(409).json({error:datos.error});
  try{
    const r=await pool.query(`INSERT INTO horario_bloques_docente
      (profesor_id,anio,dia,leccion,tipo,detalle,lugar,creado_por)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [datos.profesorId,datos.anio,datos.dia,datos.leccion,datos.tipo,datos.detalle,datos.lugar,req.session.usuario.id]);
    res.json({ok:true,id:r.rows[0].id});
  }catch(e){if(e.code==='23505') return res.status(409).json({error:'El docente ya tiene un bloque en esa lección.'});throw e;}
}));

router.put("/bloques/:id", requireRol("admin"), asyncRoute(async (req,res)=>{
  const id=enteroRango(req.params.id,1,2147483647);
  if(!id) return res.status(400).json({error:'Bloque inválido.'});
  const existe=await pool.query('SELECT id FROM horario_bloques_docente WHERE id=$1',[id]);
  if(!existe.rows.length) return res.status(404).json({error:'Bloque no encontrado.'});
  const datos=await validarBloque(req.body,id);
  if(datos.error) return res.status(409).json({error:datos.error});
  await pool.query(`UPDATE horario_bloques_docente SET profesor_id=$1,anio=$2,dia=$3,leccion=$4,
    tipo=$5,detalle=$6,lugar=$7,updated_at=NOW() WHERE id=$8`,
    [datos.profesorId,datos.anio,datos.dia,datos.leccion,datos.tipo,datos.detalle,datos.lugar,id]);
  res.json({ok:true});
}));

router.delete("/bloques/:id", requireRol("admin"), asyncRoute(async (req,res)=>{
  const id=enteroRango(req.params.id,1,2147483647);
  if(!id) return res.status(400).json({error:'Bloque inválido.'});
  const r=await pool.query('DELETE FROM horario_bloques_docente WHERE id=$1 RETURNING id',[id]);
  if(!r.rows.length) return res.status(404).json({error:'Bloque no encontrado.'});
  res.json({ok:true});
}));

// ── ASIGNACIONES DE UNA SECCIÓN (para llenar el editor — solo admin) ──────
// Aplica herencia I → II Período: muestra la asignación del período actual
// si existe una versión específica (ej. talleres), si no, la del I Período.
router.get("/asignaciones/:seccion_id", requireRol("admin"), async (req, res) => {
  const anio = parseInt(req.query.anio) || await obtenerAnioActivo();
  const r = await pool.query(`
    SELECT a.id, a.subgrupo, a.periodo,
      m.nombre AS materia_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2
    FROM asignaciones a
    JOIN materias m ON m.id = a.materia_id
    JOIN usuarios u ON u.id = a.profesor_id
    WHERE a.seccion_id = $1
      AND a.anio = $2
      AND NOT (
        COALESCE(a.periodo,'I Período') = 'I Período'
        AND EXISTS (
          SELECT 1 FROM asignaciones a2
          WHERE a2.seccion_id = a.seccion_id AND a2.materia_id = a.materia_id
            AND a2.profesor_id = a.profesor_id AND a2.periodo = 'II Período'
            AND a2.anio = $2
        )
      )
    ORDER BY m.nombre, u.primer_apellido
  `, [req.params.seccion_id, anio]);
  res.json(r.rows);
});

// ── HORARIO DE UNA SECCIÓN ─────────────────────────────────────────────────
// Cualquier usuario autenticado del personal puede VERLO (profes ven horarios
// de estudiantes). Devuelve celdas + nombre del profe guía de la sección.
router.get("/", requireAuth, async (req, res) => {
  const seccionId = req.query.seccion_id;
  const anio = await anioVisiblePara(req);
  if(!seccionId) return res.status(400).json({ error: "seccion_id requerido" });

  const celdas = await pool.query(`
    SELECT h.id, h.dia, h.leccion, h.asignacion_id, h.materia_texto, h.aula,
      m.nombre AS materia_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2
    FROM horarios h
    LEFT JOIN asignaciones a ON a.id = h.asignacion_id
    LEFT JOIN materias m ON m.id = a.materia_id
    LEFT JOIN usuarios u ON u.id = a.profesor_id
    WHERE h.seccion_id = $1 AND h.anio = $2
    ORDER BY h.dia, h.leccion, h.id
  `, [seccionId, anio]);

  const guiaR = await pool.query(`
    SELECT u.nombre, u.primer_apellido, u.segundo_apellido
    FROM seccion_guia_anio sg JOIN usuarios u ON u.id = sg.profesor_id
    WHERE sg.seccion_id = $1 AND sg.anio=$2
  `, [seccionId, anio]);

  res.json({ anio, celdas: celdas.rows, guia: guiaR.rows[0] || null });
});

// ── GUARDAR HORARIO DE UNA SECCIÓN (solo admin) ────────────────────────────
// Reemplaza la grilla completa de esa sección + año (transaccional).
router.put("/:seccion_id", requireRol("admin"), async (req, res) => {
  const seccionId = req.params.seccion_id;
  const { anio, celdas } = req.body;
  const a = parseInt(anio) || await obtenerAnioActivo();
  if(!Array.isArray(celdas)) return res.status(400).json({ error: "celdas debe ser un array" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const idsAsignacion = [...new Set(celdas.map(c=>parseInt(c.asignacion_id)).filter(Boolean))];
    if(idsAsignacion.length){
      const validas = await client.query(`SELECT id FROM asignaciones
        WHERE id=ANY($1::int[]) AND seccion_id=$2 AND anio=$3`, [idsAsignacion,seccionId,a]);
      if(validas.rows.length !== idsAsignacion.length){
        await client.query("ROLLBACK");
        return res.status(409).json({ error:`El horario contiene asignaciones que no pertenecen a la sección o al año ${a}. Recargue la pantalla.` });
      }
    }
    const ocupadas=celdas.filter(c=>parseInt(c.asignacion_id)&&enteroRango(c.dia,1,5)&&enteroRango(c.leccion,1,12))
      .map(c=>({asignacion_id:parseInt(c.asignacion_id),dia:parseInt(c.dia),leccion:parseInt(c.leccion)}));
    if(ocupadas.length){
      const conflicto=await client.query(`SELECT b.tipo,u.nombre,u.primer_apellido,u.segundo_apellido,x.dia,x.leccion
        FROM jsonb_to_recordset($1::jsonb) AS x(asignacion_id integer,dia integer,leccion integer)
        JOIN asignaciones a ON a.id=x.asignacion_id
        JOIN horario_bloques_docente b ON b.profesor_id=a.profesor_id AND b.anio=$2 AND b.dia=x.dia AND b.leccion=x.leccion
        JOIN usuarios u ON u.id=a.profesor_id LIMIT 1`,[JSON.stringify(ocupadas),a]);
      if(conflicto.rows.length){
        const x=conflicto.rows[0];
        await client.query('ROLLBACK');
        return res.status(409).json({error:`${x.nombre} ${x.primer_apellido} ya tiene ${x.tipo==='club'?'Club':'Coordinación'} el día ${x.dia}, lección ${x.leccion}.`});
      }
    }
    await client.query("DELETE FROM horarios WHERE seccion_id=$1 AND anio=$2", [seccionId, a]);
    for(const c of celdas){
      if(!c.dia || !c.leccion) continue;
      if(!c.asignacion_id && !c.materia_texto) continue; // celda libre — no se guarda
      let aula = null;
      if(c.aula !== undefined && c.aula !== null && String(c.aula).trim() !== ''){
        aula = parseInt(c.aula);
        if(isNaN(aula) || aula < 0 || aula > 30){
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Aula inválida "${c.aula}" (día ${c.dia}, lección ${c.leccion}). Debe ser un número de 0 a 30.` });
        }
      }
      await client.query(`
        INSERT INTO horarios (anio, seccion_id, dia, leccion, asignacion_id, materia_texto, aula)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [a, seccionId, c.dia, c.leccion, c.asignacion_id || null, c.materia_texto || null, aula]);
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── MI HORARIO (profesor: sus lecciones en todas las secciones) ────────────
router.get("/mi-horario", requireAuth, asyncRoute(async (req, res) => {
  const anio = await anioVisiblePara(req);
  res.json({anio,...(await horarioCompletoDocente(req.session.usuario.id,anio))});
}));

module.exports = router;
module.exports.LECCIONES = LECCIONES_2026;
module.exports.obtenerLecciones = obtenerLecciones;
