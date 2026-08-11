require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const MATERIAS_DEFAULT = [
  "Español","Estudios Sociales","Matemática","Ciencias","Cívica",
  "Inglés","Francés","Artes Industriales","Artes Plásticas","Informática Educativa",
  "Ética y Valores","Guía","Orientación","Educación Física","Educación para el Hogar",
  "Biología","Física Matemática","Química","Filosofía","Psicología",
  "Educación para la Paz","Fortalecimiento Matemático"
];

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id               SERIAL PRIMARY KEY,
        cedula           TEXT UNIQUE NOT NULL,
        nombre           TEXT NOT NULL,
        primer_apellido  TEXT NOT NULL,
        segundo_apellido TEXT NOT NULL,
        email            TEXT,
        password_hash    TEXT NOT NULL,
        rol              TEXT NOT NULL CHECK(rol IN ('admin','auxiliar','orientador','profesor_guia','profesor','cocinera')),
        primer_login     BOOLEAN DEFAULT true,
        activo           BOOLEAN DEFAULT true,
        created_at       TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS secciones (
        id     SERIAL PRIMARY KEY,
        nombre TEXT UNIQUE NOT NULL,
        nivel  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS materias (
        id     SERIAL PRIMARY KEY,
        nombre TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS asignaciones (
        id               SERIAL PRIMARY KEY,
        profesor_id      INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        seccion_id       INTEGER REFERENCES secciones(id) ON DELETE CASCADE,
        materia_id       INTEGER REFERENCES materias(id) ON DELETE CASCADE,
        lecciones_semana INTEGER DEFAULT 4,
        UNIQUE(profesor_id, seccion_id, materia_id)
      );

      CREATE TABLE IF NOT EXISTS seccion_guia (
        seccion_id  INTEGER PRIMARY KEY REFERENCES secciones(id) ON DELETE CASCADE,
        profesor_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS seccion_orientador (
        id            SERIAL PRIMARY KEY,
        seccion_id    INTEGER REFERENCES secciones(id) ON DELETE CASCADE,
        orientador_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        UNIQUE(seccion_id, orientador_id)
      );

      CREATE TABLE IF NOT EXISTS estudiantes (
        id               SERIAL PRIMARY KEY,
        cedula           TEXT UNIQUE NOT NULL,
        nombre           TEXT NOT NULL,
        primer_apellido  TEXT NOT NULL,
        segundo_apellido TEXT NOT NULL,
        fecha_nacimiento DATE,
        seccion_id       INTEGER REFERENCES secciones(id) ON DELETE SET NULL,
        activo           BOOLEAN DEFAULT true,
        created_at       TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS encargados (
        id               SERIAL PRIMARY KEY,
        estudiante_id    INTEGER REFERENCES estudiantes(id) ON DELETE CASCADE,
        cedula           TEXT DEFAULT '',
        nombre           TEXT NOT NULL,
        primer_apellido  TEXT NOT NULL,
        segundo_apellido TEXT DEFAULT '',
        parentesco       TEXT DEFAULT '',
        telefono         TEXT DEFAULT '',
        celular          TEXT DEFAULT '',
        telefono_trabajo TEXT DEFAULT '',
        lugar_trabajo    TEXT DEFAULT '',
        email            TEXT DEFAULT '',
        direccion        TEXT DEFAULT '',
        es_principal     BOOLEAN DEFAULT false,
        created_at       TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sesiones_asistencia (
        id            SERIAL PRIMARY KEY,
        asignacion_id INTEGER REFERENCES asignaciones(id) ON DELETE CASCADE,
        fecha         DATE NOT NULL,
        lecciones     INTEGER NOT NULL DEFAULT 1,
        created_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(asignacion_id, fecha)
      );

      CREATE TABLE IF NOT EXISTS asistencia (
        id                SERIAL PRIMARY KEY,
        sesion_id         INTEGER REFERENCES sesiones_asistencia(id) ON DELETE CASCADE,
        estudiante_id     INTEGER REFERENCES estudiantes(id) ON DELETE CASCADE,
        estado            TEXT NOT NULL CHECK(estado IN ('P','A','T')),
        lecciones_ausentes INTEGER DEFAULT NULL,
        lecciones_tardias  INTEGER DEFAULT NULL,
        justificada       BOOLEAN DEFAULT false,
        motivo            TEXT DEFAULT '',
        UNIQUE(sesion_id, estudiante_id)
      );

      CREATE TABLE IF NOT EXISTS observaciones_diarias (
        id            SERIAL PRIMARY KEY,
        estudiante_id INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
        fecha         DATE NOT NULL,
        observacion   TEXT NOT NULL,
        created_at    TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS infracciones (
        id          SERIAL PRIMARY KEY,
        tipo        TEXT NOT NULL CHECK(tipo IN ('muy_leve','leve','grave','muy_grave','gravisima')),
        puntos      INTEGER NOT NULL,
        descripcion TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS boletas_conducta (
        id               SERIAL PRIMARY KEY,
        estudiante_id    INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        infraccion_id    INTEGER NOT NULL REFERENCES infracciones(id),
        asignacion_id    INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        registrado_por   INTEGER NOT NULL REFERENCES usuarios(id),
        fecha            DATE NOT NULL,
        observacion      TEXT DEFAULT '',
        created_at       TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS informes (
        id              SERIAL PRIMARY KEY,
        remitente_id    INTEGER REFERENCES usuarios(id),
        destinatario_id INTEGER REFERENCES usuarios(id),
        estudiante_id   INTEGER REFERENCES estudiantes(id),
        conducta        TEXT DEFAULT '',
        participacion   TEXT DEFAULT '',
        trabajos        TEXT DEFAULT '',
        nota_estimada   TEXT DEFAULT '',
        recomendaciones TEXT DEFAULT '',
        observaciones   TEXT DEFAULT '',
        -- Campos de respuesta estructurada
        resp_asistencia       TEXT DEFAULT '',
        resp_trabajo_cotidiano TEXT DEFAULT '',
        resp_tareas           TEXT DEFAULT '',
        resp_examenes         TEXT DEFAULT '',
        resp_comportamiento   TEXT DEFAULT '',
        resp_observaciones    TEXT DEFAULT '',
        respuesta       TEXT DEFAULT '',
        respondido      BOOLEAN DEFAULT false,
        fecha_respuesta TIMESTAMP,
        leido           BOOLEAN DEFAULT false,
        created_at      TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS consecutivos (
        id              SERIAL PRIMARY KEY,
        tipo            TEXT NOT NULL CHECK(tipo IN ('oficio','minuta','proceso','protocolo')),
        numero          INTEGER NOT NULL,
        solicitante_id  INTEGER NOT NULL REFERENCES usuarios(id),
        -- Campos comunes
        fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
        -- Oficio
        destinatario    TEXT,
        motivo_oficio   TEXT,
        solicitado_por_cargo TEXT,
        -- Minuta
        estudiante_id   INTEGER REFERENCES estudiantes(id),
        solicitante_cargo TEXT,
        -- Proceso
        seccion_id      INTEGER REFERENCES secciones(id),
        motivo_proceso  TEXT,
        -- Protocolo
        digitado_por_cargo TEXT,
        tipo_protocolo  TEXT,
        -- Control
        eliminado       BOOLEAN DEFAULT false,
        justificacion_eliminacion TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      );

      -- Índice único parcial: solo números activos (no eliminados) deben ser únicos
      -- Esto permite reusar números de consecutivos eliminados
      CREATE UNIQUE INDEX IF NOT EXISTS consecutivos_tipo_numero_activo
        ON consecutivos(tipo, numero) WHERE eliminado=false;

      CREATE TABLE IF NOT EXISTS comedor_asistencia (
        id             SERIAL PRIMARY KEY,
        estudiante_id  INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        fecha          DATE NOT NULL,
        tipo           TEXT DEFAULT 'regular',  -- becado / regular
        registrado_por INTEGER REFERENCES usuarios(id),
        created_at     TIMESTAMP DEFAULT NOW(),
        UNIQUE(estudiante_id, fecha)
      );

      CREATE TABLE IF NOT EXISTS comedor_comite (
        id          SERIAL PRIMARY KEY,
        usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        created_at  TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS expediente_historico (
        id               SERIAL PRIMARY KEY,
        estudiante_id    INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        anio             INTEGER NOT NULL,
        seccion_nombre   TEXT DEFAULT '',
        nivel            INTEGER DEFAULT NULL,
        encargados_snap  JSONB DEFAULT '[]',
        archivado_por    INTEGER REFERENCES usuarios(id),
        created_at       TIMESTAMP DEFAULT NOW(),
        UNIQUE(estudiante_id, anio)
      );

      CREATE TABLE IF NOT EXISTS matricula (
        id               SERIAL PRIMARY KEY,
        estudiante_id    INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        anio             INTEGER NOT NULL,
        seccion_id       INTEGER REFERENCES secciones(id) ON DELETE SET NULL,
        seccion_nombre   TEXT DEFAULT '',
        num_boleta       TEXT DEFAULT '',
        confirmado_por   INTEGER REFERENCES usuarios(id),
        observaciones    TEXT DEFAULT '',
        convocatoria     BOOLEAN DEFAULT false,
        convocatoria_estado TEXT DEFAULT NULL,
        nivel_solicitado INTEGER DEFAULT NULL,
        nivel_origen     INTEGER DEFAULT NULL,
        convocatoria_resuelta_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        convocatoria_resuelta_at TIMESTAMP DEFAULT NULL,
        created_at       TIMESTAMP DEFAULT NOW(),
        UNIQUE(estudiante_id, anio)
      );

      CREATE TABLE IF NOT EXISTS notificaciones (
        id         SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo       TEXT NOT NULL,
        mensaje    TEXT NOT NULL,
        leida      BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── MIGRACIONES ────────────────────────────────────────────────────────────
    await client.query(`ALTER TABLE asistencia ADD COLUMN IF NOT EXISTS lecciones_ausentes INTEGER DEFAULT NULL`);
    // lecciones_tardias: cantidad de lecciones en que el estudiante llegó tarde.
    // Aplica solo cuando estado='T'. NULL para P y A. Para T sin valor explícito = 1 (comportamiento histórico).
    // Regla MEP: 2 tardías = 1 ausencia (se aplica en reportes y cálculos derivados).
    await client.query(`ALTER TABLE asistencia ADD COLUMN IF NOT EXISTS lecciones_tardias INTEGER DEFAULT NULL`);

    // boletas_conducta.usuario_apoyo_id: cuando la boleta no se atribuye a una
    // materia (asignacion_id NULL), permite asociarla a un orientador, auxiliar
    // o administrativo. El frontend muestra estos como "personal de apoyo".
    await client.query(`ALTER TABLE boletas_conducta ADD COLUMN IF NOT EXISTS usuario_apoyo_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);

    // ── MODO SIMPLIFICADO (DOS NIVELES + PERIODOS) ───────────────────────────
    // Una asignación se considera "simplificada" si:
    //   - La materia está marcada como simplificada (afecta a TODOS los profes
    //     que dan esa materia, en todos los periodos), O
    //   - Esa asignación específica está marcada Y el periodo actual está en
    //     la lista de periodos simplificados de la asignación.
    //
    // Caso de uso: Ética y Valores siempre va simplificada → marcamos la
    // MATERIA. Otra materia donde el sistema arrancó tarde → marcamos la
    // ASIGNACIÓN con ['I Período'] solamente; en II Período se usa normal.
    await client.query(`ALTER TABLE materias ADD COLUMN IF NOT EXISTS modo_simplificado BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE asignaciones ADD COLUMN IF NOT EXISTS modo_simplificado BOOLEAN DEFAULT false`);
    // Lista de periodos donde aplica el modo simplificado de la asignación.
    // Por defecto vacío. Valores válidos: 'I Período', 'II Período', 'III Período'.
    await client.query(`ALTER TABLE asignaciones ADD COLUMN IF NOT EXISTS simplificado_periodos TEXT[] DEFAULT ARRAY[]::TEXT[]`);

    // Tabla donde se guardan los porcentajes por rubro de estudiantes en
    // asignaciones simplificadas. Una fila por (estudiante, asignación, periodo).
    // Valores 0-100. NULL si el profe aún no calificó ese rubro.
    await client.query(`
      CREATE TABLE IF NOT EXISTS calificaciones_simplificadas (
        id              SERIAL PRIMARY KEY,
        asignacion_id   INTEGER NOT NULL REFERENCES asignaciones(id) ON DELETE CASCADE,
        estudiante_id   INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        periodo         TEXT NOT NULL,
        pct_cotidiano   NUMERIC(5,2),
        pct_tareas      NUMERIC(5,2),
        pct_pruebas     NUMERIC(5,2),
        pct_proyectos   NUMERIC(5,2),
        observaciones   TEXT DEFAULT '',
        registrado_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        updated_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(asignacion_id, estudiante_id, periodo)
      )
    `);

    // ── CARTAS DE AUSENTISMO ─────────────────────────────────────────────────
    // Registro histórico de las cartas que entrega el profesorado al encargado.
    // Snapshot de los datos en el momento de emisión (cantidad de ausencias y %)
    // para que el registro sea auditable aunque cambien después.
    await client.query(`
      CREATE TABLE IF NOT EXISTS cartas_ausentismo (
        id                  SERIAL PRIMARY KEY,
        estudiante_id       INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        asignacion_id       INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        emitida_por         INTEGER NOT NULL REFERENCES usuarios(id),
        fecha               DATE NOT NULL DEFAULT CURRENT_DATE,
        periodo             TEXT NOT NULL,
        materia             TEXT NOT NULL,
        ausencias           INTEGER NOT NULL DEFAULT 0,
        total_lecciones     INTEGER NOT NULL DEFAULT 0,
        porcentaje          NUMERIC(5,2) NOT NULL DEFAULT 0,
        observaciones       TEXT DEFAULT '',
        created_at          TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cartas_ausentismo_est ON cartas_ausentismo(estudiante_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cartas_ausentismo_emit ON cartas_ausentismo(emitida_por)`);

    // notificaciones.referencia_id: enlaza la notificación con la entidad referida (ej. boleta).
    // Permite que al hacer click en la notificación, el sistema pueda navegar al objeto.
    // Antes el código intentaba insertar este campo pero la columna no existía → INSERT
    // fallaba silenciosamente (catch en el caller) y el guía nunca recibía notificaciones
    // de boletas automáticas.
    await client.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS referencia_id INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE informes ADD COLUMN IF NOT EXISTS resp_asistencia TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE informes ADD COLUMN IF NOT EXISTS resp_trabajo_cotidiano TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE informes ADD COLUMN IF NOT EXISTS resp_tareas TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE informes ADD COLUMN IF NOT EXISTS resp_examenes TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE informes ADD COLUMN IF NOT EXISTS resp_comportamiento TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE informes ADD COLUMN IF NOT EXISTS resp_observaciones TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS justificacion_cambio_seccion TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS primer_login BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS subgrupo TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE asignaciones ADD COLUMN IF NOT EXISTS subgrupo TEXT DEFAULT NULL`);
    // Marca de vigencia: cuando arranca un año nuevo (Aplicar Matrículas),
    // las asignaciones del año anterior pasan a activa=false. Las nuevas
    // se crean con activa=true. El historial no se borra.
    await client.query(`ALTER TABLE asignaciones ADD COLUMN IF NOT EXISTS activa BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE asignaciones ADD COLUMN IF NOT EXISTS anio INTEGER DEFAULT NULL`);

    // ── EXPEDIENTE ACADÉMICO: resumen histórico por año ──────────────────
    // Se llena al presionar "Aplicar Matrículas" del año siguiente. Guarda un
    // resumen compacto por estudiante × año × período × materia (nota + faltas).
    // Los datos crudos (sesiones_asistencia, asistencia, evaluaciones, notas)
    // se BORRAN después de guardar aquí. Solo auxiliares/admin lo consultan.
    await client.query(`
      CREATE TABLE IF NOT EXISTS expediente_academico (
        id             SERIAL PRIMARY KEY,
        estudiante_id  INTEGER REFERENCES estudiantes(id) ON DELETE CASCADE,
        anio           INTEGER NOT NULL,
        periodo        TEXT NOT NULL,
        seccion_nombre TEXT,
        materia_nombre TEXT NOT NULL,
        profesor_nombre TEXT,
        nota_cotidiano NUMERIC,
        nota_tareas    NUMERIC,
        nota_pruebas   NUMERIC,
        nota_proyecto  NUMERIC,
        nota_asistencia NUMERIC,
        nota_total     NUMERIC,
        ausencias      INTEGER DEFAULT 0,
        ausencias_just INTEGER DEFAULT 0,
        tardias        INTEGER DEFAULT 0,
        conducta_nota  NUMERIC,
        created_at     TIMESTAMP DEFAULT NOW(),
        UNIQUE(estudiante_id, anio, periodo, materia_nombre)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_exp_acad_estudiante ON expediente_academico(estudiante_id, anio)`);
    await client.query(`ALTER TABLE encargados ADD COLUMN IF NOT EXISTS cedula TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE encargados ADD COLUMN IF NOT EXISTS lugar_trabajo TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE encargados ADD COLUMN IF NOT EXISTS telefono_trabajo TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE encargados ALTER COLUMN es_principal SET DEFAULT false`);
    await client.query(`UPDATE encargados SET es_principal=false WHERE es_principal IS NULL`);
    // Cada estudiante conserva exactamente un principal entre sus encargados.
    // Si los datos antiguos tenÃ­an ninguno o varios, se prioriza el que ya
    // estaba marcado y, como desempate, el registro mÃ¡s antiguo.
    await client.query(`
      WITH ordenados AS (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY estudiante_id
            ORDER BY CASE WHEN es_principal THEN 0 ELSE 1 END, id
          ) AS posicion
        FROM encargados
        WHERE estudiante_id IS NOT NULL
      )
      UPDATE encargados e
      SET es_principal=(o.posicion=1)
      FROM ordenados o
      WHERE e.id=o.id AND e.es_principal IS DISTINCT FROM (o.posicion=1)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS encargados_un_principal_por_estudiante
      ON encargados(estudiante_id) WHERE es_principal=true
    `);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS foto_url TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS archivado BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS fecha_archivo DATE DEFAULT NULL`);
    // Conserva la sección que tenía la persona al momento de archivarla. La
    // sección activa se limpia, pero el expediente debe seguir mostrándola.
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS seccion_archivo TEXT DEFAULT NULL`);
    // Auditoría del retiro: quién lo hizo, cuándo y con qué motivo
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS retirado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS fecha_retiro TIMESTAMP DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS motivo_retiro TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS motivo_archivo TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS justificacion_archivo TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS becado BOOLEAN DEFAULT false`);
    // Idioma y tecnología del estudiante (digitados por orientadora de 9° o en matrícula)
    // idioma: 'Inglés' | 'Francés' · tecnologia: 'Inglés Conversacional' | 'Diseño Publicitario'
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS idioma TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS tecnologia TEXT DEFAULT NULL`);
    // Marca si el estudiante ya entregó la boleta (usada en Idioma/Tecnología y Matrícula)
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS boleta_entregada BOOLEAN DEFAULT false`);
    // Matrícula del año siguiente: sección futura + idioma/tecnología/subgrupo elegidos
    // (subgrupo: Inglés Conversacional = 'A' · Diseño Publicitario = 'B')
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS idioma TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS tecnologia TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS subgrupo TEXT DEFAULT NULL`);
    // Secciones exclusivas de un idioma POR AÑO (la sección de francés cambia:
    // 2026 → 10-3 y 11-3 · 2027 → 10-2 y 11-2). El sistema valida al asignar.
    await client.query(`
      CREATE TABLE IF NOT EXISTS secciones_idioma (
        id         SERIAL PRIMARY KEY,
        seccion_id INTEGER REFERENCES secciones(id) ON DELETE CASCADE,
        anio       INTEGER NOT NULL,
        idioma     TEXT NOT NULL,
        UNIQUE(seccion_id, anio)
      )
    `);
    // Config del A/B por sección y año — para pre-cargar el año nuevo:
    //   tec_b: qué tecnología B ofrece la sección (Diseño Publicitario o Matem/AMPROSA)
    //          (el A siempre es Inglés Conversacional). Solo aplica en 10° y 11°.
    //   taller_a / taller_b: qué taller cae en cada subgrupo en 7°-9°
    //          (Educación para el Hogar / Artes Industriales)
    await client.query(`
      CREATE TABLE IF NOT EXISTS secciones_config (
        id         SERIAL PRIMARY KEY,
        seccion_id INTEGER REFERENCES secciones(id) ON DELETE CASCADE,
        anio       INTEGER NOT NULL,
        tec_b      TEXT DEFAULT NULL,
        taller_a   TEXT DEFAULT NULL,
        taller_b   TEXT DEFAULT NULL,
        UNIQUE(seccion_id, anio)
      )
    `);
    // Ampliar constraint de rol para incluir todos los roles
    try {
      await client.query(`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check`);
      await client.query(`ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK(rol IN ('admin','auxiliar','orientador','profesor_guia','profesor','cocinera','secretaria','administrativo','junta','seguridad'))`);
    } catch(e) { /* ya existe con los valores correctos */ }
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS num_boleta TEXT DEFAULT ''`);
    // ── PREMATRÍCULA ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS prematricula (
        id SERIAL PRIMARY KEY,
        -- Datos del estudiante
        cedula TEXT NOT NULL,
        nombre TEXT NOT NULL,
        primer_apellido TEXT NOT NULL,
        segundo_apellido TEXT NOT NULL,
        fecha_nacimiento DATE,
        nacionalidad TEXT DEFAULT 'Costa Rica',
        centro_procedencia TEXT,
        -- Estado
        consecutivo_prematricula INTEGER,
        estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente','prematriculado','matriculado','retirado')),
        -- Control
        registrado_por INTEGER REFERENCES usuarios(id),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS prematricula_cedula_uq ON prematricula(cedula)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS prematricula_consec_uq ON prematricula(consecutivo_prematricula) WHERE consecutivo_prematricula IS NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS prematricula_encargado (
        id SERIAL PRIMARY KEY,
        prematricula_id INTEGER NOT NULL REFERENCES prematricula(id) ON DELETE CASCADE,
        parentesco TEXT,
        cedula TEXT,
        nombre TEXT NOT NULL,
        primer_apellido TEXT NOT NULL,
        segundo_apellido TEXT,
        fecha_nacimiento DATE,
        nacionalidad TEXT DEFAULT 'Costa Rica',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Columna telefono agregada después de la creación inicial (aditivo)
    await client.query(`ALTER TABLE prematricula_encargado ADD COLUMN IF NOT EXISTS telefono TEXT DEFAULT ''`);

    // ── MATRICULA (extiende estudiantes con campos 2027) ──────────────
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS sexo TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE asistencia ADD COLUMN IF NOT EXISTS escapado BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS escapado BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS boleta_escape_id INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE asistencia ADD COLUMN IF NOT EXISTS boleta_ausencia_id INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS nacionalidad TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS correo TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS provincia TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS canton TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS distrito TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS direccion_exacta TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS habita_con TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS habita_con_otro TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS adecuacion TEXT DEFAULT 'ninguna' CHECK(adecuacion IN ('ninguna','significativa','no_significativa'))`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS tipo_ingreso TEXT DEFAULT 'regular' CHECK(tipo_ingreso IN ('regular','prematricula','nuevo'))`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS nivel_matricula INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS matricula_completada BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS institucion_procedencia TEXT DEFAULT NULL`);
    // Médico
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS enfermedad TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS medicamento TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS telefonos_emergencia TEXT DEFAULT NULL`);

    // ── SOLICITUD BECA COMEDOR (matrícula) ────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS solicitud_beca_comedor (
        id SERIAL PRIMARY KEY,
        estudiante_id INTEGER REFERENCES estudiantes(id),
        cedula_estudiante TEXT,
        -- Familia
        personas_hogar INTEGER,
        tipo_vivienda TEXT,
        vive_con TEXT,
        ingreso_mensual NUMERIC(12,2),
        recibe_avancemos BOOLEAN DEFAULT false,
        monto_avancemos NUMERIC(12,2),
        otros_ingresos TEXT,
        motivos TEXT,
        -- Análisis interno
        ingreso_percapita NUMERIC(12,2),
        clasificacion TEXT,
        resolucion TEXT DEFAULT 'pendiente',
        observaciones TEXT,
        -- Control
        registrado_por INTEGER REFERENCES usuarios(id),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── SOLICITUD ADECUACIÓN CURRICULAR ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS solicitud_adecuacion (
        id SERIAL PRIMARY KEY,
        estudiante_id INTEGER REFERENCES estudiantes(id),
        motivo TEXT,
        antecedentes TEXT,
        registrado_por INTEGER REFERENCES usuarios(id),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── COMITÉ DE MATRÍCULA (hasta 6 personas) ───────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS matricula_comite (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Actualizar CHECK de prematricula.estado para incluir 'prematriculado'
    try {
      await client.query(`ALTER TABLE prematricula DROP CONSTRAINT IF EXISTS prematricula_estado_check`);
      await client.query(`ALTER TABLE prematricula ADD CONSTRAINT prematricula_estado_check
        CHECK(estado IN ('pendiente','prematriculado','matriculado','retirado'))`);
    } catch(e) {}

    // ── TABLA MEDIDAS ESTUDIANTILES ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS medidas_estudiantiles (
        id            SERIAL PRIMARY KEY,
        estudiante_id INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        tipo          TEXT NOT NULL CHECK(tipo IN ('precautoria','suspension','educacion_hibrida')),
        fecha_inicio  DATE NOT NULL,
        fecha_fin     DATE NOT NULL,
        observacion   TEXT DEFAULT '',
        creado_por    INTEGER REFERENCES usuarios(id),
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_medidas_est ON medidas_estudiantiles(estudiante_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_medidas_tipo ON medidas_estudiantiles(tipo)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_medidas_fechas ON medidas_estudiantiles(fecha_inicio, fecha_fin)");

    // Limpiar estudiantes duplicados (misma cédula en misma sección)
    // Mantiene el más reciente, desactiva los anteriores
    try {
      await client.query(`
        UPDATE estudiantes SET activo=false
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
              ROW_NUMBER() OVER (PARTITION BY cedula, seccion_id ORDER BY id DESC) AS rn
            FROM estudiantes
            WHERE activo=true AND seccion_id IS NOT NULL
          ) sub
          WHERE rn > 1
        )
      `);
    } catch(e) { console.log('Dedup migration:', e.message); }

    // Migrar constraint UNIQUE de consecutivos a índice parcial (solo activos)
    // Esto permite reusar números eliminados
    try {
      await client.query(`ALTER TABLE consecutivos DROP CONSTRAINT IF EXISTS consecutivos_tipo_numero_key`);
    } catch(e) {}
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS consecutivos_tipo_numero_activo
          ON consecutivos(tipo, numero) WHERE eliminado=false
      `);
    } catch(e) {}
    // Columnas faltantes en encargados (usadas en matrícula)
    await client.query(`ALTER TABLE encargados ADD COLUMN IF NOT EXISTS nacionalidad TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE encargados ADD COLUMN IF NOT EXISTS profesion TEXT DEFAULT NULL`);

    // Retirar las restricciones antiguas de asignaciones. No se vuelven a
    // crear aquí porque todavía no contemplaban curso lectivo y podían hacer
    // fallar un reinicio después de preparar asignaciones del año siguiente.
    // Más abajo se instala la clave definitiva: subgrupo + período + año.
    await client.query(`ALTER TABLE asignaciones DROP CONSTRAINT IF EXISTS asignaciones_profesor_id_seccion_id_materia_id_key`);
    await client.query(`ALTER TABLE asignaciones DROP CONSTRAINT IF EXISTS asignaciones_unique_subgrupo`);
    await client.query(`ALTER TABLE asignaciones DROP CONSTRAINT IF EXISTS asignaciones_unique_periodo`);

    // ── PERÍODO LECTIVO en asignaciones ─────────────────────────────────────
    // Permite tener dos asignaciones distintas para el mismo profesor/sección/materia,
    // una por cada período. Las asistencias e historial del I Período quedan
    // preservadas en su asignación original.
    // Default 'I Período' para todas las existentes (que se crearon antes de esta migración).
    await client.query(`ALTER TABLE asignaciones ADD COLUMN IF NOT EXISTS periodo TEXT DEFAULT 'I Período'`);
    await client.query(`UPDATE asignaciones SET periodo='I Período' WHERE periodo IS NULL`);
    // La restricción nueva por período+año se crea después de inicializar
    // anios_lectivos y normalizar las filas heredadas.

    // ── REGISTRO DE INTERCAMBIOS Hogar↔Industriales ─────────────────────────
    // Audita cada vez que se ejecuta el intercambio en II Período, para poder
    // revertir o consultar después.
    await client.query(`
      CREATE TABLE IF NOT EXISTS intercambios_periodo (
        id            SERIAL PRIMARY KEY,
        nivel         INTEGER NOT NULL,
        seccion_id    INTEGER NOT NULL REFERENCES secciones(id),
        asig_hogar_i  INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        asig_indus_i  INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        asig_hogar_ii INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        asig_indus_ii INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        ejecutado_por INTEGER REFERENCES usuarios(id),
        revertido     BOOLEAN DEFAULT false,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);

    // Tabla genérica de flags / configuración del sistema (clave-valor).
    // Usada por procesos de migración únicos (ej: re-compresión de fotos)
    // para evitar correrlos dos veces.
    await client.query(`
      CREATE TABLE IF NOT EXISTS sistema_flags (
        codigo     TEXT PRIMARY KEY,
        valor      TEXT,
        creado_en  TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── CURSOS LECTIVOS Y CAMBIO DE AÑO SEGURO ──────────────────────
    // El año activo ya no depende del reloj del servidor. Esto permite cerrar
    // 2026 y activar 2027 incluso si el trámite se hace en enero.
    await client.query(`
      CREATE TABLE IF NOT EXISTS anios_lectivos (
        anio               INTEGER PRIMARY KEY,
        estado             TEXT NOT NULL DEFAULT 'preparacion'
                           CHECK(estado IN ('preparacion','activo','cerrado')),
        periodo_i_inicio   DATE,
        periodo_i_fin      DATE,
        periodo_ii_inicio  DATE,
        periodo_ii_fin     DATE,
        aplicado_at        TIMESTAMP,
        aplicado_por       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        created_at         TIMESTAMP DEFAULT NOW(),
        updated_at         TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cierres_anio (
        anio_destino INTEGER PRIMARY KEY,
        anio_origen  INTEGER NOT NULL,
        aplicado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        aplicado_at TIMESTAMP DEFAULT NOW(),
        resumen JSONB DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS secciones_anio (
        seccion_id INTEGER NOT NULL REFERENCES secciones(id) ON DELETE CASCADE,
        anio       INTEGER NOT NULL REFERENCES anios_lectivos(anio) ON DELETE CASCADE,
        activa     BOOLEAN NOT NULL DEFAULT true,
        PRIMARY KEY(seccion_id, anio)
      );

      CREATE TABLE IF NOT EXISTS seccion_guia_anio (
        seccion_id INTEGER NOT NULL REFERENCES secciones(id) ON DELETE CASCADE,
        anio       INTEGER NOT NULL REFERENCES anios_lectivos(anio) ON DELETE CASCADE,
        profesor_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        PRIMARY KEY(seccion_id, anio)
      );

      CREATE TABLE IF NOT EXISTS seccion_orientador_anio (
        seccion_id INTEGER NOT NULL REFERENCES secciones(id) ON DELETE CASCADE,
        anio       INTEGER NOT NULL REFERENCES anios_lectivos(anio) ON DELETE CASCADE,
        orientador_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        PRIMARY KEY(seccion_id, anio)
      );

      CREATE TABLE IF NOT EXISTS restricciones_matricula (
        id               SERIAL PRIMARY KEY,
        anio             INTEGER NOT NULL REFERENCES anios_lectivos(anio) ON DELETE CASCADE,
        estudiante_a_id  INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        estudiante_b_id  INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        motivo           TEXT NOT NULL,
        activa           BOOLEAN NOT NULL DEFAULT true,
        creada_por       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        creada_at        TIMESTAMP DEFAULT NOW(),
        eliminada_por    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        eliminada_at     TIMESTAMP,
        CHECK (estudiante_a_id < estudiante_b_id),
        UNIQUE (anio, estudiante_a_id, estudiante_b_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_restricciones_matricula_anio
      ON restricciones_matricula(anio, activa)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_restricciones_matricula_est_a
      ON restricciones_matricula(estudiante_a_id, anio) WHERE activa=true`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_restricciones_matricula_est_b
      ON restricciones_matricula(estudiante_b_id, anio) WHERE activa=true`);

    // ── SIN DERECHO A CONVOCATORIA POR AUSENTISMO ───────────────────────
    // Cada docente registra su decisión por estudiante y asignatura. Se
    // conserva una fotografía del cálculo anual que la justificó, aun si la
    // asignación se elimina al cerrar el curso lectivo.
    await client.query(`
      CREATE TABLE IF NOT EXISTS convocatoria_ausentismo (
        id                  SERIAL PRIMARY KEY,
        anio                INTEGER NOT NULL REFERENCES anios_lectivos(anio) ON DELETE RESTRICT,
        estudiante_id       INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        asignacion_id       INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        profesor_id         INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
        materia             TEXT NOT NULL,
        seccion             TEXT NOT NULL,
        ausencias           INTEGER NOT NULL DEFAULT 0,
        total_lecciones     INTEGER NOT NULL DEFAULT 0,
        porcentaje          NUMERIC(5,2) NOT NULL DEFAULT 0,
        fecha_desde         DATE NOT NULL,
        fecha_hasta         DATE NOT NULL,
        fundamento          TEXT NOT NULL,
        observaciones       TEXT DEFAULT '',
        activa              BOOLEAN NOT NULL DEFAULT true,
        marcada_at          TIMESTAMP DEFAULT NOW(),
        actualizada_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(anio, estudiante_id, asignacion_id, profesor_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conv_aus_prof
      ON convocatoria_ausentismo(anio, profesor_id, activa)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conv_aus_est
      ON convocatoria_ausentismo(anio, estudiante_id, activa)`);

    // 2026 conserva las fechas oficiales que ya utilizaba el sistema. El 2027
    // se crea en preparación y el administrador debe registrar sus fechas.
    await client.query(`
      INSERT INTO anios_lectivos
        (anio, estado, periodo_i_inicio, periodo_i_fin, periodo_ii_inicio, periodo_ii_fin)
      VALUES
        (2026, 'activo', '2026-02-23', '2026-07-03', '2026-07-20', '2026-12-09'),
        (2027, 'preparacion', NULL, NULL, NULL, NULL)
      ON CONFLICT (anio) DO NOTHING
    `);
    // Si una base futura arranca sin fila activa, activar el año calendario.
    await client.query(`
      INSERT INTO anios_lectivos (anio, estado)
      SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int, 'activo'
      WHERE NOT EXISTS (SELECT 1 FROM anios_lectivos WHERE estado='activo')
      ON CONFLICT (anio) DO UPDATE SET estado='activo'
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='anios_lectivos_un_activo')
           AND (SELECT COUNT(*) FROM anios_lectivos WHERE estado='activo') <= 1 THEN
          CREATE UNIQUE INDEX anios_lectivos_un_activo
            ON anios_lectivos ((estado)) WHERE estado='activo';
        END IF;
      END $$
    `);

    // Habilitar las secciones existentes para 2026 y 2027 sin alterar el
    // catálogo global. Desde ahora crear/eliminar en Configurar Año modifica
    // esta disponibilidad anual, no destruye la sección histórica.
    await client.query(`
      INSERT INTO secciones_anio (seccion_id, anio, activa)
      SELECT s.id, a.anio, true FROM secciones s
      CROSS JOIN (SELECT anio FROM anios_lectivos WHERE anio IN (2026, 2027)) a
      WHERE NOT EXISTS (SELECT 1 FROM secciones_anio existente WHERE existente.anio=a.anio)
      ON CONFLICT (seccion_id, anio) DO NOTHING
    `);

    // Copiar los vínculos vigentes de guía/orientación al año activo una sola vez.
    await client.query(`
      INSERT INTO seccion_guia_anio (seccion_id, anio, profesor_id)
      SELECT sg.seccion_id, al.anio, sg.profesor_id
      FROM seccion_guia sg
      CROSS JOIN LATERAL (SELECT anio FROM anios_lectivos WHERE estado='activo' LIMIT 1) al
      ON CONFLICT (seccion_id, anio) DO NOTHING
    `);
    await client.query(`
      INSERT INTO seccion_orientador_anio (seccion_id, anio, orientador_id)
      SELECT so.seccion_id, al.anio, so.orientador_id
      FROM seccion_orientador so
      CROSS JOIN LATERAL (SELECT anio FROM anios_lectivos WHERE estado='activo' LIMIT 1) al
      WHERE so.orientador_id IS NOT NULL
      ON CONFLICT (seccion_id, anio) DO NOTHING
    `);

    // Toda asignación vieja pertenece al año activo al momento de instalar
    // este parche. La clave anterior no incluía año y bloqueaba preparar 2027.
    await client.query(`
      UPDATE asignaciones SET anio=(SELECT anio FROM anios_lectivos WHERE estado='activo' LIMIT 1)
      WHERE anio IS NULL
    `);
    await client.query(`ALTER TABLE asignaciones DROP CONSTRAINT IF EXISTS asignaciones_unique_periodo`);
    // Bases antiguas pueden contener duplicados permitidos por valores NULL.
    // En ese caso no se aborta el despliegue: la API igualmente impide crear
    // nuevos duplicados y el índice se podrá crear cuando se depuren los viejos.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='asignaciones_unique_anio')
           AND NOT EXISTS (
             SELECT 1 FROM asignaciones
             GROUP BY profesor_id, seccion_id, materia_id,
               COALESCE(subgrupo,''), COALESCE(periodo,'I Período'), anio
             HAVING COUNT(*) > 1
           ) THEN
          CREATE UNIQUE INDEX asignaciones_unique_anio
            ON asignaciones (profesor_id, seccion_id, materia_id,
              COALESCE(subgrupo,''), COALESCE(periodo,'I Período'), anio);
        END IF;
      END $$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_asignaciones_anio ON asignaciones(anio)`);

    // El estado de matrícula también debe pertenecer a un año concreto.
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS completada BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'pendiente'`);
    // Convocatoria: una matrícula puede quedar en espera hasta febrero. Si
    // aprueba conserva el nivel solicitado; si reprueba vuelve al nivel que
    // cursaba, pero se le elige una sección nueva de ese nivel.
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS convocatoria BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS convocatoria_estado TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS nivel_solicitado INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS nivel_origen INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS convocatoria_resuelta_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE matricula ADD COLUMN IF NOT EXISTS convocatoria_resuelta_at TIMESTAMP DEFAULT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_matricula_convocatoria_pendiente
      ON matricula(anio, convocatoria_estado) WHERE convocatoria=true`);
    await client.query(`ALTER TABLE intercambios_periodo ADD COLUMN IF NOT EXISTS anio INTEGER`);
    await client.query(`UPDATE intercambios_periodo SET anio=2026 WHERE anio IS NULL`);

    // ── HISTORIAL DE ESTUDIANTES ──────────────────────────────────────────
    // Registra todos los movimientos importantes que afectan a un estudiante:
    // cambios de sección, de cédula, de datos personales, bajas, reactivaciones,
    // archivado, etc. Sirve como auditoría y para responder preguntas del tipo
    // "¿quién cambió esto y cuándo?".
    //
    // tipo: el tipo de evento (cambio_seccion, cambio_cedula, edicion, baja, reactivacion, archivado, cambio_subgrupo, cambio_becado)
    // valor_anterior / valor_nuevo: descripción legible de antes y después (texto, no JSON)
    // justificacion: motivo que dio el usuario que hizo el cambio (opcional)
    // usuario_id: quién hizo el cambio (NULL si fue migración o sistema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS historial_estudiante (
        id              SERIAL PRIMARY KEY,
        estudiante_id   INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        tipo            TEXT NOT NULL,
        valor_anterior  TEXT,
        valor_nuevo     TEXT,
        justificacion   TEXT,
        usuario_id      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        fecha           TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hist_est ON historial_estudiante(estudiante_id, fecha DESC)`);

    // Recuperar la sección de expedientes ya archivados a partir del historial
    // anterior, cuando todavía no existía la columna seccion_archivo.
    await client.query(`
      UPDATE estudiantes e
      SET seccion_archivo = (
        SELECT NULLIF(
          REGEXP_REPLACE(he.valor_anterior, '^Activo en\\s*', '', 'i'),
          'sin sección'
        )
        FROM historial_estudiante he
        WHERE he.estudiante_id = e.id
          AND he.tipo = 'archivado'
          AND he.valor_anterior ILIKE 'Activo en %'
        ORDER BY he.fecha DESC
        LIMIT 1
      )
      WHERE e.archivado = true
        AND NULLIF(TRIM(e.seccion_archivo), '') IS NULL
        AND EXISTS (
          SELECT 1 FROM historial_estudiante he
          WHERE he.estudiante_id = e.id
            AND he.tipo = 'archivado'
            AND he.valor_anterior ILIKE 'Activo en %'
        )
    `);

    // Migración inicial: importar movimientos antiguos.
    // Si un estudiante tiene una justificación de cambio de sección guardada en
    // la columna justificacion_cambio_seccion (esquema viejo), crear una entrada
    // histórica. Solo se hace una vez (controlado por sistema_flags).
    try {
      const ya = await client.query("SELECT 1 FROM sistema_flags WHERE codigo='HIST_MIGRACION_INICIAL'");
      if (!ya.rows.length) {
        // Verificar si la columna existe (puede no existir en instalaciones nuevas)
        const colExiste = await client.query(`
          SELECT 1 FROM information_schema.columns
          WHERE table_name='estudiantes' AND column_name='justificacion_cambio_seccion'
        `);
        if (colExiste.rows.length) {
          await client.query(`
            INSERT INTO historial_estudiante (estudiante_id, tipo, valor_anterior, valor_nuevo, justificacion, fecha)
            SELECT e.id, 'cambio_seccion',
                   '(no registrado)',
                   COALESCE(s.nombre, '(sin sección)'),
                   e.justificacion_cambio_seccion,
                   NOW() - INTERVAL '1 year'  -- fecha aproximada (no la conocemos)
            FROM estudiantes e
            LEFT JOIN secciones s ON s.id = e.seccion_id
            WHERE e.justificacion_cambio_seccion IS NOT NULL
              AND e.justificacion_cambio_seccion <> ''
          `);
        }
        await client.query(
          "INSERT INTO sistema_flags (codigo, valor) VALUES ('HIST_MIGRACION_INICIAL', $1)",
          [`Ejecutada en ${new Date().toISOString()}`]
        );
        console.log("✅ Historial: migración inicial completada");
      }
    } catch (e) {
      console.error("Historial migración inicial:", e.message);
    }

    // ── MÓDULO DE DEBIDOS PROCESOS ────────────────────────────────────────
    // Procedimiento correctivo según REAC art. 144. Cada proceso tiene
    // múltiples pasos (acta apertura, citas, declaraciones, acta sesión,
    // traslado de cargos, resolución final o desestima).
    //
    // Estado del proceso:
    //   - 'en_curso': se están registrando pasos
    //   - 'desestimado': cerrado sin sanción tras paso 8 con decisión desestimar
    //   - 'resuelto': cerrado con resolución final tras pasos 9 y 10
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS debidos_procesos (
          id              SERIAL PRIMARY KEY,
          consecutivo_id  INTEGER REFERENCES consecutivos(id) ON DELETE SET NULL,
          numero          INTEGER NOT NULL,
          anio            INTEGER NOT NULL,
          estudiante_id   INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
          iniciado_por    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          guia_a_cargo    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          orientador_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          estado          TEXT NOT NULL DEFAULT 'en_curso',
          decision_sesion TEXT,
          created_at      TIMESTAMP DEFAULT NOW(),
          updated_at      TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dp_est ON debidos_procesos(estudiante_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dp_estado ON debidos_procesos(estado)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dp_guia ON debidos_procesos(guia_a_cargo)`);

      // Migración aditiva: guía sustituto. Cuando está presente, reemplaza al
      // guía original en todas las validaciones de permisos del proceso.
      // Si se pone NULL, el guía original vuelve a tomar el caso.
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS guia_sustituto_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);

      // ── OFENDIDO DOCENTE ────────────────────────────────────────────
      // El denunciado siempre es estudiante, pero la víctima/ofendido a
      // veces es un docente del centro (caso menos común). En ese caso
      // hay que adaptar los formularios para no hablar de "representante
      // legal" ni de "sección". Por defecto es estudiante.
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS ofendido_tipo TEXT DEFAULT 'estudiante'`);
      // Si el ofendido es docente registrado en el sistema, lo enlazamos.
      // Si es docente externo o no está en el sistema, igual permitimos
      // guardar nombre+cédula sueltos en las columnas snapshot de abajo.
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS ofendido_docente_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS ofendido_docente_nombre TEXT`);
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS ofendido_docente_cedula TEXT`);

      // ── ARCHIVAR PROCESO ────────────────────────────────────────────
      // Un proceso CERRADO (resuelto/desestimado) puede ser archivado para
      // sacarlo de la vista activa. Flujo:
      //   1) Profe/admin solicita archivo → estado='pendiente_archivo'
      //   2) Orientador aprueba → estado='archivado'
      //      O rechaza → vuelve al estado anterior
      // El motivo más común: el denunciante cambió de decisión.
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS estado_previo_archivo TEXT`);
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS archivo_solicitado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS archivo_solicitado_en TIMESTAMP`);
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS archivo_motivo TEXT`);
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS archivo_aprobado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS archivo_aprobado_en TIMESTAMP`);
      await client.query(`ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS archivo_decision_orientador TEXT`);

      console.log("✅ DP: tabla debidos_procesos lista");

      await client.query(`
        CREATE TABLE IF NOT EXISTS dp_pasos (
          id             SERIAL PRIMARY KEY,
          proceso_id     INTEGER NOT NULL REFERENCES debidos_procesos(id) ON DELETE CASCADE,
          tipo           TEXT NOT NULL,
          orden          INTEGER NOT NULL DEFAULT 1,
          completado     BOOLEAN DEFAULT false,
          completado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          completado_en  TIMESTAMP,
          verificado     BOOLEAN DEFAULT false,
          verificado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          verificado_en  TIMESTAMP,
          asignado_a     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          contenido      JSONB DEFAULT '{}'::jsonb,
          created_at     TIMESTAMP DEFAULT NOW(),
          updated_at     TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dpp_proceso ON dp_pasos(proceso_id, orden)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dpp_asignado ON dp_pasos(asignado_a) WHERE asignado_a IS NOT NULL`);
      console.log("✅ DP: tabla dp_pasos lista");

      await client.query(`
        CREATE TABLE IF NOT EXISTS dp_testigos (
          id              SERIAL PRIMARY KEY,
          proceso_id      INTEGER NOT NULL REFERENCES debidos_procesos(id) ON DELETE CASCADE,
          estudiante_id   INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
          paso_cita_id    INTEGER REFERENCES dp_pasos(id) ON DELETE SET NULL,
          paso_decl_id    INTEGER REFERENCES dp_pasos(id) ON DELETE SET NULL,
          agregado_en     TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dpt_proceso ON dp_testigos(proceso_id)`);
      console.log("✅ DP: tabla dp_testigos lista");

      // Ofendidos (víctimas) — pueden ser varios estudiantes. Se maneja igual
      // que los testigos: se agregan uno a uno buscando por cédula. El paso
      // cita_ofendido / decl_ofendido se replica N veces (uno por cada ofendido).
      await client.query(`
        CREATE TABLE IF NOT EXISTS dp_ofendidos (
          id              SERIAL PRIMARY KEY,
          proceso_id      INTEGER NOT NULL REFERENCES debidos_procesos(id) ON DELETE CASCADE,
          estudiante_id   INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
          paso_cita_id    INTEGER REFERENCES dp_pasos(id) ON DELETE SET NULL,
          paso_decl_id    INTEGER REFERENCES dp_pasos(id) ON DELETE SET NULL,
          agregado_en     TIMESTAMP DEFAULT NOW(),
          UNIQUE(proceso_id, estudiante_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dpo_proceso ON dp_ofendidos(proceso_id)`);
      console.log("✅ DP: tabla dp_ofendidos lista");

      await client.query(`
        CREATE TABLE IF NOT EXISTS dp_aprobaciones_orientador (
          id              SERIAL PRIMARY KEY,
          proceso_id      INTEGER NOT NULL REFERENCES debidos_procesos(id) ON DELETE CASCADE,
          paso_id         INTEGER NOT NULL REFERENCES dp_pasos(id) ON DELETE CASCADE,
          orientador_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          decision        TEXT NOT NULL,
          observacion     TEXT,
          fecha           TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dpao_proceso ON dp_aprobaciones_orientador(proceso_id)`);
      console.log("✅ DP: tabla dp_aprobaciones_orientador lista");

      await client.query(`
        CREATE TABLE IF NOT EXISTS dp_historial_cambios (
          id              SERIAL PRIMARY KEY,
          paso_id         INTEGER NOT NULL REFERENCES dp_pasos(id) ON DELETE CASCADE,
          proceso_id      INTEGER NOT NULL REFERENCES debidos_procesos(id) ON DELETE CASCADE,
          usuario_id      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          accion          TEXT NOT NULL,
          fecha           TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dphc_proceso ON dp_historial_cambios(proceso_id, fecha DESC)`);
      console.log("✅ DP: tabla dp_historial_cambios lista");

      console.log("✅ Tablas de Debidos Procesos listas");
    } catch (errDP) {
      console.error("❌❌❌ ERROR CREANDO TABLAS DEBIDOS PROCESOS ❌❌❌");
      console.error("   Código:", errDP.code);
      console.error("   Mensaje:", errDP.message);
      console.error("   Detail:", errDP.detail || '(sin detalle)');
      console.error("   Hint:", errDP.hint || '(sin hint)');
      throw errDP; // Forzar que initDB falle ruidosamente para diagnosticar
    }


    // ── MÓDULO DE PROTOCOLOS (Pautas MEP) ─────────────────────────────────
    // Cada protocolo activa una de las 9 Pautas y genera un expediente con
    // los formularios oficiales correspondientes a esa pauta. Los formularios
    // van en orden secuencial pero se pueden marcar como "no aplica" si la
    // situación no lo requiere.
    //
    // Estado:
    //   - 'activo': se están llenando los formularios
    //   - 'cerrado': expediente cerrado tras todos los formularios necesarios
    try {
      // Configuración del centro educativo (solo 1 fila, configurable por admin)
      // Se usa para auto-rellenar los formularios oficiales del MEP.
      await client.query(`
        CREATE TABLE IF NOT EXISTS config_centro (
          id                    SERIAL PRIMARY KEY,
          nombre_centro         TEXT,
          codigo_presupuestario TEXT,
          circuito_escolar      TEXT,
          dre                   TEXT,
          telefono              TEXT,
          correo                TEXT,
          direccion             TEXT,
          director_nombre       TEXT,
          director_cedula       TEXT,
          updated_at            TIMESTAMP DEFAULT NOW(),
          updated_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
        )
      `);
      // Insertar fila inicial con datos por defecto si la tabla está vacía
      const cfg = await client.query("SELECT COUNT(*)::int AS n FROM config_centro");
      if (cfg.rows[0].n === 0) {
        await client.query(`
          INSERT INTO config_centro (nombre_centro, circuito_escolar, dre, direccion)
          VALUES ('Liceo de Calle Fallas', '07', 'Desamparados',
                  'San José, Desamparados, 1 Km al sur del Centro Comercial Multicentro de Desamparados')
        `);
      }
      console.log("✅ Protocolos: tabla config_centro lista");

      // Tabla principal del protocolo
      await client.query(`
        CREATE TABLE IF NOT EXISTS protocolos (
          id              SERIAL PRIMARY KEY,
          consecutivo_id  INTEGER REFERENCES consecutivos(id) ON DELETE SET NULL,
          numero          INTEGER NOT NULL,
          anio            INTEGER NOT NULL,
          pauta           INTEGER NOT NULL,
          iniciado_por    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          orientador_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          estado          TEXT NOT NULL DEFAULT 'activo',
          fecha_cierre    TIMESTAMP,
          created_at      TIMESTAMP DEFAULT NOW(),
          updated_at      TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_prot_estado ON protocolos(estado)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_prot_pauta ON protocolos(pauta)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_prot_iniciado ON protocolos(iniciado_por)`);
      console.log("✅ Protocolos: tabla protocolos lista");

      // Formularios del protocolo. Cada protocolo genera N filas (una por
      // formulario de la pauta). Estado: 'pendiente', 'completado', 'no_aplica'.
      // tipo: 'F1', 'F2', 'F3', ..., 'F12'
      await client.query(`
        CREATE TABLE IF NOT EXISTS protocolo_formularios (
          id              SERIAL PRIMARY KEY,
          protocolo_id    INTEGER NOT NULL REFERENCES protocolos(id) ON DELETE CASCADE,
          tipo            TEXT NOT NULL,
          orden           INTEGER NOT NULL DEFAULT 1,
          estado          TEXT NOT NULL DEFAULT 'pendiente',
          contenido       JSONB DEFAULT '{}'::jsonb,
          completado_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          completado_en   TIMESTAMP,
          created_at      TIMESTAMP DEFAULT NOW(),
          updated_at      TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pf_proto ON protocolo_formularios(protocolo_id, orden)`);
      console.log("✅ Protocolos: tabla protocolo_formularios lista");

      // Personas vinculadas al protocolo. Pueden ser estudiantes registrados
      // (estudiante_id NOT NULL) o externos (datos cargados a mano).
      // rol: 'afectado', 'ofensor', 'observador', 'externo'
      await client.query(`
        CREATE TABLE IF NOT EXISTS protocolo_personas (
          id              SERIAL PRIMARY KEY,
          protocolo_id    INTEGER NOT NULL REFERENCES protocolos(id) ON DELETE CASCADE,
          estudiante_id   INTEGER REFERENCES estudiantes(id) ON DELETE SET NULL,
          es_externo      BOOLEAN DEFAULT false,
          es_mayor_edad   BOOLEAN DEFAULT false,
          rol             TEXT NOT NULL,
          nombre_completo TEXT,
          cedula          TEXT,
          edad            INTEGER,
          seccion         TEXT,
          fecha_nacimiento DATE,
          telefono        TEXT,
          correo          TEXT,
          direccion       TEXT,
          encargado_nombre TEXT,
          encargado_cedula TEXT,
          encargado_telef  TEXT,
          notas           TEXT,
          created_at      TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pp_proto ON protocolo_personas(protocolo_id)`);
      console.log("✅ Protocolos: tabla protocolo_personas lista");

      console.log("✅ Tablas de Protocolos listas");
    } catch (errPR) {
      console.error("❌❌❌ ERROR CREANDO TABLAS PROTOCOLOS ❌❌❌");
      console.error("   Código:", errPR.code);
      console.error("   Mensaje:", errPR.message);
      console.error("   Detail:", errPR.detail || '(sin detalle)');
      throw errPR;
    }

    // ── MINUTAS ─────────────────────────────────────────────────────────
    // Hoja para Minutas LCF: registro de reuniones internas (consejo de
    // profesores, reuniones de comité, reuniones de orientación, etc).
    // Cualquier persona del personal puede crear una minuta. Lleva
    // consecutivo MIN-NNN-AAAA usando el mismo sistema de consecutivos.
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS minutas (
          id               SERIAL PRIMARY KEY,
          consecutivo_id   INTEGER REFERENCES consecutivos(id) ON DELETE SET NULL,
          numero           INTEGER NOT NULL,
          anio             INTEGER NOT NULL,
          iniciada_por     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          tipo_reunion     TEXT NOT NULL DEFAULT 'presencial' CHECK(tipo_reunion IN ('presencial','virtual')),
          plataforma       TEXT DEFAULT '',
          dependencia      TEXT DEFAULT 'Liceo de Calle Fallas',
          lugar            TEXT DEFAULT '',
          fecha_reunion    DATE,
          hora_inicio      TEXT DEFAULT '',
          hora_fin         TEXT DEFAULT '',
          tema             TEXT DEFAULT '',
          elaborada_por    TEXT DEFAULT '',
          temas_tratados   TEXT DEFAULT '',
          acuerdos         TEXT DEFAULT '',
          estado           TEXT NOT NULL DEFAULT 'en_curso' CHECK(estado IN ('en_curso','finalizada')),
          created_at       TIMESTAMP DEFAULT NOW(),
          updated_at       TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_minutas_estado ON minutas(estado)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_minutas_anio ON minutas(anio)`);

      // Asistentes a la minuta: presentes y ausentes.
      // - Si es del sistema, usuario_id != null y heredamos nombre/puesto desde usuarios.
      // - Si es externo, usuario_id = null y se llena nombre+puesto manualmente.
      // - Para ausentes: justificacion = 'justificado' | 'injustificado' | NULL (en presentes no aplica).
      // - firma = TRUE solo si firmó en la impresión / al cerrar la minuta.
      await client.query(`
        CREATE TABLE IF NOT EXISTS minuta_asistentes (
          id              SERIAL PRIMARY KEY,
          minuta_id       INTEGER NOT NULL REFERENCES minutas(id) ON DELETE CASCADE,
          usuario_id      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          nombre          TEXT NOT NULL,
          puesto          TEXT DEFAULT '',
          tipo            TEXT NOT NULL CHECK(tipo IN ('presente','ausente')),
          justificacion   TEXT,
          orden           INTEGER DEFAULT 0,
          created_at      TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_minasis_minuta ON minuta_asistentes(minuta_id)`);

      // Auditoría de accesos de admin/administrativo a minutas ajenas.
      // Se registra:
      //  - accion = 'ver'       → cuando abren el detalle
      //  - accion = 'reabrir'   → cuando reabren una minuta finalizada
      // La reapertura requiere justificación escrita obligatoria.
      await client.query(`
        CREATE TABLE IF NOT EXISTS minuta_accesos_admin (
          id           SERIAL PRIMARY KEY,
          minuta_id    INTEGER NOT NULL REFERENCES minutas(id) ON DELETE CASCADE,
          usuario_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          accion       TEXT NOT NULL CHECK(accion IN ('ver','reabrir')),
          justificacion TEXT,
          fecha        TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_min_acc_minuta ON minuta_accesos_admin(minuta_id)`);

      console.log("✅ Tablas de Minutas listas");
    } catch (errMin) {
      console.error("❌❌❌ ERROR CREANDO TABLAS MINUTAS ❌❌❌");
      console.error("   Código:", errMin.code);
      console.error("   Mensaje:", errMin.message);
      throw errMin;
    }


    // ── CATÁLOGO REAC: artículos e incisos ────────────────────────────────
    // Sembrado oficial de los artículos del Reglamento de Evaluación de los
    // Aprendizajes que se referencian en los Debidos Procesos.
    //
    // Categorías:
    //   - 'falta'           → Art. 140 (graves), 141 (muy graves), 142 (gravísimas)
    //   - 'accion_correctiva' → Art. 150 (graves), 151 (muy graves), 152 (gravísimas)
    //   - 'rebajo_puntos'   → Art. 166 (escala de puntos según gravedad)
    //
    // Solo se incluyen las gravedades aplicables al Debido Proceso (graves+).
    // Las leves y muy leves no requieren DP así que no se incluyen.
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS reac_catalogo (
          id          SERIAL PRIMARY KEY,
          categoria   TEXT NOT NULL,
          articulo    INTEGER NOT NULL,
          inciso      TEXT NOT NULL,
          gravedad    TEXT,
          puntos      INTEGER,
          descripcion TEXT NOT NULL,
          activo      BOOLEAN DEFAULT true,
          UNIQUE(categoria, articulo, inciso)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_reac_cat ON reac_catalogo(categoria, articulo)`);

      // Verificar si ya está poblado.
      // ⚠️ MIGRACIÓN REAC 2025 → 2026: los artículos cambiaron de número:
      //   140 (graves)     → 155
      //   141 (muy graves) → 156
      //   142 (gravísimas) → 157
      //   143 (rebajo puntos por gravedad)
      // Detectamos si el catálogo está con los artículos viejos y lo migramos
      // borrando todo lo del REAC viejo y resembrando con el nuevo.
      const existe = await client.query("SELECT COUNT(*)::int AS n FROM reac_catalogo");
      const tieneViejo = await client.query(
        "SELECT COUNT(*)::int AS n FROM reac_catalogo WHERE articulo IN (140,141,142,150,151,152,166)"
      );
      const necesitaSembrar = existe.rows[0].n === 0;
      const necesitaMigrar  = tieneViejo.rows[0].n > 0;
      if (necesitaMigrar) {
        // Borramos TODO el catálogo viejo. Los procesos disciplinarios ya
        // creados guardan su texto en otra tabla, no se ven afectados.
        await client.query("DELETE FROM reac_catalogo WHERE articulo IN (140,141,142,150,151,152,166)");
        console.log("🔄 Catálogo REAC migrado: eliminados artículos del REAC 2025");
      }
      if (necesitaSembrar || necesitaMigrar) {
        // ─── REAC 2026 ────────────────────────────────────────────────────
        // Artículo 143: rebajos por gravedad de falta
        //   - muy leve = 5 pts
        //   - leve     = 10 pts
        //   - grave    = 20 pts
        //   - muy grave= 30 pts
        //   - gravísima= 50 pts
        // Solo incluimos gravedades aplicables al Debido Proceso (graves+)

        // ART. 155 — FALTAS GRAVES (20 puntos)
        const art155 = [
          ['a','Daño contra los bienes del centro educativo relacionados con el ornato, equipo tecnológico, herramientas, mobiliario, infraestructura o cualquier otro activo del centro educativo. Así como daños ocasionados a los bienes del personal o demás miembros de la comunidad educativa, bienes a terceros, así como a los vehículos usados para el transporte de estudiantes, ya sea que esta acción se realice en forma individual o en grupo.'],
          ['b','Sustracción de bienes del centro educativo o bienes personales de los miembros de la comunidad educativa.'],
          ['c','Uso sin consentimiento de las pertenencias de personas integrantes de la comunidad educativa.'],
          ['d','Uso del lenguaje vulgar o soez, así como el trato o los hechos irrespetuosos dichos o cometidos en contra del director o la directora, personal docente, las personas estudiantes, encargados legales de la persona estudiante y otros miembros de la comunidad educativa.'],
          ['e','Colocar letreros, dibujos o gráficos no autorizados en la infraestructura, mobiliario u otros bienes del centro educativo.'],
          ['f','Alterar, falsificar o plagiar pruebas o cualquier otro tipo de trabajo académico con el que se deba cumplir como parte de su proceso educativo, sean estos realizados en beneficio propio o de otros estudiantes.'],
          ['g','Sustraer, reproducir, distribuir o divulgar las pruebas antes de su aplicación.'],
          ['h','Portar, consumir, fumar o vapear cigarrillos, sistemas electrónicos de administración de nicotina (SEAN), sistemas similares sin nicotina (SSSN) y dispositivos electrónicos que utilizan tabaco calentado y tecnologías similares.'],
          ['i','Portar o ingerir bebidas con contenido alcohólico.'],
          ['j','Ingresar al centro educativo en estado de ebriedad o bajo signos de ingesta de bebidas alcohólicas u otras sustancias psicoactivas.'],
          ['k','Uso de dispositivos móviles u otros medios tecnológicos que interfieran en el proceso de aprendizaje en espacios educativos sin autorización de la persona docente.'],
          ['l','Otras faltas que se consideren como graves según la normativa interna del centro educativo y que no se encuentren valoradas como muy leves, leves, muy graves o gravísimas en este reglamento.'],
        ];
        for (const [inc, desc] of art155) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, puntos, descripcion) VALUES ('falta', 155, $1, 'grave', 20, $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ART. 156 — FALTAS MUY GRAVES (30 puntos)
        const art156 = [
          ['a','Incentivar o participar en la escenificación pública de conductas que atenten contra la dignidad, seguridad, integridad de cualquier persona.'],
          ['b','Impedir que otros miembros de la comunidad educativa participen en el normal desarrollo de las actividades regulares del centro educativo, así como incitar a otros a que actúen con idénticos propósitos, entre los que se contempla el cierre del centro educativo.'],
          ['c','Incitación a los compañeros a que participen en acciones que perjudiquen la salud, seguridad individual o colectiva.'],
          ['d','Portar armas, explosivos, objetos o sustancias peligrosas que pongan en peligro la integridad y seguridad de algún miembro de la comunidad educativa. Además, el uso inadecuado de materiales diseñados para fines didácticos con otros propósitos diferentes que constituyan un riesgo.'],
          ['e','Cualquier tipo de acción discriminatoria asociadas a género, edad, raza u origen étnico o nacional, condición socioeconómica o cualquier otra que viole la dignidad humana, incluidas aquellas realizadas mediante mecanismos o dispositivos tecnológicos.'],
          ['f','Realizar, grabar, distribuir o ser cómplice en actos de violencia en todas sus manifestaciones incluido: el bullying o acoso, violencia psicológica y violencia material entre estudiantes dentro del centro educativo. Estas conductas incluyen, pero no se limitan a la utilización de dispositivos electrónicos para registrar y difundir actos de agresión presencial o cibernética.'],
          ['g','Sustracción, alteración o falsificación de documentos oficiales.'],
          ['h','Otras faltas que se consideren como muy graves según la normativa interna del centro educativo y que no se encuentren valoradas como graves en este reglamento.'],
        ];
        for (const [inc, desc] of art156) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, puntos, descripcion) VALUES ('falta', 156, $1, 'muy_grave', 30, $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ART. 157 — FALTAS GRAVÍSIMAS (50 puntos)
        const art157 = [
          ['a','Agresión física contra cualquier miembro de la comunidad educativa, entiéndase, el o la directora, el personal, de las personas estudiantes o las personas encargadas legales de las personas estudiantes.'],
          ['b','Tenencia, difusión, distribución o comercio de imágenes o videos con contenidos de índole sexual, acoso, violencias en línea, acciones de contenido sexual, material de naturaleza acosadora, física o haciendo uso de herramientas tecnológicas como la Inteligencia Artificial que atente o viole la dignidad, seguridad e integridad humana.'],
          ['c','Ingestión reiterada de bebidas alcohólicas.'],
          ['d','Consumir o portar sustancias psicoactivas dentro del centro educativo, en actividades convocadas oficialmente o en cualquier otra de las circunstancias descritas en el artículo 148 de este reglamento.'],
          ['e','Distribuir, inducir o facilitar el uso de cualquier tipo de sustancias psicoactivas dentro del centro educativo, en actividades oficialmente convocadas o en cualesquiera de las circunstancias señaladas en el artículo 148 de este reglamento.'],
          ['f','Infringir daño en cualquiera de las diferentes manifestaciones de violencia incluido el bullying, acoso, por medio de comportamientos o conductas repetidas y abusivas con la intención de agredir a una o varias personas estudiantes de manera presencial o utilizando las tecnologías de la Información y la Comunicación (TIC) (Ciberbullying).'],
          ['g','Otras faltas que se consideren como gravísimas según la normativa interna del centro educativo.'],
        ];
        for (const [inc, desc] of art157) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, puntos, descripcion) VALUES ('falta', 157, $1, 'gravisima', 50, $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ACCIONES CORRECTIVAS POR FALTAS GRAVES (art. 155)
        // El REAC 2026 establece las acciones directamente en el mismo
        // artículo de la falta. Las agrupamos como categoría aparte para
        // que aparezcan en el select correspondiente.
        const accGraves = [
          ['a','Traslado de la persona estudiante a otra sección, en aquellos ciclos, ofertas o modalidades que así lo permitan.'],
          ['b','Reparación de la ofensa verbal o moral a las personas, grupos internos o externos al centro educativo, mediante la oportuna retractación pública y las disculpas que correspondan, sin perjuicio de su integridad moral o física.'],
          ['c','Reparación o reposición del material o equipo que hubiera dañado.'],
          ['d','Inasistencia al centro educativo por un período de quince días naturales (aplicable a faltas incisos g, h, i, j del artículo 155).'],
        ];
        for (const [inc, desc] of accGraves) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, descripcion) VALUES ('accion_correctiva', 155, $1, 'grave', $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ACCIONES CORRECTIVAS POR FALTAS MUY GRAVES (art. 156)
        const accMuyGraves = [
          ['a','Inasistencia al centro educativo por un período de veinte días naturales.'],
          ['b','Obligación de reparar, de manera verificable, el daño material, moral o personal causado a las personas, grupos o al centro educativo.'],
          ['c','Realización de acciones con carácter educativo y de interés institucional o comunal, verificables y proporcionales a la falta cometida.'],
        ];
        for (const [inc, desc] of accMuyGraves) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, descripcion) VALUES ('accion_correctiva', 156, $1, 'muy_grave', $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ACCIONES CORRECTIVAS POR FALTAS GRAVÍSIMAS (art. 157)
        const accGravisimas = [
          ['a','Inasistencia al centro educativo por un período de treinta días naturales.'],
          ['b','Obligación de reparar, de manera verificable, el daño material, moral o personal causado a personas, grupos o al centro educativo.'],
          ['c','Realización de acciones con carácter educativo y de interés institucional o comunal, verificables y proporcionales a la falta cometida.'],
        ];
        for (const [inc, desc] of accGravisimas) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, descripcion) VALUES ('accion_correctiva', 157, $1, 'gravisima', $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // REBAJO DE PUNTOS DE CONDUCTA — Artículo 143 REAC 2026
        // El artículo 143 establece los rebajos según la gravedad:
        //   - muy leve = 5 puntos    (no aplica DP)
        //   - leve     = 10 puntos   (no aplica DP)
        //   - grave    = 20 puntos
        //   - muy grave= 30 puntos
        //   - gravísima= 50 puntos
        const rebajos = [
          ['a', 'grave',     20, 'Rebajo de veinte (20) puntos de la nota de conducta por falta grave (art. 143 REAC).'],
          ['b', 'muy_grave', 30, 'Rebajo de treinta (30) puntos de la nota de conducta por falta muy grave (art. 143 REAC).'],
          ['c', 'gravisima', 50, 'Rebajo de cincuenta (50) puntos de la nota de conducta por falta gravísima (art. 143 REAC).'],
        ];
        for (const [inc, grav, pts, desc] of rebajos) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, puntos, descripcion) VALUES ('rebajo_puntos', 143, $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [inc, grav, pts, desc]);
        }

        console.log(necesitaMigrar
          ? "✅ Catálogo REAC 2026 sembrado (migrado desde REAC 2025)"
          : "✅ Catálogo REAC 2026 sembrado");
      } else {
        console.log(`✅ Catálogo REAC 2026 ya estaba poblado (${existe.rows[0].n} incisos)`);
      }
    } catch (errCAT) {
      console.error("⚠️ Error sembrando catálogo REAC:", errCAT.message);
      // No re-lanzo: el sistema sigue funcionando aunque no haya catálogo
    }


    // ── MÓDULO DE INVENTARIO ──────────────────────────────────────────────
    // Sistema de control de inventarios para la Junta Administrativa.
    // - inv_productos: catálogo (código único, stock actual, stock mínimo)
    // - inv_entradas: registros de ingreso (suma al stock)
    // - inv_salidas: encabezado con persona que retira (referencia a usuarios)
    // - inv_salidas_detalle: cada producto retirado en esa salida
    // - inv_config: configuración (nombre de encargado, etc)
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS inv_productos (
          id            SERIAL PRIMARY KEY,
          codigo        TEXT UNIQUE NOT NULL,
          nombre        TEXT NOT NULL,
          descripcion   TEXT DEFAULT '',
          categoria     TEXT DEFAULT 'General',
          unidad        TEXT DEFAULT 'Unidad',
          stock_actual  INTEGER NOT NULL DEFAULT 0,
          stock_minimo  INTEGER NOT NULL DEFAULT 0,
          activo        BOOLEAN DEFAULT true,
          created_at    TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log("✅ Inventario: tabla inv_productos lista");

      await client.query(`
        CREATE TABLE IF NOT EXISTS inv_entradas (
          id            SERIAL PRIMARY KEY,
          producto_id   INTEGER NOT NULL REFERENCES inv_productos(id),
          cantidad      INTEGER NOT NULL CHECK(cantidad > 0),
          proveedor     TEXT DEFAULT '',
          observaciones TEXT DEFAULT '',
          registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          fecha         DATE DEFAULT CURRENT_DATE,
          created_at    TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log("✅ Inventario: tabla inv_entradas lista");

      await client.query(`
        CREATE TABLE IF NOT EXISTS inv_salidas (
          id              SERIAL PRIMARY KEY,
          usuario_retira  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          persona_nombre  TEXT NOT NULL,
          persona_cedula  TEXT DEFAULT '',
          departamento    TEXT DEFAULT '',
          motivo          TEXT DEFAULT '',
          fecha           DATE NOT NULL,
          hora            TEXT NOT NULL,
          registrado_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
          created_at      TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log("✅ Inventario: tabla inv_salidas lista");

      await client.query(`
        CREATE TABLE IF NOT EXISTS inv_salidas_detalle (
          id          SERIAL PRIMARY KEY,
          salida_id   INTEGER NOT NULL REFERENCES inv_salidas(id) ON DELETE CASCADE,
          producto_id INTEGER NOT NULL REFERENCES inv_productos(id),
          cantidad    INTEGER NOT NULL CHECK(cantidad > 0)
        )
      `);
      console.log("✅ Inventario: tabla inv_salidas_detalle lista");

      // Migración aditiva: columna serial_id en detalle de salidas (opcional).
      // Cuando una salida lleva un serial específico, queda enlazado para ver
      // en el historial qué serie físicamente se entregó.
      await client.query(`ALTER TABLE inv_salidas_detalle ADD COLUMN IF NOT EXISTS serial_id INTEGER`);

      // ── inv_seriales: registro individual de cada unidad serializada ──
      // Un producto puede tener 0..N seriales. El campo es opcional —
      // productos como "lapiceros" no necesitan, pero "impresoras" sí.
      // estado: 'disponible' (en bodega) / 'entregado' (salió, link a salida).
      await client.query(`
        CREATE TABLE IF NOT EXISTS inv_seriales (
          id           SERIAL PRIMARY KEY,
          producto_id  INTEGER NOT NULL REFERENCES inv_productos(id) ON DELETE CASCADE,
          serial       TEXT NOT NULL,
          notas        TEXT DEFAULT '',
          estado       TEXT NOT NULL DEFAULT 'disponible' CHECK(estado IN ('disponible','entregado')),
          entrada_id   INTEGER REFERENCES inv_entradas(id) ON DELETE SET NULL,
          salida_id    INTEGER REFERENCES inv_salidas(id) ON DELETE SET NULL,
          created_at   TIMESTAMP DEFAULT NOW(),
          UNIQUE(producto_id, serial)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_seriales_prod ON inv_seriales(producto_id, estado)`);
      console.log("✅ Inventario: tabla inv_seriales lista");

      await client.query(`
        CREATE TABLE IF NOT EXISTS inv_config (
          clave TEXT PRIMARY KEY,
          valor TEXT NOT NULL
        )
      `);
      // Sembrar config inicial si no existe
      await client.query(`
        INSERT INTO inv_config (clave, valor)
        VALUES ('encargado_entradas', 'Encargado de Bodega')
        ON CONFLICT (clave) DO NOTHING
      `);
      console.log("✅ Inventario: tabla inv_config lista");

      console.log("✅ Tablas de Inventario listas");
    } catch (errINV) {
      console.error("❌❌❌ ERROR CREANDO TABLAS INVENTARIO ❌❌❌");
      console.error("   Código:", errINV.code);
      console.error("   Mensaje:", errINV.message);
      throw errINV;
    }


    // ── MÓDULO DE CALIFICACIONES ──────────────────────────────────────────
    // Catálogo OFICIAL de evaluación según el REAC 2026 (porcentajes fijos).
    // No es editable por el profesor — solo informativo. Los porcentajes los
    // define el MEP. Si el REAC cambia en años futuros, se actualiza acá.
    //
    // Cada regla aplica a un rango de niveles (nivel_min..nivel_max) y a una
    // lista de nombres de materia. El sistema busca la regla por (materia, nivel).
    //
    // IMPORTANTE: se elimina la tabla anterior configuracion_calificacion que
    // permitía configurar % manualmente — el REAC no permite eso. Si tenía
    // datos, se descartan (Fase 1 estaba en pruebas).
    await client.query(`DROP TABLE IF EXISTS configuracion_calificacion CASCADE`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS materia_evaluacion_oficial (
        id                  SERIAL PRIMARY KEY,
        codigo              TEXT UNIQUE NOT NULL,
        descripcion         TEXT NOT NULL,
        nivel_min           INTEGER NOT NULL,
        nivel_max           INTEGER NOT NULL,
        porc_cotidiano      NUMERIC(5,2) NOT NULL DEFAULT 0,
        porc_tareas         NUMERIC(5,2) NOT NULL DEFAULT 0,
        porc_pruebas        NUMERIC(5,2) NOT NULL DEFAULT 0,
        porc_proyectos      NUMERIC(5,2) NOT NULL DEFAULT 0,
        porc_asistencia     NUMERIC(5,2) NOT NULL DEFAULT 0,
        cantidad_pruebas    INTEGER DEFAULT 0,
        cantidad_proyectos  INTEGER DEFAULT 0,
        proyecto_o_prueba   BOOLEAN DEFAULT false,
        notas               TEXT
      )
    `);

    // Tabla puente: qué materias del catálogo `materias` usan cada regla.
    // Esto permite agregar/quitar materias sin modificar la regla.
    await client.query(`
      CREATE TABLE IF NOT EXISTS materia_regla_evaluacion (
        id           SERIAL PRIMARY KEY,
        materia_id   INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
        regla_id     INTEGER NOT NULL REFERENCES materia_evaluacion_oficial(id) ON DELETE CASCADE,
        nivel_min    INTEGER NOT NULL,
        nivel_max    INTEGER NOT NULL,
        UNIQUE(materia_id, nivel_min, nivel_max)
      )
    `);

    // Sembrar reglas oficiales REAC 2026 (idempotente: ON CONFLICT DO NOTHING)
    const reglas = [
      // 7°-9°
      { cod:'acad_7_9',     desc:'Académica básica (7°-9°)',         lvl:[7,9],   pc:45, pt:10, pp:40, ppr:0,  pa:5, np:2, npr:0, op:false,
        nota:'2 pruebas obligatorias (20% c/u)' },
      { cod:'religiosa_7_9',desc:'Ética y Valores (7°-9°)',          lvl:[7,9],   pc:70, pt:25, pp:0,  ppr:0,  pa:5, np:0, npr:0, op:false,
        nota:'Sin pruebas ni proyectos' },
      { cod:'practica_7_9', desc:'Práctica (7°-9°)',                  lvl:[7,9],   pc:60, pt:10, pp:0,  ppr:25, pa:5, np:0, npr:1, op:false,
        nota:'1 proyecto (25%)' },
      { cod:'taller_7_9',   desc:'Talleres semestrales (Hogar / Industriales)', lvl:[7,9], pc:45, pt:10, pp:0, ppr:40, pa:5, np:0, npr:1, op:false,
        nota:'1 proyecto (40%) — Nota única semestral' },
      { cod:'civica_7_9',   desc:'Educación Cívica (7°-9°)',          lvl:[7,9],   pc:45, pt:10, pp:0,  ppr:40, pa:5, np:0, npr:1, op:false,
        nota:'1 proyecto (40%)' },
      { cod:'tecno_7_9',    desc:'Formación Tecnológica (7°-9°)',     lvl:[7,9],   pc:45, pt:10, pp:0,  ppr:40, pa:5, np:0, npr:1, op:false,
        nota:'1 proyecto (40%)' },
      { cod:'idioma_7_9',   desc:'Inglés/Francés (7°-9°)',           lvl:[7,9],   pc:45, pt:10, pp:40, ppr:0,  pa:5, np:2, npr:0, op:false,
        nota:'2 pruebas obligatorias (20% c/u)' },
      // 10°-11°
      { cod:'acad_10_11',   desc:'Académica (10°-11°)',               lvl:[10,11], pc:35, pt:10, pp:50, ppr:0,  pa:5, np:2, npr:0, op:false,
        nota:'2 pruebas obligatorias (25% c/u)' },
      { cod:'practica_10_11',desc:'Práctica (10°-11°)',               lvl:[10,11], pc:45, pt:10, pp:0,  ppr:40, pa:5, np:0, npr:1, op:false,
        nota:'1 proyecto (40%)' },
      { cod:'civica_10_11', desc:'Educación Cívica (10°-11°)',        lvl:[10,11], pc:35, pt:10, pp:20, ppr:30, pa:5, np:1, npr:1, op:false,
        nota:'1 prueba (20%) + 1 proyecto (30%)' },
      { cod:'religiosa_10_11',desc:'Ética y Valores (10°-11°)',       lvl:[10,11], pc:70, pt:25, pp:0,  ppr:0,  pa:5, np:0, npr:0, op:false,
        nota:'Sin pruebas ni proyectos' },
      { cod:'paz_10_11',    desc:'Filosofía/Psicología (10°-11°)',    lvl:[10,11], pc:45, pt:10, pp:0,  ppr:40, pa:5, np:0, npr:1, op:false,
        nota:'1 proyecto (40%)' },
      { cod:'tecno_10_11',  desc:'Tecnologías Diversificadas (10°-11°)',lvl:[10,11],pc:35, pt:10, pp:50, ppr:0,  pa:5, np:2, npr:0, op:false,
        nota:'Mínimo 2 pruebas (50% total)' },
    ];
    for(const r of reglas){
      await client.query(`
        INSERT INTO materia_evaluacion_oficial
          (codigo, descripcion, nivel_min, nivel_max,
           porc_cotidiano, porc_tareas, porc_pruebas, porc_proyectos, porc_asistencia,
           cantidad_pruebas, cantidad_proyectos, proyecto_o_prueba, notas)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (codigo) DO UPDATE SET
          descripcion=EXCLUDED.descripcion,
          porc_cotidiano=EXCLUDED.porc_cotidiano,
          porc_tareas=EXCLUDED.porc_tareas,
          porc_pruebas=EXCLUDED.porc_pruebas,
          porc_proyectos=EXCLUDED.porc_proyectos,
          porc_asistencia=EXCLUDED.porc_asistencia,
          cantidad_pruebas=EXCLUDED.cantidad_pruebas,
          cantidad_proyectos=EXCLUDED.cantidad_proyectos,
          proyecto_o_prueba=EXCLUDED.proyecto_o_prueba,
          notas=EXCLUDED.notas
      `, [r.cod, r.desc, r.lvl[0], r.lvl[1], r.pc, r.pt, r.pp, r.ppr, r.pa, r.np, r.npr, r.op, r.nota]);
    }

    // Mapeo materia → regla (por nivel)
    // Si una materia se usa en distintos niveles con reglas distintas, se inserta dos veces.
    const mapeoMaterias = [
      // 7°-9° académicas
      { materia:'Matemática',          regla:'acad_7_9',     lvl:[7,9] },
      { materia:'Español',             regla:'acad_7_9',     lvl:[7,9] },
      { materia:'Estudios Sociales',   regla:'acad_7_9',     lvl:[7,9] },
      { materia:'Ciencias',            regla:'acad_7_9',     lvl:[7,9] },
      { materia:'Inglés',              regla:'idioma_7_9',   lvl:[7,9] },
      { materia:'Francés',             regla:'idioma_7_9',   lvl:[7,9] },
      // 7°-9° religiosa
      { materia:'Ética y Valores',     regla:'religiosa_7_9',lvl:[7,9] },
      // 7°-9° práctica
      { materia:'Educación Física',    regla:'practica_7_9', lvl:[7,9] },
      { materia:'Educación para el Hogar',regla:'taller_7_9', lvl:[7,9] },
      { materia:'Artes Industriales',  regla:'taller_7_9',   lvl:[7,9] },
      { materia:'Artes Plásticas',     regla:'practica_7_9', lvl:[7,9] },
      // 7°-9° cívica
      { materia:'Cívica',              regla:'civica_7_9',   lvl:[7,9] },
      // 7°-9° tecnológica
      { materia:'Informática Educativa',regla:'tecno_7_9',   lvl:[7,9] },

      // 10°-11° académicas
      { materia:'Matemática',          regla:'acad_10_11',   lvl:[10,11] },
      { materia:'Español',             regla:'acad_10_11',   lvl:[10,11] },
      { materia:'Estudios Sociales',   regla:'acad_10_11',   lvl:[10,11] },
      { materia:'Biología',            regla:'acad_10_11',   lvl:[10,11] },
      { materia:'Física Matemática',   regla:'acad_10_11',   lvl:[10,11] },
      { materia:'Química',             regla:'acad_10_11',   lvl:[10,11] },
      { materia:'Inglés',              regla:'acad_10_11',   lvl:[10,11] },
      { materia:'Francés',             regla:'acad_10_11',   lvl:[10,11] },
      // 10°-11° práctica
      { materia:'Educación Física',    regla:'practica_10_11',lvl:[10,11] },
      { materia:'Artes Plásticas',     regla:'practica_10_11',lvl:[10,11] },
      // 10°-11° cívica
      { materia:'Cívica',              regla:'civica_10_11', lvl:[10,11] },
      // 10°-11° religiosa
      { materia:'Ética y Valores',     regla:'religiosa_10_11',lvl:[10,11] },
      // 10°-11° filosofía/psicología
      { materia:'Educación para la Paz',regla:'paz_10_11',   lvl:[10,11] },
      // 10°-11° tecnologías
      { materia:'Inglés Conversacional',regla:'tecno_10_11', lvl:[10,11] },
      { materia:'Diseño Publicitario', regla:'tecno_10_11',  lvl:[10,11] },
      // Filosofía y Psicología si existen como materias separadas
      { materia:'Filosofía',           regla:'paz_10_11',    lvl:[10,11] },
      { materia:'Psicología',          regla:'paz_10_11',    lvl:[10,11] },
    ];

    for(const m of mapeoMaterias){
      try{
        await client.query(`
          INSERT INTO materia_regla_evaluacion (materia_id, regla_id, nivel_min, nivel_max)
          SELECT mat.id, reg.id, $3, $4
          FROM materias mat
          CROSS JOIN materia_evaluacion_oficial reg
          WHERE mat.nombre = $1 AND reg.codigo = $2
          ON CONFLICT (materia_id, nivel_min, nivel_max) DO UPDATE SET regla_id = EXCLUDED.regla_id
        `, [m.materia, m.regla, m.lvl[0], m.lvl[1]]);
      }catch(e){
        console.log(`Mapeo ${m.materia} → ${m.regla}:`, e.message);
      }
    }

    // ── MÓDULO DE CALIFICACIONES (Fase 2) ─────────────────────────────────
    // Evaluaciones concretas: cada examen, tarea, cotidiano o proyecto que
    // el profesor registra para una asignación específica.
    await client.query(`
      CREATE TABLE IF NOT EXISTS evaluaciones (
        id            SERIAL PRIMARY KEY,
        profesor_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        seccion_id    INTEGER NOT NULL REFERENCES secciones(id) ON DELETE CASCADE,
        materia_id    INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
        subgrupo      TEXT DEFAULT NULL,
        periodo       TEXT NOT NULL CHECK(periodo IN ('I Período','II Período')),
        tipo          TEXT NOT NULL CHECK(tipo IN ('examen','tarea','cotidiano','proyecto')),
        nombre        TEXT NOT NULL,
        descripcion   TEXT,
        fecha         DATE NOT NULL,
        puntaje_total NUMERIC(7,2),
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    // Para tareas: fecha cuando el profe asignó la tarea. La columna `fecha`
    // se interpreta como fecha de entrega. Para los demás tipos, fecha_asignacion
    // queda en NULL.
    await client.query(`ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS fecha_asignacion DATE DEFAULT NULL`);

    // Para tipo 'examen': porcentaje fijo que vale esa prueba específica.
    // Ej: si la materia tiene 40% en pruebas y son 2 exámenes, cada profe
    // define cuánto vale cada uno (típicamente 20+20, pero puede ser 25+15).
    // NULL para tipos que no son examen.
    await client.query(`ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS valor_porcentual NUMERIC(5,2) DEFAULT NULL`);

    // Backfill: para exámenes que quedaron con valor_porcentual=NULL (creados
    // antes de que se agregara este campo), asignar automáticamente uno
    // basado en el peso de pruebas del REAC de la materia, dividido entre
    // los exámenes existentes del mismo profe/asignación/período. Esto
    // evita que el cálculo de promedios caiga en "modo legacy" y dé notas
    // inconsistentes cuando hay exámenes sin nota registrada. Se corre solo
    // una vez por examen (si ya tiene valor guardado, no se toca).
    try {
      await client.query(`
        WITH grupos AS (
          SELECT
            ev.profesor_id, ev.seccion_id, ev.materia_id,
            COALESCE(ev.subgrupo,'') AS sg, ev.periodo,
            s.nivel,
            COUNT(*) FILTER (WHERE ev.tipo='examen') AS cant_ex
          FROM evaluaciones ev
          JOIN secciones s ON s.id = ev.seccion_id
          WHERE ev.tipo='examen'
          GROUP BY ev.profesor_id, ev.seccion_id, ev.materia_id,
                   COALESCE(ev.subgrupo,''), ev.periodo, s.nivel
        ),
        pesos AS (
          SELECT g.*, reg.porc_pruebas
          FROM grupos g
          JOIN materia_regla_evaluacion mre
            ON mre.materia_id = g.materia_id
            AND g.nivel BETWEEN mre.nivel_min AND mre.nivel_max
          JOIN materia_evaluacion_oficial reg ON reg.id = mre.regla_id
          WHERE reg.porc_pruebas > 0 AND g.cant_ex > 0
        )
        UPDATE evaluaciones ev
        SET valor_porcentual = ROUND((p.porc_pruebas / p.cant_ex)::numeric, 2)
        FROM pesos p
        WHERE ev.tipo = 'examen'
          AND ev.valor_porcentual IS NULL
          AND ev.profesor_id = p.profesor_id
          AND ev.seccion_id  = p.seccion_id
          AND ev.materia_id  = p.materia_id
          AND COALESCE(ev.subgrupo,'') = p.sg
          AND ev.periodo = p.periodo
      `);
    } catch(e) {
      console.warn("Backfill valor_porcentual:", e.message);
    }

    // Índice para listar rápido por asignación
    await client.query(`CREATE INDEX IF NOT EXISTS idx_eval_asig ON evaluaciones(profesor_id, seccion_id, materia_id, periodo)`);

    // Indicadores: solo para tarea/cotidiano/proyecto. Cada uno aporta puntos al total.
    await client.query(`
      CREATE TABLE IF NOT EXISTS indicadores (
        id              SERIAL PRIMARY KEY,
        evaluacion_id   INTEGER NOT NULL REFERENCES evaluaciones(id) ON DELETE CASCADE,
        orden           INTEGER NOT NULL DEFAULT 1,
        descripcion     TEXT NOT NULL,
        puntaje_maximo  INTEGER NOT NULL DEFAULT 3 CHECK(puntaje_maximo > 0)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_indicador_eval ON indicadores(evaluacion_id, orden)`);

    // Notas para EXAMENES (directo: puntos obtenidos del total)
    await client.query(`
      CREATE TABLE IF NOT EXISTS notas_examen (
        evaluacion_id    INTEGER NOT NULL REFERENCES evaluaciones(id) ON DELETE CASCADE,
        estudiante_id    INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        puntos_obtenidos NUMERIC(7,2),
        updated_at       TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (evaluacion_id, estudiante_id)
      )
    `);

    // Notas por INDICADOR (para tarea/cotidiano/proyecto)
    await client.query(`
      CREATE TABLE IF NOT EXISTS notas_indicador (
        evaluacion_id   INTEGER NOT NULL REFERENCES evaluaciones(id) ON DELETE CASCADE,
        indicador_id    INTEGER NOT NULL REFERENCES indicadores(id) ON DELETE CASCADE,
        estudiante_id   INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        puntaje         INTEGER,
        updated_at      TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (evaluacion_id, indicador_id, estudiante_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_ind_est ON notas_indicador(estudiante_id, evaluacion_id)`);

    // ── MÓDULO DE CALIFICACIONES (Fase 3) ─────────────────────────────────
    // Tabla para registrar cuándo un profesor cierra el período de una de sus
    // asignaciones. Si existe el registro con reabierto_en NULL, el período
    // está cerrado (notas read-only). Si reabierto_en está lleno, vuelve a
    // estar abierto. Historial completo de cierres y reaperturas.
    await client.query(`
      CREATE TABLE IF NOT EXISTS periodos_cerrados (
        id            SERIAL PRIMARY KEY,
        profesor_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        seccion_id    INTEGER NOT NULL REFERENCES secciones(id) ON DELETE CASCADE,
        materia_id    INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
        subgrupo      TEXT DEFAULT NULL,
        periodo       TEXT NOT NULL CHECK(periodo IN ('I Período','II Período')),
        cerrado_en    TIMESTAMP NOT NULL DEFAULT NOW(),
        cerrado_por   INTEGER REFERENCES usuarios(id),
        reabierto_en  TIMESTAMP DEFAULT NULL,
        reabierto_por INTEGER REFERENCES usuarios(id),
        motivo_reapertura TEXT DEFAULT NULL
      )
    `);
    // Índice parcial: solo períodos actualmente cerrados (consulta más común)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_periodo_cerrado ON periodos_cerrados(profesor_id, seccion_id, materia_id, subgrupo, periodo) WHERE reabierto_en IS NULL`);

    // Actualizar CHECK de infracciones
    await client.query(`ALTER TABLE infracciones DROP CONSTRAINT IF EXISTS infracciones_tipo_check`);
    await client.query(`ALTER TABLE infracciones ADD CONSTRAINT infracciones_tipo_check CHECK(tipo IN ('muy_leve','leve','grave','muy_grave','gravisima'))`);

    // Nuevas infracciones
    const infMuyGrave = await client.query("SELECT COUNT(*) AS c FROM infracciones WHERE tipo='muy_grave'");
    if (parseInt(infMuyGrave.rows[0].c) === 0) {
      const nuevas = [
        { tipo:'muy_grave', puntos:35, desc:'Daño contra los bienes del centro educativo relacionados con el ornato, equipo tecnológico, herramientas, mobiliario, infraestructura o cualquier otro activo.' },
        { tipo:'muy_grave', puntos:35, desc:'Sustracción de bienes del centro educativo o bienes personales de los miembros de la comunidad educativa.' },
        { tipo:'muy_grave', puntos:35, desc:'Uso sin consentimiento de las pertenencias de personas integrantes de la comunidad educativa.' },
        { tipo:'muy_grave', puntos:35, desc:'Uso del lenguaje vulgar o soez, así como trato irrespetuoso hacia el director, personal docente, estudiantes, encargados legales u otros miembros de la comunidad educativa.' },
        { tipo:'muy_grave', puntos:35, desc:'Colocar letreros, dibujos o gráficos no autorizados en la infraestructura, mobiliario u otros bienes del centro educativo.' },
        { tipo:'muy_grave', puntos:35, desc:'Alterar, falsificar o plagiar pruebas o cualquier otro tipo de trabajo académico.' },
        { tipo:'muy_grave', puntos:35, desc:'Sustraer, reproducir, distribuir o divulgar las pruebas antes de su aplicación.' },
        { tipo:'muy_grave', puntos:35, desc:'Portar, consumir, fumar o vapear cigarrillos, sistemas electrónicos de administración de nicotina (SEAN) o dispositivos similares.' },
        { tipo:'muy_grave', puntos:35, desc:'Portar o ingerir bebidas con contenido alcohólico.' },
        { tipo:'muy_grave', puntos:35, desc:'Ingresar al centro educativo en estado de ebriedad o bajo signos de ingesta de bebidas alcohólicas u otras sustancias psicoactivas.' },
        { tipo:'muy_grave', puntos:35, desc:'Uso de dispositivos móviles u otros medios tecnológicos que interfieran en el proceso de aprendizaje sin autorización de la persona docente.' },
        { tipo:'gravisima', puntos:50, desc:'Agresión física contra cualquier miembro de la comunidad educativa.' },
        { tipo:'gravisima', puntos:50, desc:'Tenencia, difusión, distribución o comercio de imágenes o videos con contenidos de índole sexual, acoso, violencias en línea o material que atente contra la dignidad e integridad humana.' },
        { tipo:'gravisima', puntos:50, desc:'Ingestión reiterada de bebidas alcohólicas.' },
        { tipo:'gravisima', puntos:50, desc:'Consumir o portar sustancias psicoactivas dentro del centro educativo o en actividades convocadas oficialmente.' },
        { tipo:'gravisima', puntos:50, desc:'Distribuir, inducir o facilitar el uso de cualquier tipo de sustancias psicoactivas dentro del centro educativo o en actividades convocadas.' },
        { tipo:'gravisima', puntos:50, desc:'Infringir daño en cualquiera de las manifestaciones de violencia, incluyendo bullying y acoso, de manera presencial o mediante tecnologías de la información y comunicación.' },
      ];
      for (const inf of nuevas) {
        await client.query("INSERT INTO infracciones (tipo, puntos, descripcion) VALUES ($1,$2,$3)", [inf.tipo, inf.puntos, inf.desc]);
      }
      console.log("✅ Nuevas infracciones cargadas");
    }
    // ── CORREGIR INFRACCIONES MUY GRAVES (Art. 156 REAC) ──────────────────
    // Las muy_grave estaban mal — eran copias de las graves. Se reemplazan con Art. 156
    try {
      // No eliminar — actualizar descripción de las que tienen referencias (FK)
      // Solo insertar las que faltan según Art. 156
      await client.query("UPDATE infracciones SET descripcion='Falta muy grave (Art. 156 REAC)' WHERE tipo='muy_grave' AND descripcion NOT LIKE '%Art. 156%' AND id IN (SELECT infraccion_id FROM boletas_conducta)");
      // Eliminar solo las que NO tienen referencias en boletas
      await client.query("DELETE FROM infracciones WHERE tipo='muy_grave' AND id NOT IN (SELECT DISTINCT infraccion_id FROM boletas_conducta WHERE infraccion_id IS NOT NULL)");
      const muyGraves = [
        "Incentivar o participar en la escenificación pública de conductas que atenten contra la dignidad, seguridad e integridad de cualquier persona.",
        "Impedir que otros miembros de la comunidad educativa participen en el normal desarrollo de las actividades regulares del centro educativo, así como incitar a otros a actuar con idénticos propósitos, entre los que se contempla el cierre del centro educativo.",
        "Incitación a los compañeros a que participen en acciones que perjudiquen la salud, seguridad individual o colectiva.",
        "Portar armas, explosivos, objetos o sustancias peligrosas que pongan en peligro la integridad y seguridad de algún miembro de la comunidad educativa. Así como el uso inadecuado de materiales diseñados para fines didácticos con otros propósitos que constituyan un riesgo.",
        "Cualquier tipo de acción discriminatoria asociada a género, edad, raza u origen étnico o nacional, condición socioeconómica o cualquier otra que viole la dignidad humana, incluidas aquellas realizadas mediante mecanismos o dispositivos tecnológicos.",
        "Realizar, grabar, distribuir o ser cómplice en actos de violencia en todas sus manifestaciones: bullying, acoso, violencia psicológica y violencia material entre estudiantes dentro del centro educativo, incluyendo el uso de dispositivos electrónicos para registrar y difundir actos de agresión presencial o cibernética.",
        "Sustracción, alteración o falsificación de documentos oficiales.",
        "Otras faltas que se consideren como muy graves según la normativa interna del centro educativo."
      ];
      for(const desc of muyGraves){
        await client.query("INSERT INTO infracciones (tipo, puntos, descripcion) VALUES ($1,$2,$3)", ['muy_grave', 35, desc]);
      }
      console.log("✅ Infracciones muy_grave corregidas (Art. 156 REAC)");
    } catch(e) { console.log("muy_grave migration:", e.message); }

    // ── AGREGAR FALTA MUY LEVE FALTANTE (Art. 153d) ───────────────────────
    try {
      const d = await client.query("SELECT COUNT(*) AS c FROM infracciones WHERE tipo='muy_leve'");
      if(parseInt(d.rows[0].c) < 4) {
        await client.query("INSERT INTO infracciones (tipo, puntos, descripcion) VALUES ($1,$2,$3)",
          ['muy_leve', 5, 'Otras faltas que se consideren como muy leves según la normativa interna del centro educativo.']);
      }
    } catch(e) {}

    // ── HORARIOS POR SECCIÓN (grilla 12 lecciones × 5 días, por año) ─────
    // El horario es ANUAL (campo anio permite archivar y arrancar limpio en 2027).
    // Cada celda referencia una asignación existente (profe+materia) o queda libre.
    await client.query(`
      CREATE TABLE IF NOT EXISTS horarios (
        id            SERIAL PRIMARY KEY,
        anio          INTEGER NOT NULL,
        seccion_id    INTEGER REFERENCES secciones(id) ON DELETE CASCADE,
        dia           INTEGER NOT NULL CHECK(dia BETWEEN 1 AND 5),
        leccion       INTEGER NOT NULL CHECK(leccion BETWEEN 1 AND 12),
        asignacion_id INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        materia_texto TEXT DEFAULT NULL,
        aula          INTEGER DEFAULT NULL
      )
    `);
    // El UNIQUE viejo restringía a una única asignación por celda. Se elimina
    // para permitir combinaciones tipo Hogar+Industriales en la misma hora.
    // Permitir múltiples asignaciones en la misma celda (Hogar+Industriales, etc.)
    // Se quita CUALQUIER constraint UNIQUE/EXCLUSION que impida tener más de una
    // fila por (anio, seccion_id, dia, leccion). Se hace por dos vías:
    // 1) nombre autogenerado típico de Postgres
    // 2) búsqueda por definición en pg_constraint
    // 3) por si acaso, drop de índices UNIQUE que apunten al mismo grupo de columnas
    await client.query(`DO $$
      DECLARE r RECORD;
      BEGIN
        -- Drop de constraints UNIQUE / EXCLUDE en la tabla horarios
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'horarios'::regclass
            AND contype IN ('u','x')
        LOOP
          EXECUTE format('ALTER TABLE horarios DROP CONSTRAINT %I', r.conname);
        END LOOP;
        -- Drop de índices UNIQUE que no sean el de la clave primaria
        FOR r IN
          SELECT indexname FROM pg_indexes
          WHERE tablename = 'horarios'
            AND indexdef ILIKE '%UNIQUE%'
            AND indexname <> 'horarios_pkey'
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
        END LOOP;
      END $$`);
    // Migración aditiva por si la tabla ya existía sin la columna
    await client.query(`ALTER TABLE horarios ADD COLUMN IF NOT EXISTS aula INTEGER DEFAULT NULL`);

    // ── PERMISOS DE SALIDA (auxiliares) ──────────────────────────────────
    // Consecutivo interno por año (numero + anio). Individual o por sección.
    // Un solo uso POR ESTUDIANTE para la fecha indicada (tabla de usos).
    await client.query(`
      CREATE TABLE IF NOT EXISTS permisos_salida (
        id             SERIAL PRIMARY KEY,
        numero         INTEGER NOT NULL,
        anio           INTEGER NOT NULL,
        tipo           TEXT NOT NULL CHECK(tipo IN ('individual','seccion')),
        estudiante_id  INTEGER REFERENCES estudiantes(id) ON DELETE CASCADE,
        seccion_id     INTEGER REFERENCES secciones(id) ON DELETE CASCADE,
        fecha          DATE NOT NULL,
        hora_salida    TEXT DEFAULT NULL,
        autoriza_nombre     TEXT NOT NULL,
        autoriza_cedula     TEXT DEFAULT NULL,
        autoriza_parentesco TEXT DEFAULT NULL,
        motivo         TEXT NOT NULL,
        creado_por     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        anulado        BOOLEAN DEFAULT false,
        created_at     TIMESTAMP DEFAULT NOW(),
        UNIQUE(anio, numero)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS permisos_salida_usos (
        id             SERIAL PRIMARY KEY,
        permiso_id     INTEGER REFERENCES permisos_salida(id) ON DELETE CASCADE,
        estudiante_id  INTEGER REFERENCES estudiantes(id) ON DELETE CASCADE,
        fecha          DATE NOT NULL,
        hora           TEXT NOT NULL,
        registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        UNIQUE(permiso_id, estudiante_id)
      )
    `);

    // ── PORTERÍA (rol seguridad): registro de entradas/salidas ───────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS porteria_registros (
        id             SERIAL PRIMARY KEY,
        estudiante_id  INTEGER REFERENCES estudiantes(id) ON DELETE CASCADE,
        fecha          DATE NOT NULL,
        hora           TEXT NOT NULL,
        tipo           TEXT NOT NULL CHECK(tipo IN ('entrada','salida')),
        resultado      TEXT NOT NULL CHECK(resultado IN ('permitido','denegado')),
        detalle        TEXT DEFAULT NULL,
        permiso_id     INTEGER REFERENCES permisos_salida(id) ON DELETE SET NULL,
        registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        created_at     TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_porteria_fecha ON porteria_registros(fecha)`);

    // ── PORTAL DE PADRES ─────────────────────────────────────────────────
    // Acceso con la cédula del encargado. Contraseña inicial = cédula
    // (cambio obligatorio). sid_activo fuerza UNA sola sesión a la vez.
    await client.query(`
      CREATE TABLE IF NOT EXISTS padres_acceso (
        id            SERIAL PRIMARY KEY,
        cedula        TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        primer_login  BOOLEAN DEFAULT true,
        activo        BOOLEAN DEFAULT true,
        servicio_habilitado BOOLEAN DEFAULT false,
        servicio_habilitado_at TIMESTAMP DEFAULT NULL,
        servicio_habilitado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        sid_activo    TEXT DEFAULT NULL,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE padres_acceso ADD COLUMN IF NOT EXISTS servicio_habilitado BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE padres_acceso ADD COLUMN IF NOT EXISTS servicio_habilitado_at TIMESTAMP DEFAULT NULL`);
    await client.query(`ALTER TABLE padres_acceso ADD COLUMN IF NOT EXISTS servicio_habilitado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);

    // Cada teléfono/navegador autorizado por una familia conserva su propia
    // suscripción Web Push. El endpoint es único: si el dispositivo cambia de
    // cuenta, queda asociado únicamente al último encargado que lo activó.
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_suscripciones (
        id               SERIAL PRIMARY KEY,
        padre_acceso_id  INTEGER NOT NULL REFERENCES padres_acceso(id) ON DELETE CASCADE,
        endpoint         TEXT UNIQUE NOT NULL,
        p256dh           TEXT NOT NULL,
        auth             TEXT NOT NULL,
        user_agent       TEXT DEFAULT '',
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW(),
        last_success_at  TIMESTAMP DEFAULT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_push_suscripciones_padre
      ON push_suscripciones(padre_acceso_id)`);

    // Funciones institucionales asignadas desde Admin → Asignaciones.
    // Son permisos adicionales; no sustituyen el rol base de la persona.
    await client.query(`
      CREATE TABLE IF NOT EXISTS funciones_institucionales (
        id          SERIAL PRIMARY KEY,
        usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo        TEXT NOT NULL CHECK(tipo IN ('coordinador','comite_apoyo')),
        asignado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        created_at  TIMESTAMP DEFAULT NOW(),
        UNIQUE(usuario_id,tipo)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_funciones_institucionales_tipo
      ON funciones_institucionales(tipo,usuario_id)`);

    // Registro único y vigente de adecuaciones por estudiante.
    await client.query(`
      CREATE TABLE IF NOT EXISTS adecuaciones_estudiante (
        estudiante_id       INTEGER PRIMARY KEY REFERENCES estudiantes(id) ON DELETE CASCADE,
        no_significativa     BOOLEAN NOT NULL DEFAULT false,
        significativa        BOOLEAN NOT NULL DEFAULT false,
        acceso               BOOLEAN NOT NULL DEFAULT false,
        observacion          TEXT DEFAULT '',
        actualizado_por      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        updated_at           TIMESTAMP DEFAULT NOW()
      )
    `);
    // Conserva las adecuaciones que ya se digitaban durante matrícula.
    await client.query(`
      INSERT INTO adecuaciones_estudiante(estudiante_id,no_significativa,significativa)
      SELECT id,
        LOWER(COALESCE(adecuacion,'')) IN ('no_significativa','no significativa'),
        LOWER(COALESCE(adecuacion,'')) IN ('significativa','significativa curricular')
      FROM estudiantes
      WHERE LOWER(COALESCE(adecuacion,'')) NOT IN ('','ninguna','no')
      ON CONFLICT(estudiante_id) DO NOTHING
    `);

    // Solicitudes docentes; la aprobación deja trazabilidad y actualiza el
    // registro vigente de la persona estudiante.
    await client.query(`
      CREATE TABLE IF NOT EXISTS solicitudes_adecuacion_docente (
        id              SERIAL PRIMARY KEY,
        estudiante_id   INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        profesor_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo            TEXT NOT NULL CHECK(tipo IN ('no_significativa','significativa','acceso')),
        motivo          TEXT NOT NULL,
        estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobada','rechazada')),
        respuesta       TEXT DEFAULT '',
        resuelta_por    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        resuelta_at     TIMESTAMP DEFAULT NULL,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_solicitudes_adecuacion_estado
      ON solicitudes_adecuacion_docente(estado,created_at DESC)`);

    // ── CITAS ENCARGADOS ↔ DOCENTES ─────────────────────────────────────
    // Cada docente publica bloques semanales disponibles. El portal genera
    // las horas posibles dentro de esos bloques y evita reservar dos citas
    // para el mismo docente a la misma hora.
    await client.query(`
      CREATE TABLE IF NOT EXISTS citas_disponibilidad (
        id            SERIAL PRIMARY KEY,
        profesor_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        anio          INTEGER NOT NULL REFERENCES anios_lectivos(anio) ON DELETE CASCADE,
        dia_semana    INTEGER NOT NULL CHECK(dia_semana BETWEEN 1 AND 5),
        hora_inicio   TIME NOT NULL,
        hora_fin      TIME NOT NULL,
        duracion_min  INTEGER NOT NULL DEFAULT 20 CHECK(duracion_min BETWEEN 10 AND 120),
        activa        BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW(),
        CHECK(hora_fin > hora_inicio),
        UNIQUE(profesor_id, anio, dia_semana, hora_inicio)
      );

      CREATE TABLE IF NOT EXISTS citas (
        id                    SERIAL PRIMARY KEY,
        anio                  INTEGER NOT NULL REFERENCES anios_lectivos(anio) ON DELETE RESTRICT,
        estudiante_id         INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
        profesor_id           INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        asignacion_id         INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
        encargado_cedula      TEXT NOT NULL,
        solicitada_por        TEXT NOT NULL CHECK(solicitada_por IN ('encargado','profesor')),
        fecha                 DATE NOT NULL,
        hora                  TIME NOT NULL,
        duracion_min          INTEGER NOT NULL DEFAULT 20 CHECK(duracion_min BETWEEN 10 AND 120),
        motivo                TEXT NOT NULL,
        estado                TEXT NOT NULL DEFAULT 'pendiente'
                              CHECK(estado IN ('pendiente','confirmada','rechazada','cancelada')),
        pendiente_de          TEXT CHECK(pendiente_de IN ('encargado','profesor')),
        es_contrapropuesta    BOOLEAN NOT NULL DEFAULT false,
        respuesta_mensaje     TEXT DEFAULT '',
        creada_por_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        created_at            TIMESTAMP DEFAULT NOW(),
        updated_at            TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_citas_profesor_fecha
      ON citas(profesor_id, fecha, hora)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_citas_encargado
      ON citas(encargado_cedula, fecha)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_citas_estudiante
      ON citas(estudiante_id, fecha)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS citas_profesor_hora_activa_uq
      ON citas(profesor_id, fecha, hora)
      WHERE estado IN ('pendiente','confirmada')`);

    // ── ANUNCIOS (secretarias/admin/administrativos → padres) ────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS anuncios (
        id         SERIAL PRIMARY KEY,
        titulo     TEXT NOT NULL,
        cuerpo     TEXT NOT NULL,
        para_todos BOOLEAN DEFAULT true,
        secciones  INTEGER[] DEFAULT ARRAY[]::INTEGER[],
        creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        activo     BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Nuevas materias
    await client.query("INSERT INTO materias (nombre) VALUES ('Inglés Conversacional') ON CONFLICT DO NOTHING");
    await client.query("INSERT INTO materias (nombre) VALUES ('Diseño Publicitario') ON CONFLICT DO NOTHING");

    // No se crean administradores con credenciales conocidas. Las instalaciones
    // existentes conservan sus usuarios; el administrador debe crear y verificar
    // una cuenta nominal antes de desactivar cualquier cuenta heredada.

    // Secciones
    const secciones = [
      ...[1,2,3,4,5,6,7,8].map(i=>({nombre:`7-${i}`,nivel:7})),
      ...[1,2,3,4,5,6,7].map(i=>({nombre:`8-${i}`,nivel:8})),
      ...[1,2,3,4,5,6,7].map(i=>({nombre:`9-${i}`,nivel:9})),
      ...[1,2,3,4,5].map(i=>({nombre:`10-${i}`,nivel:10})),
      ...[1,2,3,4,5].map(i=>({nombre:`11-${i}`,nivel:11})),
    ];
    for (const s of secciones) {
      await client.query("INSERT INTO secciones (nombre,nivel) VALUES ($1,$2) ON CONFLICT DO NOTHING", [s.nombre,s.nivel]);
    }

    // Materias
    for (const m of MATERIAS_DEFAULT) {
      await client.query("INSERT INTO materias (nombre) VALUES ($1) ON CONFLICT DO NOTHING", [m]);
    }

    // ── MIGRACIÓN: garantizar infracciones requeridas para boletas automáticas ─
    // El sistema busca "Fuga de las lecciones" (leve 10pt) y "Ausencias injustificadas"
    // (leve 10pt) para auto-generar boletas. En una BD que ya tenía otra estructura,
    // el seed inicial completo no corre (porque ya hay registros), y estas dos pueden
    // faltar — entonces las auto-boletas fallan silenciosamente. Esta migración las
    // inserta si no existen.
    const infFuga = await client.query(
      "SELECT id FROM infracciones WHERE descripcion ILIKE '%Fuga de las lecciones%' LIMIT 1"
    );
    if (!infFuga.rows.length) {
      await client.query(
        "INSERT INTO infracciones (tipo, puntos, descripcion) VALUES ('leve', 10, $1)",
        ['Fuga de las lecciones y de actividades curriculares o cocurriculares programadas por el centro educativo.']
      );
      console.log("✅ Infracción 'Fuga de lecciones' añadida (requerida para auto-boletas)");
    }
    const infAusInj = await client.query(
      "SELECT id FROM infracciones WHERE descripcion ILIKE '%Ausencias injustificadas%' LIMIT 1"
    );
    if (!infAusInj.rows.length) {
      await client.query(
        "INSERT INTO infracciones (tipo, puntos, descripcion) VALUES ('leve', 10, $1)",
        ['Ausencias injustificadas a actividades debidamente convocadas.']
      );
      console.log("✅ Infracción 'Ausencias injustificadas' añadida (requerida para auto-boletas)");
    }

    // Infracciones pre-cargadas
    const infCount = await client.query("SELECT COUNT(*) AS c FROM infracciones");
    if (parseInt(infCount.rows[0].c) === 0) {
      const infracciones = [
        // MUY LEVES - 5 puntos
        { tipo:'muy_leve', puntos:5, desc:'Uso incorrecto del uniforme.' },
        { tipo:'muy_leve', puntos:5, desc:'Uso de accesorios personales no autorizados según las disposiciones establecidas por el centro educativo.' },
        { tipo:'muy_leve', puntos:5, desc:'Incumplimiento de las normas de presentación personal establecidas por el centro educativo.' },
        // LEVES - 10 puntos
        { tipo:'leve', puntos:10, desc:'Uso del cuaderno de comunicaciones para acciones diferentes al objetivo para el cual fue establecido.' },
        { tipo:'leve', puntos:10, desc:'No informar a los encargados legales sobre la existencia de comunicaciones remitidas al hogar.' },
        { tipo:'leve', puntos:10, desc:'Interrupciones al proceso de aprendizaje en espacios educativos.' },
        { tipo:'leve', puntos:10, desc:'Fuga de las lecciones y de actividades curriculares o cocurriculares programadas por el centro educativo.' },
        { tipo:'leve', puntos:10, desc:'Ausencias injustificadas a actividades debidamente convocadas.' },
        // GRAVES - 20 puntos
        { tipo:'grave', puntos:20, desc:'Daño contra los bienes del centro educativo (ornato, equipo tecnológico, herramientas, mobiliario, infraestructura u otros activos).' },
        { tipo:'grave', puntos:20, desc:'Sustracción de bienes del centro educativo o bienes personales de los miembros de la comunidad educativa.' },
        { tipo:'grave', puntos:20, desc:'Uso sin consentimiento de las pertenencias de personas integrantes de la comunidad educativa.' },
        { tipo:'grave', puntos:20, desc:'Uso del lenguaje vulgar o soez, así como trato irrespetuoso hacia el director, personal docente, estudiantes, encargados legales u otros miembros de la comunidad educativa.' },
        { tipo:'grave', puntos:20, desc:'Colocar letreros, dibujos o gráficos no autorizados en la infraestructura, mobiliario u otros bienes del centro educativo.' },
        { tipo:'grave', puntos:20, desc:'Alterar, falsificar o plagiar pruebas o cualquier otro tipo de trabajo académico.' },
        { tipo:'grave', puntos:20, desc:'Sustraer, reproducir, distribuir o divulgar las pruebas antes de su aplicación.' },
        { tipo:'grave', puntos:20, desc:'Portar, consumir, fumar o vapear cigarrillos, sistemas electrónicos de administración de nicotina (SEAN) o dispositivos similares.' },
        { tipo:'grave', puntos:20, desc:'Portar o ingerir bebidas con contenido alcohólico.' },
        { tipo:'grave', puntos:20, desc:'Ingresar al centro educativo en estado de ebriedad o bajo signos de ingesta de bebidas alcohólicas u otras sustancias psicoactivas.' },
        { tipo:'grave', puntos:20, desc:'Uso de dispositivos móviles u otros medios tecnológicos que interfieran en el proceso de aprendizaje sin autorización de la persona docente.' },
        // MUY GRAVES - 35 puntos
        { tipo:'muy_grave', puntos:35, desc:'Daño contra los bienes del centro educativo relacionados con el ornato, equipo tecnológico, herramientas, mobiliario, infraestructura o cualquier otro activo.' },
        { tipo:'muy_grave', puntos:35, desc:'Sustracción de bienes del centro educativo o bienes personales de los miembros de la comunidad educativa.' },
        { tipo:'muy_grave', puntos:35, desc:'Uso sin consentimiento de las pertenencias de personas integrantes de la comunidad educativa.' },
        { tipo:'muy_grave', puntos:35, desc:'Uso del lenguaje vulgar o soez, así como trato irrespetuoso hacia el director, personal docente, estudiantes, encargados legales u otros miembros de la comunidad educativa.' },
        { tipo:'muy_grave', puntos:35, desc:'Colocar letreros, dibujos o gráficos no autorizados en la infraestructura, mobiliario u otros bienes del centro educativo.' },
        { tipo:'muy_grave', puntos:35, desc:'Alterar, falsificar o plagiar pruebas o cualquier otro tipo de trabajo académico.' },
        { tipo:'muy_grave', puntos:35, desc:'Sustraer, reproducir, distribuir o divulgar las pruebas antes de su aplicación.' },
        { tipo:'muy_grave', puntos:35, desc:'Portar, consumir, fumar o vapear cigarrillos, sistemas electrónicos de administración de nicotina (SEAN) o dispositivos similares.' },
        { tipo:'muy_grave', puntos:35, desc:'Portar o ingerir bebidas con contenido alcohólico.' },
        { tipo:'muy_grave', puntos:35, desc:'Ingresar al centro educativo en estado de ebriedad o bajo signos de ingesta de bebidas alcohólicas u otras sustancias psicoactivas.' },
        { tipo:'muy_grave', puntos:35, desc:'Uso de dispositivos móviles u otros medios tecnológicos que interfieran en el proceso de aprendizaje sin autorización de la persona docente.' },
        // GRAVÍSIMAS - 50 puntos
        { tipo:'gravisima', puntos:50, desc:'Agresión física contra cualquier miembro de la comunidad educativa.' },
        { tipo:'gravisima', puntos:50, desc:'Tenencia, difusión, distribución o comercio de imágenes o videos con contenidos de índole sexual, acoso, violencias en línea o material que atente contra la dignidad e integridad humana.' },
        { tipo:'gravisima', puntos:50, desc:'Ingestión reiterada de bebidas alcohólicas.' },
        { tipo:'gravisima', puntos:50, desc:'Consumir o portar sustancias psicoactivas dentro del centro educativo o en actividades convocadas oficialmente.' },
        { tipo:'gravisima', puntos:50, desc:'Distribuir, inducir o facilitar el uso de cualquier tipo de sustancias psicoactivas dentro del centro educativo o en actividades convocadas.' },
        { tipo:'gravisima', puntos:50, desc:'Infringir daño en cualquiera de las manifestaciones de violencia, incluyendo bullying y acoso, de manera presencial o mediante tecnologías de la información y comunicación.' },
      ];
      for (const inf of infracciones) {
        await client.query("INSERT INTO infracciones (tipo, puntos, descripcion) VALUES ($1,$2,$3)", [inf.tipo, inf.puntos, inf.desc]);
      }
      console.log("✅ Infracciones de conducta cargadas");
    }

    // ── ÍNDICES para mejorar rendimiento de queries ───────────────────
    const dbIndexes = [
      "CREATE INDEX IF NOT EXISTS idx_est_seccion ON estudiantes(seccion_id) WHERE activo=true",
      "CREATE INDEX IF NOT EXISTS idx_est_cedula ON estudiantes(cedula)",
      "CREATE INDEX IF NOT EXISTS idx_asist_estudiante ON asistencia(estudiante_id)",
      "CREATE INDEX IF NOT EXISTS idx_asist_estado ON asistencia(estado)",
      "CREATE INDEX IF NOT EXISTS idx_sesiones_asig ON sesiones_asistencia(asignacion_id)",
      "CREATE INDEX IF NOT EXISTS idx_sesiones_fecha ON sesiones_asistencia(fecha)",
      "CREATE INDEX IF NOT EXISTS idx_asig_profesor ON asignaciones(profesor_id)",
      "CREATE INDEX IF NOT EXISTS idx_asig_seccion ON asignaciones(seccion_id)",
      "CREATE INDEX IF NOT EXISTS idx_informes_dest ON informes(destinatario_id)",
      "CREATE INDEX IF NOT EXISTS idx_consec_tipo ON consecutivos(tipo)",
      "CREATE INDEX IF NOT EXISTS idx_premat_cedula ON prematricula(cedula)",
    ];
    for (const sql of dbIndexes) {
      try { await client.query(sql); } catch(e) {}
    }

    console.log("✅ Base de datos lista");
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
