const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

// Números iniciales por tipo
const INICIO = { oficio: 181, minuta: 88, proceso: 50, protocolo: 1 };
const MAX = 500;

// Tipos de protocolo
const TIPOS_PROTOCOLO = [
  "Pautas generales para protocolos de actuación en situaciones de violencia y riesgo",
  "Protocolo de actuación en situaciones de bullying",
  "Protocolo de atención del bullying contra la población LGTBI",
  "Protocolo de actuación en situaciones de hallazgo, tenencia y uso de armas",
  "Protocolo de actuación en situaciones de hallazgo, tenencia, consumo y tráfico de drogas",
  "Protocolo de actuación en situaciones de violencia física, psicológica, sexual, acoso y hostigamiento sexual",
  "Protocolo de atención a población estudiantil con lesiones autoinfligidas y/o riesgo por tentativa de suicidio",
  "Atención del embarazo y maternidad en personas menores de edad en el sistema educativo",
  "Protocolo de actuación institucional para restitución de derechos - víctimas de trata de personas",
  "Protocolo de actuación en situaciones de discriminación racial y xenofobia",
];

// Roles que pueden usar consecutivos
const ROLES_CONSEC = ['admin','auxiliar','orientador','profesor_guia','profesor','secretaria','administrativo'];

function canUse(req, res, next) {
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error:"No autorizado" });
  const fx = u.funciones_extra || [];
  const rol = u.rol;
  if(ROLES_CONSEC.includes(rol) || fx.includes("profesor_guia") || fx.includes("orientador"))
    return next();
  return res.status(403).json({ error:"Sin permisos" });
}

// ── OBTENER SIGUIENTE NÚMERO DISPONIBLE ─────────────────────────────
async function siguienteNumero(tipo) {
  const inicio = INICIO[tipo];
  const r = await pool.query(
    "SELECT numero FROM consecutivos WHERE tipo=$1 AND eliminado=false ORDER BY numero",
    [tipo]
  );
  const usados = new Set(r.rows.map(x => x.numero));
  for(let n = inicio; n <= MAX; n++) {
    if(!usados.has(n)) return n;
  }
  return null; // sin disponibles
}

// ── LISTAR CONSECUTIVOS ──────────────────────────────────────────────
router.get("/", requireAuth, canUse, async (req, res) => {
  const u = req.session.usuario;
  const esSecretaria = u.rol === "secretaria" || u.rol === "admin";
  const { tipo } = req.query;

  let q = `
    SELECT c.*, 
      u.nombre AS sol_nombre, u.primer_apellido AS sol_ap1, u.segundo_apellido AS sol_ap2,
      e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2, e.cedula AS est_cedula,
      s.nombre AS seccion_nombre
    FROM consecutivos c
    JOIN usuarios u ON u.id=c.solicitante_id
    LEFT JOIN estudiantes e ON e.id=c.estudiante_id
    LEFT JOIN secciones s ON s.id=c.seccion_id
    WHERE c.eliminado=false
  `;
  const params = [];

  if(!esSecretaria) {
    params.push(u.id);
    q += ` AND c.solicitante_id=$${params.length}`;
  }
  if(tipo) {
    params.push(tipo);
    q += ` AND c.tipo=$${params.length}`;
  }
  q += " ORDER BY c.tipo, c.numero";

  const r = await pool.query(q, params);
  res.json(r.rows);
});

// ── CREAR CONSECUTIVO ────────────────────────────────────────────────
router.post("/", requireAuth, canUse, async (req, res) => {
  const u = req.session.usuario;
  const { tipo, fecha, destinatario, motivo_oficio, solicitado_por_cargo,
          estudiante_id, solicitante_cargo, seccion_id, motivo_proceso,
          digitado_por_cargo, tipo_protocolo,
          solicitante_id: sol_id_body } = req.body;

  if(!tipo || !INICIO[tipo]) return res.status(400).json({ error:"Tipo inválido" });

  // Secretaria puede especificar el solicitante; otros usan su propio ID
  const solicitante_id = (u.rol === "secretaria" && sol_id_body) ? sol_id_body : u.id;

  const numero = await siguienteNumero(tipo);
  if(!numero) return res.status(400).json({ error:`No hay consecutivos disponibles para ${tipo}` });

  const r = await pool.query(`
    INSERT INTO consecutivos
      (tipo, numero, solicitante_id, fecha, destinatario, motivo_oficio, solicitado_por_cargo,
       estudiante_id, solicitante_cargo, seccion_id, motivo_proceso,
       digitado_por_cargo, tipo_protocolo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *
  `, [tipo, numero, solicitante_id, fecha||new Date().toISOString().slice(0,10),
      destinatario||null, motivo_oficio||null, solicitado_por_cargo||null,
      estudiante_id||null, solicitante_cargo||null, seccion_id||null, motivo_proceso||null,
      digitado_por_cargo||null, tipo_protocolo||null]);

  res.json({ ok:true, consecutivo: r.rows[0], numero });
});

// ── ELIMINAR (marcar como eliminado con justificación) ───────────────
router.delete("/:id", requireAuth, canUse, async (req, res) => {
  const { justificacion } = req.body || {};
  if(!justificacion || !justificacion.trim())
    return res.status(400).json({ error:"La justificación es obligatoria." });

  const u = req.session.usuario;
  const r = await pool.query("SELECT solicitante_id FROM consecutivos WHERE id=$1", [req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error:"No encontrado" });

  const esSecretaria = u.rol === "secretaria" || u.rol === "admin";
  if(!esSecretaria && r.rows[0].solicitante_id !== u.id)
    return res.status(403).json({ error:"Solo podés eliminar tus propios consecutivos" });

  await pool.query(
    "UPDATE consecutivos SET eliminado=true, justificacion_eliminacion=$1 WHERE id=$2",
    [justificacion.trim(), req.params.id]
  );
  res.json({ ok:true });
});

// ── SIGUIENTE NÚMERO DISPONIBLE (para mostrar en el form) ────────────
router.get("/siguiente/:tipo", requireAuth, canUse, async (req, res) => {
  const numero = await siguienteNumero(req.params.tipo);
  res.json({ numero, tipo: req.params.tipo });
});

// ── TIPOS DE PROTOCOLO ───────────────────────────────────────────────
router.get("/tipos-protocolo", requireAuth, (req, res) => {
  res.json(TIPOS_PROTOCOLO);
});

module.exports = router;
