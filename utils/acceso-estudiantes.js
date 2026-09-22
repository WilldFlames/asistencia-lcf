const { pool } = require("../db");
const { obtenerAnioActivo } = require("./lectivo");

const ROLES_ACCESO_TOTAL = new Set(["admin","auxiliar","administrativo","secretaria","bibliotecologa"]);
const ROLES_DOCENTES = new Set(["profesor","profesor_guia","orientador"]);

function accesoTotal(usuario){
  return Boolean(usuario && (
    ROLES_ACCESO_TOTAL.has(usuario.rol) ||
    (usuario.funciones_extra||[]).includes("lcf_familias")
  ));
}

async function seccionesPermitidas(usuario, db=pool){
  if(accesoTotal(usuario)) return null;
  const funciones=new Set(usuario?.funciones_extra||[]);
  const esDocente=Boolean(usuario && (
    ROLES_DOCENTES.has(usuario.rol) ||
    [...ROLES_DOCENTES].some(rol=>funciones.has(rol))
  ));
  if(!esDocente) return [];
  const anio=await obtenerAnioActivo(db);
  // Equivale a reunir: SELECT seccion_id FROM asignaciones, guía y orientación.
  // Se formula con EXISTS para que una misma persona pueda cumplir varios roles.
  const r=await db.query(`
    SELECT s.id AS seccion_id
    FROM secciones s
    WHERE EXISTS (
      SELECT 1 FROM asignaciones a
      WHERE a.seccion_id=s.id AND a.profesor_id=$1
        AND (a.anio=$2 OR a.anio IS NULL)
        AND COALESCE(a.activa,true)=true
    ) OR EXISTS (
      SELECT 1 FROM seccion_guia sg
      WHERE sg.seccion_id=s.id AND sg.profesor_id=$1
    ) OR EXISTS (
      SELECT 1 FROM seccion_orientador so
      WHERE so.seccion_id=s.id AND so.orientador_id=$1
    )
    ORDER BY s.nivel,s.nombre`,[usuario.id,anio]);
  return [...new Set(r.rows.map(x=>Number(x.seccion_id)).filter(Number.isInteger))];
}

async function puedeAccederEstudiante(usuario, estudianteId, db=pool){
  if(accesoTotal(usuario)) return true;
  const secciones=await seccionesPermitidas(usuario,db);
  if(!secciones.length) return false;
  const r=await db.query("SELECT 1 FROM estudiantes WHERE id=$1 AND seccion_id=ANY($2::int[])",[estudianteId,secciones]);
  return Boolean(r.rows.length);
}

function exigirAccesoEstudiante(obtenerId){
  return async (req,res,next)=>{
    try{
      const id=Number(obtenerId(req));
      if(!Number.isInteger(id)||id<=0) return res.status(400).json({error:"Estudiante inválido"});
      if(!await puedeAccederEstudiante(req.session.usuario,id))
        return res.status(403).json({error:"No tiene permiso para consultar este estudiante."});
      next();
    }catch(e){next(e);}
  };
}

module.exports={accesoTotal,seccionesPermitidas,puedeAccederEstudiante,exigirAccesoEstudiante};
