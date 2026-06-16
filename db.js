require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

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
        es_principal     BOOLEAN DEFAULT true,
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
    await client.query(`ALTER TABLE encargados ADD COLUMN IF NOT EXISTS cedula TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE encargados ADD COLUMN IF NOT EXISTS lugar_trabajo TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE encargados ADD COLUMN IF NOT EXISTS telefono_trabajo TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS foto_url TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS archivado BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS fecha_archivo DATE DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS motivo_archivo TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS justificacion_archivo TEXT DEFAULT NULL`);
    await client.query(`ALTER TABLE estudiantes ADD COLUMN IF NOT EXISTS becado BOOLEAN DEFAULT false`);
    // Ampliar constraint de rol para incluir todos los roles
    try {
      await client.query(`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check`);
      await client.query(`ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK(rol IN ('admin','auxiliar','orientador','profesor_guia','profesor','cocinera','secretaria','administrativo','junta'))`);
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

    // Actualizar UNIQUE de asignaciones para incluir subgrupo
    await client.query(`ALTER TABLE asignaciones DROP CONSTRAINT IF EXISTS asignaciones_profesor_id_seccion_id_materia_id_key`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'asignaciones_unique_subgrupo'
        ) THEN
          ALTER TABLE asignaciones ADD CONSTRAINT asignaciones_unique_subgrupo
          UNIQUE(profesor_id, seccion_id, materia_id, subgrupo);
        END IF;
      END $$;
    `);

    // ── PERÍODO LECTIVO en asignaciones ─────────────────────────────────────
    // Permite tener dos asignaciones distintas para el mismo profesor/sección/materia,
    // una por cada período. Las asistencias e historial del I Período quedan
    // preservadas en su asignación original.
    // Default 'I Período' para todas las existentes (que se crearon antes de esta migración).
    await client.query(`ALTER TABLE asignaciones ADD COLUMN IF NOT EXISTS periodo TEXT DEFAULT 'I Período'`);
    await client.query(`UPDATE asignaciones SET periodo='I Período' WHERE periodo IS NULL`);
    // Reemplazar el unique anterior para incluir período en la clave
    await client.query(`ALTER TABLE asignaciones DROP CONSTRAINT IF EXISTS asignaciones_unique_subgrupo`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'asignaciones_unique_periodo'
        ) THEN
          ALTER TABLE asignaciones ADD CONSTRAINT asignaciones_unique_periodo
          UNIQUE(profesor_id, seccion_id, materia_id, subgrupo, periodo);
        END IF;
      END $$;
    `);

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

      // Verificar si ya está poblado
      const existe = await client.query("SELECT COUNT(*)::int AS n FROM reac_catalogo");
      if (existe.rows[0].n === 0) {
        // Inserciones por bloque. Usamos ON CONFLICT DO NOTHING por idempotencia.

        // ART. 140 — FALTAS GRAVES (20 puntos)
        const art140 = [
          ['a','La reiteración en la comisión de faltas leves en un mismo periodo.'],
          ['b','Daño por culpa contra el ornato, equipo, mobiliario, infraestructura del centro educativo o vehículos usados para el transporte de estudiantes.'],
          ['c','Sustracción de bienes del centro educativo o personales.'],
          ['d','Las frases o los hechos irrespetuosos dichos o cometidos en contra del director o la directora, los docentes y las docentes, las personas estudiantes, encargados legales de la persona estudiante y otros miembros de la comunidad educativa.'],
          ['e','El uso reiterado del lenguaje o trato irrespetuoso con los demás miembros de la comunidad educativa.'],
          ['f','Alterar, falsificar o plagiar pruebas o cualquier otro tipo de trabajo académico con el que se deba cumplir como parte de su proceso educativo, sean estos realizados en beneficio propio o de otros estudiantes.'],
          ['g','Sustraer, reproducir, distribuir o divulgar las pruebas antes de su aplicación.'],
          ['h','La utilización de las paredes, mesas, sillas, pupitres u otros bienes y objetos del centro educativo, para colocar letreros, dibujos o gráficos no autorizados.'],
          ['i','Fumar o ingerir bebidas alcohólicas dentro de la institución, fuera de ella en horario lectivo, portando el uniforme o en actividades extracurriculares convocadas oficialmente.'],
          ['j','Ingresar al centro educativo en condiciones de evidente ingesta de bebidas alcohólicas.'],
          ['k','Otras faltas que se consideren como graves según el Reglamento Interno de la Institución.'],
        ];
        for (const [inc, desc] of art140) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, puntos, descripcion) VALUES ('falta', 140, $1, 'grave', 20, $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ART. 141 — FALTAS MUY GRAVES (35 puntos)
        const art141 = [
          ['a','La destrucción deliberada de bienes pertenecientes al centro educativo, al personal o a los demás miembros de la comunidad educativa, ya sea individual o en grupo. La destrucción de vehículos usados para el transporte de estudiantes.'],
          ['b','La escenificación pública de conductas contrarias al Reglamento Interno, la moral pública o las buenas costumbres.'],
          ['c','Impedir que otros miembros de la comunidad educativa participen en el normal desarrollo de las actividades regulares de la institución, así como incitar a otros a actuar con idénticos propósitos.'],
          ['d','Consumir o portar drogas ilícitas dentro de la institución, en actividades convocadas oficialmente o en cualquier otra de las circunstancias descritas en el artículo 130 de este reglamento.'],
          ['e','Incitación a los compañeros a que participen en acciones que perjudiquen la salud, seguridad individual o colectiva.'],
          ['f','Portar armas o explosivos así como otros objetos potencialmente peligrosos para las personas, salvo quienes estén expresamente autorizados por la institución con fines didácticos.'],
          ['g','Cualquier tipo de acción discriminatoria por razones de raza, credo, género, discapacidad o cualquier otra contraria a la dignidad humana.'],
          ['h','Reiteración en la comisión de faltas graves en un mismo periodo lectivo.'],
          ['i','Otras faltas que se consideren como muy graves según el Reglamento Interno de la Institución.'],
        ];
        for (const [inc, desc] of art141) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, puntos, descripcion) VALUES ('falta', 141, $1, 'muy_grave', 35, $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ART. 142 — FALTAS GRAVÍSIMAS (50 puntos)
        const art142 = [
          ['a','Sustracción, alteración o falsificación de documentos oficiales.'],
          ['b','La reiteración, en un mismo curso lectivo, de la destrucción deliberada de bienes pertenecientes a la institución educativa, al personal o a los demás miembros de la comunidad educativa.'],
          ['c','Agresión física contra cualquier miembro de la comunidad educativa, el director, el personal, las personas estudiantes o los encargados legales.'],
          ['d','Ingestión reiterada de bebidas alcohólicas dentro de la institución, fuera de ella en horario lectivo, portando el uniforme o en actividades extracurriculares convocadas oficialmente.'],
          ['e','Consumir o portar, de manera reiterada, drogas ilícitas dentro de la institución, en actividades convocadas oficialmente o en cualquier otra de las circunstancias descritas en el artículo 130 de este reglamento.'],
          ['f','Distribuir, inducir o facilitar el uso de cualquier tipo de drogas ilícitas dentro de la institución, en actividades oficialmente convocadas o en cualquiera de las circunstancias señaladas en el artículo 130 de este Reglamento.'],
          ['g','Tráfico o divulgación de material contrario a la moral pública.'],
          ['h','Otras faltas que se consideren como gravísimas según el Reglamento Interno de la Institución.'],
        ];
        for (const [inc, desc] of art142) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, puntos, descripcion) VALUES ('falta', 142, $1, 'gravisima', 50, $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ART. 150 — ACCIONES CORRECTIVAS POR FALTAS GRAVES
        const art150 = [
          ['a','Traslado del alumno a otra sección.'],
          ['b','Reparación o reposición del material o equipo que hubiera dañado.'],
          ['c','Reparación de la ofensa verbal o moral a las personas, grupos internos o externos a la institución, mediante la oportuna retractación pública y las disculpas que correspondan.'],
          ['d','Pérdida de la autorización para representar a la institución en cualquier delegación oficial.'],
          ['e','Pérdida de las credenciales en el Gobierno Estudiantil, la Asamblea de Representantes, la directiva de sección y cualquier otro comité institucional.'],
          ['f','Realización de acciones con carácter educativo y de interés institucional o comunal, verificables y proporcionales a la falta cometida.'],
          ['g','Inasistencia al centro educativo hasta por un período máximo de quince días naturales.'],
        ];
        for (const [inc, desc] of art150) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, descripcion) VALUES ('accion_correctiva', 150, $1, 'grave', $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ART. 151 — ACCIONES CORRECTIVAS POR FALTAS MUY GRAVES
        const art151 = [
          ['a','Obligación de reparar, de manera verificable, el daño material, moral o personal causado a las personas, grupos o a la Institución.'],
          ['b','Realización de acciones con carácter educativo y de interés institucional o comunal, verificables y proporcionales a la falta cometida.'],
          ['c','Inasistencia al centro educativo por un período comprendido entre quince y veinte días naturales.'],
        ];
        for (const [inc, desc] of art151) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, descripcion) VALUES ('accion_correctiva', 151, $1, 'muy_grave', $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // ART. 152 — ACCIONES CORRECTIVAS POR FALTAS GRAVÍSIMAS
        const art152 = [
          ['a','Obligación de reparar, de manera verificable, el daño material, moral o personal causado a personas, grupos o a la institución.'],
          ['b','Realización de acciones con carácter educativo y de interés institucional o comunal, verificables y proporcionales a la falta cometida.'],
          ['c','Inasistencia al centro educativo hasta por un período comprendido entre veinte y treinta días naturales.'],
        ];
        for (const [inc, desc] of art152) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, descripcion) VALUES ('accion_correctiva', 152, $1, 'gravisima', $2) ON CONFLICT DO NOTHING`,
            [inc, desc]);
        }

        // REBAJO DE PUNTOS DE CONDUCTA (asociado al tipo de falta)
        // Aunque el artículo varía según el centro, en el REAC base los rebajos
        // son fijos según la gravedad. Lo sembramos como entradas únicas para
        // que el select muestre directamente el rebajo aplicable.
        const rebajos = [
          ['a', 'grave',     20, 'Rebajo de hasta veinte (20) puntos de la nota de conducta por falta grave.'],
          ['b', 'muy_grave', 35, 'Rebajo de hasta treinta y cinco (35) puntos de la nota de conducta por falta muy grave.'],
          ['c', 'gravisima', 50, 'Rebajo de hasta cincuenta (50) puntos de la nota de conducta por falta gravísima.'],
        ];
        for (const [inc, grav, pts, desc] of rebajos) {
          await client.query(
            `INSERT INTO reac_catalogo (categoria, articulo, inciso, gravedad, puntos, descripcion) VALUES ('rebajo_puntos', 166, $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [inc, grav, pts, desc]);
        }

        console.log("✅ Catálogo REAC sembrado");
      } else {
        console.log(`✅ Catálogo REAC ya estaba poblado (${existe.rows[0].n} incisos)`);
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
      { cod:'civica_7_9',   desc:'Educación Cívica (7°-9°)',          lvl:[7,9],   pc:60, pt:10, pp:0,  ppr:25, pa:5, np:0, npr:1, op:false,
        nota:'1 proyecto (25%)' },
      { cod:'tecno_7_9',    desc:'Formación Tecnológica (7°-9°)',     lvl:[7,9],   pc:45, pt:10, pp:0,  ppr:40, pa:5, np:0, npr:1, op:false,
        nota:'1 proyecto (40%)' },
      { cod:'idioma_7_9',   desc:'Inglés/Francés (7°-9°)',           lvl:[7,9],   pc:35, pt:10, pp:50, ppr:0,  pa:5, np:2, npr:0, op:false,
        nota:'2 pruebas obligatorias (25% c/u)' },
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

    // Nuevas materias
    await client.query("INSERT INTO materias (nombre) VALUES ('Inglés Conversacional') ON CONFLICT DO NOTHING");
    await client.query("INSERT INTO materias (nombre) VALUES ('Diseño Publicitario') ON CONFLICT DO NOTHING");

    // Admin por defecto
    const adminEx = await client.query("SELECT id FROM usuarios WHERE rol='admin' LIMIT 1");
    if (adminEx.rows.length === 0) {
      const hash = await bcrypt.hash("Admin2024**", 10);
      await client.query(`
        INSERT INTO usuarios (cedula,nombre,primer_apellido,segundo_apellido,password_hash,rol,primer_login)
        VALUES ('0000000000','Administrador','Sistema','LCF',$1,'admin',false)
        ON CONFLICT DO NOTHING
      `, [hash]);
      console.log("✅ Admin creado — cédula: 0000000000 / contraseña: Admin2024**");
    }

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
