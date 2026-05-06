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
      await client.query(`ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK(rol IN ('admin','auxiliar','orientador','profesor_guia','profesor','cocinera','secretaria','administrativo'))`);
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
