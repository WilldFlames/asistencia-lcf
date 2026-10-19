const router = require("express").Router();
const { pool } = require("../db");
const { requireRol } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");
const { calcularPromediosInstitucional } = require("./calificaciones");

const LIMITE = 8;
const INICIO_REGLAS = 2027;
const staff = requireRol("admin", "auxiliar", "profesor", "profesor_guia", "orientador");
// Sincronizar no altera calificaciones: únicamente reconstruye el control
// informativo a partir de las notas ya guardadas. Permitirlo a todo el personal
// autorizado evita que un docente vea la pantalla vacía hasta que Administración
// haya entrado primero al módulo.
const sincroniza = staff;
const esGestion = u => ["admin", "auxiliar"].includes(u.rol);
const redondearAnual = n => Math.round(Number(n));
const minima = nivel => Number(nivel) <= 9 ? 65 : 70;
const esSemestral = nombre => ["Educación para el Hogar", "Artes Industriales"].includes(nombre);

function nombreCompleto(alias = "e") {
  return `TRIM(CONCAT_WS(' ',${alias}.nombre,${alias}.primer_apellido,${alias}.segundo_apellido))`;
}

async function recalcularEstado(client, expedienteId) {
  const er = await client.query("SELECT * FROM convocatoria_expedientes WHERE id=$1 FOR UPDATE", [expedienteId]);
  if (!er.rows.length) return;
  const exp = er.rows[0];
  const materias = (await client.query("SELECT * FROM convocatoria_materias WHERE expediente_id=$1 ORDER BY id", [expedienteId])).rows;
  const bloqueoReal = !exp.modo_informativo && Number(exp.total_aplazadas) > Number(exp.limite_institucional);
  if (bloqueoReal) {
    await client.query("UPDATE convocatoria_materias SET estado='bloqueada',updated_at=NOW() WHERE expediente_id=$1 AND estado<>'aprobada'", [expedienteId]);
    await client.query("UPDATE convocatoria_expedientes SET condicion='bloqueado_limite' WHERE id=$1", [expedienteId]);
    return;
  }

  // Una segunda ampliación reprobada puede habilitar Estrategia únicamente
  // cuando, al resolver las demás materias, queda como la única pendiente.
  const pendientes = materias.filter(m => m.estado !== "aprobada");
  for (const m of pendientes) {
    if (m.segunda_nota != null && Number(m.segunda_nota) < Number(m.nota_minima)) {
      const cumple = m.cumple_pruebas_tareas === true && m.cumple_asistencia === true &&
        m.cumple_proyectos === true && m.presento_ambas === true;
      const nuevo = pendientes.length === 1 && cumple ? "estrategia_pendiente" : "reprobada";
      await client.query("UPDATE convocatoria_materias SET estado=$1,updated_at=NOW() WHERE id=$2", [nuevo, m.id]);
      m.estado = nuevo;
    }
  }
  const frescas = (await client.query("SELECT estado FROM convocatoria_materias WHERE expediente_id=$1", [expedienteId])).rows;
  let condicion = "pendiente";
  if (frescas.length && frescas.every(x => x.estado === "aprobada")) condicion = "aprobado";
  else if (frescas.length && frescas.every(x => ["aprobada", "reprobada"].includes(x.estado)) && frescas.some(x => x.estado === "reprobada")) condicion = "repite";
  await client.query("UPDATE convocatoria_expedientes SET condicion=$1,cerrado_at=CASE WHEN $1 IN ('aprobado','repite') THEN NOW() ELSE NULL END WHERE id=$2", [condicion, expedienteId]);
}

