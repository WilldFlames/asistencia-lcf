const router=require("express").Router();
const {pool}=require("../db");
const {requireAuth}=require("../middleware/auth");
const {obtenerAnioActivo}=require("../utils/lectivo");
const {calcularPromediosInstitucional}=require("./calificaciones");

async function puedeRendimiento(u){
  if(u?.rol==="admin" || (u?.funciones_extra||[]).includes("coordinador")) return true;
  const r=await pool.query("SELECT 1 FROM funciones_institucionales WHERE usuario_id=$1 AND tipo='coordinador'",[u?.id||0]);
  return r.rows.length>0;
}
async function requireRendimiento(req,res,next){
  try {
    if(await puedeRendimiento(req.session.usuario)) return next();
    res.status(403).json({error:"Sin permiso para consultar Rendimiento."});
  } catch (error) { next(error); }
}

const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

router.get("/filtros",requireAuth,requireRendimiento,asyncRoute(async(req,res)=>{
  const anio=await obtenerAnioActivo();
  const [secs,mats]=await Promise.all([
    pool.query(`SELECT DISTINCT s.id,s.nombre,s.nivel FROM asignaciones a JOIN secciones s ON s.id=a.seccion_id
      WHERE COALESCE(a.anio,$1)=$1 AND COALESCE(a.activa,true)=true ORDER BY s.nivel,s.nombre`,[anio]),
    pool.query(`SELECT DISTINCT m.id,m.nombre FROM asignaciones a JOIN materias m ON m.id=a.materia_id
      WHERE COALESCE(a.anio,$1)=$1 AND COALESCE(a.activa,true)=true
        AND m.nombre NOT IN ('Guía','Orientación','Fortalecimiento Matemático') ORDER BY m.nombre`,[anio])
  ]);
  res.json({anio,secciones:secs.rows,materias:mats.rows});
}));

function porcentaje(cantidad,total){return total?Number(((cantidad*100)/total).toFixed(2)):0;}

// Rendimiento es un tablero institucional de estados y tendencias. Las notas
// exactas se usan para calcular los indicadores, pero nunca se envían al
// navegador desde este módulo.
function estudianteSoloEstado(e){
  return {
    estudiante_id:e.estudiante_id,
    cedula:e.cedula,
    nombre:e.nombre,
    primer_apellido:e.primer_apellido,
    segundo_apellido:e.segundo_apellido,
    aprobado:!!e.aprobado
  };
}

function distribucionNotas(estudiantes,minima){
  const notas=estudiantes.map(e=>Number(e.nota)).filter(Number.isFinite);
  return [
    {etiqueta:"Menos de 50",cantidad:notas.filter(n=>n<50).length},
    {etiqueta:`50 a ${minima-1}`,cantidad:notas.filter(n=>n>=50&&n<minima).length},
    {etiqueta:`${minima} a 79`,cantidad:notas.filter(n=>n>=minima&&n<80).length},
    {etiqueta:"80 a 89",cantidad:notas.filter(n=>n>=80&&n<90).length},
    {etiqueta:"90 a 100",cantidad:notas.filter(n=>n>=90).length}
  ];
}

router.get("/resumen",requireAuth,requireRendimiento,asyncRoute(async(req,res)=>{
  const anio=await obtenerAnioActivo();
  const periodo=["I Período","II Período"].includes(req.query.periodo)?req.query.periodo:"I Período";
  if(!req.query.seccion_id && !req.query.materia_id){
    return res.status(400).json({error:"Seleccione al menos una sección o una materia para realizar el análisis."});
  }
  const params=[anio,periodo];
  let filtros="";
  if(req.query.seccion_id){params.push(Number(req.query.seccion_id));filtros+=` AND a.seccion_id=$${params.length}`;}
  if(req.query.materia_id){params.push(Number(req.query.materia_id));filtros+=` AND a.materia_id=$${params.length}`;}
  const asignaciones=await pool.query(`
    SELECT DISTINCT ON (a.seccion_id,a.materia_id,COALESCE(a.subgrupo,''))
      a.id,a.profesor_id,a.seccion_id,a.materia_id,a.subgrupo,
      s.nombre AS seccion_nombre,s.nivel,m.nombre AS materia_nombre,
      u.nombre AS prof_nombre,u.primer_apellido AS prof_ap1,u.segundo_apellido AS prof_ap2
    FROM asignaciones a
    JOIN secciones s ON s.id=a.seccion_id
    JOIN materias m ON m.id=a.materia_id
    JOIN usuarios u ON u.id=a.profesor_id
    WHERE COALESCE(a.anio,$1)=$1 AND COALESCE(a.activa,true)=true
      AND COALESCE(a.periodo,'I Período') IN ('I Período',$2)
      AND m.nombre NOT IN ('Guía','Orientación','Fortalecimiento Matemático')
      ${filtros}
    ORDER BY a.seccion_id,a.materia_id,COALESCE(a.subgrupo,''),
      CASE WHEN COALESCE(a.periodo,'I Período')=$2 THEN 0 ELSE 1 END,a.id DESC
  `,params);

  const grupos=[];
  for(const a of asignaciones.rows){
    const minima=Number(a.nivel)>=10?70:65;
    let promedioData=null;
    try{promedioData=await calcularPromediosInstitucional(a.profesor_id,a.seccion_id,a.materia_id,a.subgrupo,periodo);}catch(_){}
    const estudiantesProm=(promedioData?.estudiantes||[]).map(e=>({
      estudiante_id:e.estudiante_id,cedula:e.cedula,nombre:e.nombre,
      primer_apellido:e.primer_apellido,segundo_apellido:e.segundo_apellido,nota:Number(e.total||0),
      aprobado:Number(e.total||0)>=minima
    }));
    const aprobProm=estudiantesProm.filter(e=>e.aprobado).length;

    const examenesR=await pool.query(`SELECT id,nombre,fecha,puntaje_total FROM evaluaciones
      WHERE profesor_id=$1 AND seccion_id=$2 AND materia_id=$3
        AND (($4::text IS NULL AND subgrupo IS NULL) OR subgrupo=$4)
        AND periodo=$5 AND tipo='examen' ORDER BY fecha,nombre`,
      [a.profesor_id,a.seccion_id,a.materia_id,a.subgrupo||null,periodo]);
    const examenes=[];
    for(const ex of examenesR.rows){
      const notas=await pool.query(`
        SELECT e.id AS estudiante_id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,
          ROUND((nx.puntos_obtenidos*100/NULLIF($2::numeric,0))::numeric,2) AS nota
        FROM estudiantes e
        LEFT JOIN notas_examen nx ON nx.estudiante_id=e.id AND nx.evaluacion_id=$1
        WHERE e.seccion_id=$3 AND e.activo=true AND COALESCE(e.archivado,false)=false
          AND (($4::text IS NULL) OR e.subgrupo=$4)
        ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre
      `,[ex.id,ex.puntaje_total,a.seccion_id,a.subgrupo||null]);
      const conNota=notas.rows.filter(n=>n.nota!==null).map(n=>({...n,nota:Number(n.nota),aprobado:Number(n.nota)>=minima}));
      const aprobados=conNota.filter(n=>n.aprobado).length;
      examenes.push({
        id:ex.id,nombre:ex.nombre,fecha:ex.fecha,puntaje_total:Number(ex.puntaje_total),
        evaluados:conNota.length,sin_nota:notas.rows.length-conNota.length,
        aprobados,reprobados:conNota.length-aprobados,
        porcentaje_aprobacion:porcentaje(aprobados,conNota.length),
        distribucion:distribucionNotas(conNota,minima),
        estudiantes:conNota.map(estudianteSoloEstado)
      });
    }
    grupos.push({
      ...a,nota_minima:minima,
      promedio:{total:estudiantesProm.length,aprobados:aprobProm,reprobados:estudiantesProm.length-aprobProm,
        porcentaje_aprobacion:porcentaje(aprobProm,estudiantesProm.length),
        distribucion:distribucionNotas(estudiantesProm,minima),
        estudiantes:estudiantesProm.map(estudianteSoloEstado)},
      examenes
    });
  }
  res.json({anio,periodo,grupos});
}));

module.exports=router;