async function sincronizar(anio, usuarioId, profesorFiltro=null) {
  const inicio=Date.now();
  const activo = await obtenerAnioActivo();
  if (Number(anio) !== Number(activo)) throw Object.assign(new Error(`Solo se pueden recalcular las notas del curso lectivo activo (${activo}). Los años cerrados conservan su expediente.`), { status: 409 });
  const parametros=[anio];
  let filtroProfesor="";
  if(Number.isInteger(Number(profesorFiltro)) && Number(profesorFiltro)>0){
    parametros.push(Number(profesorFiltro));
    filtroProfesor=`AND a.profesor_id=$${parametros.length}`;
  }
  const grupos = (await pool.query(`
    WITH candidatos AS (
      SELECT DISTINCT ON (a.profesor_id,a.seccion_id,a.materia_id,COALESCE(a.subgrupo,''))
        a.id,a.profesor_id,a.seccion_id,a.materia_id,a.subgrupo,
        m.nombre AS materia_nombre,s.nivel
      FROM asignaciones a
      JOIN materias m ON m.id=a.materia_id
      JOIN secciones s ON s.id=a.seccion_id
      WHERE a.anio=$1 AND COALESCE(a.activa,true)=true
        ${filtroProfesor}
        AND m.nombre NOT IN ('Guía','Orientación','Fortalecimiento Matemático')
      ORDER BY a.profesor_id,a.seccion_id,a.materia_id,COALESCE(a.subgrupo,''),
        CASE WHEN a.periodo='II Período' THEN 0 ELSE 1 END,a.id DESC
    )
    SELECT c.*,periodos.periodos_con_notas
    FROM candidatos c
    CROSS JOIN LATERAL (
      SELECT ARRAY_AGG(DISTINCT z.periodo ORDER BY z.periodo) AS periodos_con_notas
      FROM (
        SELECT ev.periodo
        FROM evaluaciones ev
        WHERE ev.profesor_id=c.profesor_id AND ev.seccion_id=c.seccion_id
          AND ev.materia_id=c.materia_id
          AND COALESCE(ev.subgrupo,'')=COALESCE(c.subgrupo,'')
          AND ev.periodo IN ('I Período','II Período')
          AND EXTRACT(YEAR FROM ev.fecha)=$1
          AND (
            EXISTS(SELECT 1 FROM notas_examen nx WHERE nx.evaluacion_id=ev.id AND nx.puntos_obtenidos IS NOT NULL)
            OR EXISTS(SELECT 1 FROM notas_indicador ni WHERE ni.evaluacion_id=ev.id AND ni.puntaje IS NOT NULL)
          )
        UNION
        SELECT cs.periodo
        FROM asignaciones ax
        JOIN calificaciones_simplificadas cs ON cs.asignacion_id=ax.id
        WHERE ax.anio=$1 AND ax.profesor_id=c.profesor_id AND ax.seccion_id=c.seccion_id
          AND ax.materia_id=c.materia_id
          AND COALESCE(ax.subgrupo,'')=COALESCE(c.subgrupo,'')
          AND cs.periodo IN ('I Período','II Período')
          AND (cs.pct_cotidiano IS NOT NULL OR cs.pct_tareas IS NOT NULL
            OR cs.pct_pruebas IS NOT NULL OR cs.pct_proyectos IS NOT NULL)
      ) z
    ) periodos
    WHERE COALESCE(CARDINALITY(periodos.periodos_con_notas),0)>0
    ORDER BY c.profesor_id,c.seccion_id,c.materia_id,COALESCE(c.subgrupo,'')
  `, parametros)).rows;

  const acumulado = new Map();
  const incidencias = [];
  const tieneNotaRegistrada = est => {
    const rubros = est?.rubros || {};
    if (est?.modo_simplificado) {
      return ["cotidiano", "tarea", "examen", "proyecto"]
        .some(k => rubros[k]?.nota_100 != null);
    }
    return ["cotidiano", "tarea", "examen", "proyecto"]
      .some(k => Number(rubros[k]?.cant_con_nota || 0) > 0);
  };
  const poner = (est, g, periodo, nota) => {
    // La asistencia puede producir un total aun cuando no exista ninguna nota.
    // Convocatoria solo toma materias donde el docente registró calificaciones.
    if (!tieneNotaRegistrada(est) || nota == null || !Number.isFinite(Number(nota))) return;
    // Hogar e Industriales se aprueban con el único semestre cursado. Aunque
    // existan datos antiguos en ambos períodos, son UNA asignatura y nunca
    // pueden sumar dos aplazadas. El subgrupo determina el semestre real:
    // Hogar A / Industriales B en I; el grupo contrario en II.
    let periodoOrigen="Anual";
    if(esSemestral(g.materia_nombre)){
      const sg=String(est.subgrupo||g.subgrupo||'').toUpperCase();
      periodoOrigen=g.materia_nombre==="Educación para el Hogar"
        ? (sg==="A"?"I Período":"II Período")
        : (sg==="B"?"I Período":"II Período");
      if(periodo!==periodoOrigen) return;
    }
    const clave = `${est.estudiante_id}|${g.materia_id}|${periodoOrigen}`;
    const actual = acumulado.get(clave) || { estudiante_id:Number(est.estudiante_id), materia_id:Number(g.materia_id), materia_nombre:g.materia_nombre, periodo_origen:periodoOrigen, profesor_id:Number(g.profesor_id), asignacion_id:Number(g.id), nivel:Number(g.nivel), nota_i:null, nota_ii:null };
    if (periodo === "I Período") actual.nota_i = Number(nota);
    else actual.nota_ii = Number(nota);
    actual.profesor_id = Number(g.profesor_id);
    actual.asignacion_id = Number(g.id);
    acumulado.set(clave, actual);
  };

  const trabajos=grupos.flatMap(g=>(g.periodos_con_notas||[]).map(periodo=>({g,periodo})));
  console.info(`[CONVOCATORIA] cálculo ${anio}: ${grupos.length} grupos y ${trabajos.length} períodos${profesorFiltro?` del docente ${profesorFiltro}`:' institucionales'}.`);
  let siguiente=0;
  const procesar=async()=>{
    while(siguiente<trabajos.length){
      const indice=siguiente++;
      const {g,periodo}=trabajos[indice];
      try {
        const data = await calcularPromediosInstitucional(g.profesor_id, g.seccion_id, g.materia_id, g.subgrupo, periodo);
        for (const est of data.estudiantes || []) poner(est, g, periodo, est.total);
      } catch (e) {
        incidencias.push({
          asignacion_id:Number(g.id), materia:g.materia_nombre,
          seccion_id:Number(g.seccion_id), periodo, detalle:e.message
        });
      }
    }
  };
  // Una concurrencia pequeña reduce mucho el tiempo sin saturar PostgreSQL ni
  // repetir el problema de estabilidad que tuvo el servidor con procesos masivos.
  await Promise.all(Array.from({length:Math.min(4,Math.max(1,trabajos.length))},procesar));

  const fallos = [];
  for (const x of acumulado.values()) {
    let nota;
    if (x.periodo_origen === "I Período") nota = x.nota_i;
    else if (x.periodo_origen === "II Período") nota = x.nota_ii;
    else if (x.nota_i != null && x.nota_ii != null) nota = (x.nota_i + x.nota_ii) / 2;
    else nota = x.nota_i != null ? x.nota_i : x.nota_ii;
    if (nota != null && redondearAnual(nota) < minima(x.nivel)) fallos.push({ ...x, nota_origen:nota, nota_minima:minima(x.nivel) });
  }

  // Conducta se contabiliza una sola vez. Guía nunca se suma por separado.
  const conducta = (await pool.query(`
    SELECT DISTINCT ON (ec.estudiante_id) ec.estudiante_id,ec.nota_anual AS nota_origen,
      ec.guia_id AS profesor_id,e.seccion_id,s.nivel,ec.resultado_tes
    FROM expedientes_conducta_tes ec JOIN estudiantes e ON e.id=ec.estudiante_id
      LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE ec.anio=$1 AND ec.nota_anual IS NOT NULL
    ORDER BY ec.estudiante_id,ec.updated_at DESC,ec.id DESC
  `, [anio])).rows;
  for (const c of conducta) if ((!profesorFiltro || Number(c.profesor_id)===Number(profesorFiltro)) && redondearAnual(c.nota_origen) < minima(c.nivel)) fallos.push({
    ...c,materia_id:null,materia_nombre:"Conducta",periodo_origen:"Anual",asignacion_id:null,
    nota_minima:minima(c.nivel),estado_inicial:c.resultado_tes==='aprobado'?'aprobada':c.resultado_tes==='no_aprobado'?'reprobada':'tes_pendiente'
  });

  const estudiantes = new Map();
  for (const f of fallos) {
    if (!estudiantes.has(f.estudiante_id)) estudiantes.set(f.estudiante_id, []);
    estudiantes.get(f.estudiante_id).push(f);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Solamente una sincronización del mismo año puede escribir a la vez.
    // El bloqueo es de PostgreSQL (funciona incluso entre varios contenedores)
    // y se libera automáticamente al confirmar o revertir la transacción.
    await client.query(
      "SELECT pg_advisory_xact_lock($1::integer,$2::integer)",
      [20261018,Number(anio)]
    );
    // Mantener un orden único también evita ciclos de bloqueo si otro proceso
    // institucional toca expedientes mientras se actualiza el control.
    const estudiantesOrdenados=[...estudiantes.entries()]
      .sort((a,b)=>Number(a[0])-Number(b[0]));
    for (const [estudianteId, materias] of estudiantesOrdenados) {
      const info = await client.query(`SELECT e.seccion_id,s.nivel FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id WHERE e.id=$1`, [estudianteId]);
      if (!info.rows.length || !info.rows[0].nivel) continue;
      const total = materias.length;
      const informativo = Number(anio) < INICIO_REGLAS;
      const condicion = total > LIMITE ? "bloqueado_limite" : "con_derecho";
      const ex = await client.query(`INSERT INTO convocatoria_expedientes
        (estudiante_id,anio,nivel,seccion_id,total_aplazadas,limite_institucional,conducta_incluida,modo_informativo,condicion,sincronizado_por,sincronizado_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT(estudiante_id,anio) DO UPDATE SET nivel=EXCLUDED.nivel,seccion_id=EXCLUDED.seccion_id,
          total_aplazadas=CASE WHEN $11::boolean THEN convocatoria_expedientes.total_aplazadas ELSE EXCLUDED.total_aplazadas END,
          limite_institucional=EXCLUDED.limite_institucional,
          conducta_incluida=CASE WHEN $11::boolean THEN convocatoria_expedientes.conducta_incluida ELSE EXCLUDED.conducta_incluida END,
          modo_informativo=EXCLUDED.modo_informativo,
          condicion=CASE WHEN convocatoria_expedientes.condicion IN ('aprobado','repite') THEN convocatoria_expedientes.condicion ELSE EXCLUDED.condicion END,
          sincronizado_por=EXCLUDED.sincronizado_por,sincronizado_at=NOW()
        RETURNING id`, [estudianteId, anio, info.rows[0].nivel, info.rows[0].seccion_id, total, LIMITE, materias.some(m=>m.materia_nombre==="Conducta"), informativo, condicion, usuarioId,!!profesorFiltro]);
      const expedienteId = ex.rows[0].id;
      for (const m of materias) {
        await client.query(`INSERT INTO convocatoria_materias
          (expediente_id,materia_id,materia_nombre,periodo_origen,asignacion_id,profesor_id,nota_origen,nota_minima,estado)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(expediente_id,materia_nombre,periodo_origen) DO UPDATE SET
            materia_id=EXCLUDED.materia_id,asignacion_id=EXCLUDED.asignacion_id,profesor_id=EXCLUDED.profesor_id,
            nota_origen=EXCLUDED.nota_origen,nota_minima=EXCLUDED.nota_minima,
            estado=CASE WHEN EXCLUDED.materia_nombre='Conducta' THEN EXCLUDED.estado ELSE convocatoria_materias.estado END,
            updated_at=NOW()`,
          [expedienteId,m.materia_id,m.materia_nombre,m.periodo_origen,m.asignacion_id,m.profesor_id,m.nota_origen,m.nota_minima,
            m.estado_inicial||((!informativo&&total>LIMITE)?"bloqueada":"primera_pendiente")]);
      }
      await client.query(`INSERT INTO convocatoria_eventos(expediente_id,tipo,detalle,usuario_id)
        VALUES($1,'sincronizacion',jsonb_build_object(
          'total_aplazadas',$2::integer,
          'modo_informativo',$3::boolean
        ),$4)`, [expedienteId,total,informativo,usuarioId]);
    }
    // Quitar únicamente candidatos que ya no están aplazados. En una carga
    // docente nunca se tocan materias de otros profesores; la carga
    // institucional sí reconcilia el conjunto completo.
    const clavesVigentes=fallos.map(m=>`${m.estudiante_id}|${m.materia_nombre}|${m.periodo_origen}`);
    await client.query(`DELETE FROM convocatoria_materias cm
      USING convocatoria_expedientes ce
      WHERE ce.id=cm.expediente_id AND ce.anio=$1
        AND ($2::integer IS NULL OR cm.profesor_id=$2::integer)
        AND cm.primera_nota IS NULL AND cm.segunda_nota IS NULL AND cm.estrategia_nota IS NULL
        AND NOT ((ce.estudiante_id::text||'|'||cm.materia_nombre||'|'||cm.periodo_origen)=ANY($3::text[]))`,
      [anio,profesorFiltro||null,clavesVigentes]);
    // El total siempre se deriva de las materias conservadas. Así una
    // sincronización parcial no reemplaza el conteo institucional.
    await client.query(`UPDATE convocatoria_expedientes ce SET
        total_aplazadas=(SELECT COUNT(*)::integer FROM convocatoria_materias cm WHERE cm.expediente_id=ce.id),
        conducta_incluida=EXISTS(SELECT 1 FROM convocatoria_materias cm WHERE cm.expediente_id=ce.id AND cm.materia_nombre='Conducta')
      WHERE ce.anio=$1`,[anio]);
    await client.query("COMMIT");
    console.info(`[CONVOCATORIA] sincronización ${anio} completada: ${estudiantes.size} estudiantes, ${fallos.length} materias, ${Date.now()-inicio} ms.`);
    return {
      expedientes:estudiantes.size, materias:fallos.length,
      modo_informativo:Number(anio)<INICIO_REGLAS, limite:LIMITE,
      grupos_revisados:grupos.length, periodos_revisados:trabajos.length,
      incidencias:incidencias.length,
      detalle_incidencias:incidencias.slice(0,20)
    };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

router.post("/sincronizar", sincroniza, async (req,res) => {
  try {
    const anio=Number(req.body.anio)||await obtenerAnioActivo();
    const u=req.session.usuario;
    // Docentes recalculan únicamente lo que imparten. Administración y
    // auxiliares conservan el control cruzado de toda la institución.
    const profesorFiltro=esGestion(u)?null:Number(u.id);
    res.json(await sincronizar(anio,u.id,profesorFiltro));
  }
  catch(e){ console.error("convocatoria sincronizar",e); res.status(e.status||500).json({error:e.message}); }
});

router.get("/listado", staff, async (req,res) => {
  try {
    const u=req.session.usuario, anio=Number(req.query.anio)||await obtenerAnioActivo();
    const secciones=esGestion(u)
      ? (await pool.query(`SELECT s.id,s.nombre,s.nivel FROM secciones s
          JOIN secciones_anio sa ON sa.seccion_id=s.id
          WHERE sa.anio=$1 AND sa.activa=true
          ORDER BY s.nivel,s.nombre`,[anio])).rows
      : (await pool.query(`SELECT DISTINCT s.id,s.nombre,s.nivel
          FROM asignaciones a JOIN secciones s ON s.id=a.seccion_id
          JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=a.anio
          WHERE a.anio=$1 AND a.profesor_id=$2 AND COALESCE(a.activa,true)=true
            AND sa.activa=true
          ORDER BY s.nivel,s.nombre`,[anio,u.id])).rows;
    const params=[anio];
    let alcance="";
    if(!esGestion(u)){ params.push(u.id); alcance=`AND cm.profesor_id=$${params.length}`; }
    const r=await pool.query(`SELECT cm.*,ce.estudiante_id,ce.total_aplazadas,ce.limite_institucional,
      ce.modo_informativo,ce.condicion,ce.conducta_incluida,s.nombre AS seccion_nombre,s.nivel,
      ${nombreCompleto("e")} AS estudiante_nombre,${nombreCompleto("u")} AS profesor_nombre
      FROM convocatoria_materias cm JOIN convocatoria_expedientes ce ON ce.id=cm.expediente_id
      JOIN estudiantes e ON e.id=ce.estudiante_id LEFT JOIN secciones s ON s.id=ce.seccion_id
      LEFT JOIN usuarios u ON u.id=cm.profesor_id
      WHERE ce.anio=$1 AND cm.materia_nombre<>'Conducta' ${alcance}
      ORDER BY s.nombre,e.primer_apellido,e.segundo_apellido,e.nombre,cm.materia_nombre,cm.periodo_origen`,params);
    const filas=r.rows.map(x=>{
      if(!esGestion(u)) delete x.profesor_nombre;
      return x;
    });
    res.json({anio,modo_informativo:anio<INICIO_REGLAS,limite:LIMITE,puede_sincronizar:true,ve_detalle:esGestion(u),secciones,filas});
  }catch(e){console.error("convocatoria listado",e);res.status(500).json({error:e.message});}
});

router.post("/materia/:id/resultado", staff, async (req,res)=>{
  const u=req.session.usuario, id=Number(req.params.id), etapa=String(req.body.etapa||"");
  if(!["primera","segunda","estrategia"].includes(etapa)) return res.status(400).json({error:"Etapa inválida."});
  const nota=Number(req.body.nota), fecha=String(req.body.fecha||"");
  if(!Number.isFinite(nota)||nota<0||nota>100||!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({error:"Indique una nota entre 0 y 100 y una fecha válida."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const qr=await client.query(`SELECT cm.*,ce.total_aplazadas,ce.limite_institucional,ce.modo_informativo,ce.id AS exp_id
      FROM convocatoria_materias cm JOIN convocatoria_expedientes ce ON ce.id=cm.expediente_id WHERE cm.id=$1 FOR UPDATE`,[id]);
    if(!qr.rows.length) throw Object.assign(new Error("Registro no encontrado."),{status:404});
    const m=qr.rows[0];
    if(u.rol!=="admin" && Number(m.profesor_id)!==Number(u.id)) throw Object.assign(new Error("Solo el docente responsable o Administración puede registrar este resultado."),{status:403});
    if(!m.modo_informativo && Number(m.total_aplazadas)>Number(m.limite_institucional)) throw Object.assign(new Error("El estudiante supera el límite institucional y no tiene derecho a realizar convocatorias."),{status:409});
    if(etapa==="segunda" && m.primera_nota==null) throw Object.assign(new Error("Primero debe registrar la primera ampliación."),{status:409});
    if(etapa==="estrategia" && m.estado!=="estrategia_pendiente") throw Object.assign(new Error("La Estrategia de Promoción todavía no está habilitada para esta materia."),{status:409});
    const min=Number(m.nota_minima), aprobada=nota>=min;
    if(etapa==="primera") await client.query(`UPDATE convocatoria_materias SET primera_nota=$1,primera_fecha=$2,primera_registrada_por=$3,primera_registrada_at=NOW(),estado=$4,nota_final=$5,updated_at=NOW() WHERE id=$6`,[nota,fecha,u.id,aprobada?"aprobada":"segunda_pendiente",aprobada?min:null,id]);
    if(etapa==="segunda") await client.query(`UPDATE convocatoria_materias SET segunda_nota=$1,segunda_fecha=$2,segunda_registrada_por=$3,segunda_registrada_at=NOW(),cumple_pruebas_tareas=$4,cumple_asistencia=$5,cumple_proyectos=$6,presento_ambas=true,estado=$7,nota_final=$8,updated_at=NOW() WHERE id=$9`,[nota,fecha,u.id,req.body.cumple_pruebas_tareas===true,req.body.cumple_asistencia===true,req.body.cumple_proyectos===true,aprobada?"aprobada":"reprobada",aprobada?min:null,id]);
    if(etapa==="estrategia") await client.query(`UPDATE convocatoria_materias SET estrategia_nota=$1,estrategia_fecha=$2,estrategia_registrada_por=$3,estrategia_registrada_at=NOW(),estado=$4,nota_final=$5,updated_at=NOW() WHERE id=$6`,[nota,fecha,u.id,aprobada?"aprobada":"reprobada",aprobada?min:null,id]);
    await client.query(`INSERT INTO convocatoria_eventos(expediente_id,materia_id,tipo,detalle,usuario_id)
      VALUES($1,$2,$3,jsonb_build_object('nota',$4::numeric,'fecha',$5::date),$6)`,
      [m.exp_id,id,`resultado_${etapa}`,nota,fecha,u.id]);
    await recalcularEstado(client,m.exp_id);
    await client.query("COMMIT"); res.json({ok:true});
  }catch(e){await client.query("ROLLBACK");res.status(e.status||500).json({error:e.message});}
  finally{client.release();}
});

module.exports=router;
