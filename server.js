require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')
const app = express()

app.use(cors())
app.use(express.json())

// ─── Conexión a PostgreSQL ────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'bodycam_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'tu_password',
})

// ─── Middleware de autenticación por token ────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1] // "Bearer <token>"

  if (!token || token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: 'Token inválido o ausente' })
  }
  next()
}

// ─────────────────────────────────────────────────────────────────────────────
//  BODYCAMS - Registro y consulta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bodycams/registrar
 * Registra una nueva bodycam en el sistema.
 * Body: { codigo, nombre }
 */
app.post('/api/bodycams/registrar', authMiddleware, async (req, res) => {
  const { codigo, nombre } = req.body

  if (!codigo || !nombre) {
    return res.status(400).json({ error: 'codigo y nombre son obligatorios' })
  }

  try {
    const result = await pool.query(
      `INSERT INTO bodycams (codigo, nombre)
       VALUES ($1, $2)
       ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre
       RETURNING *`,
      [codigo, nombre]
    )
    res.status(201).json({
      mensaje: 'Bodycam registrada correctamente',
      bodycam: result.rows[0]
    })
  } catch (err) {
    console.error('Error al registrar bodycam:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

/**
 * GET /api/bodycams
 * Lista todas las bodycams con su última ubicación conocida.
 */
app.get('/api/bodycams', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        b.id,
        b.codigo,
        b.nombre,
        b.activa,
        u.latitud,
        u.longitud,
        u.precision_m,
        u.registrado_en AS ultima_ubicacion
      FROM bodycams b
      LEFT JOIN LATERAL (
        SELECT latitud, longitud, precision_m, registrado_en
        FROM ubicaciones
        WHERE bodycam_id = b.id
        ORDER BY registrado_en DESC
        LIMIT 1
      ) u ON true
      ORDER BY b.nombre ASC
    `)
    res.json(result.rows)
  } catch (err) {
    console.error('Error al listar bodycams:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
//  UBICACIONES - Recepción y consulta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/ubicacion
 * Recibe la ubicación enviada por la bodycam cada 15-20 segundos.
 * Body: { codigo, latitud, longitud, precision_m }
 */
app.post('/api/ubicacion', authMiddleware, async (req, res) => {
  const { codigo, latitud, longitud, precision_m } = req.body

  if (!codigo || latitud == null || longitud == null) {
    return res.status(400).json({ error: 'codigo, latitud y longitud son obligatorios' })
  }

  // Validar rangos básicos
  if (latitud < -90 || latitud > 90 || longitud < -180 || longitud > 180) {
    return res.status(400).json({ error: 'Coordenadas fuera de rango' })
  }

  try {
    // Buscar la bodycam por código
    const bodycamResult = await pool.query(
      'SELECT id FROM bodycams WHERE codigo = $1 AND activa = true',
      [codigo]
    )

    if (bodycamResult.rows.length === 0) {
      return res.status(404).json({ error: `Bodycam con código '${codigo}' no encontrada o inactiva` })
    }

    const bodycamId = bodycamResult.rows[0].id

    // Insertar la nueva ubicación
    await pool.query(
      `INSERT INTO ubicaciones (bodycam_id, latitud, longitud, precision_m)
       VALUES ($1, $2, $3, $4)`,
      [bodycamId, latitud, longitud, precision_m || null]
    )

    res.status(201).json({ mensaje: 'Ubicación registrada' })
  } catch (err) {
    console.error('Error al registrar ubicación:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

/**
 * GET /api/ubicaciones/:codigo
 * Devuelve el historial de ubicaciones de una bodycam.
 * Query params: ?limite=100&desde=2024-01-01T00:00:00Z
 */
app.get('/api/ubicaciones/:codigo', authMiddleware, async (req, res) => {
  const { codigo } = req.params
  const limite = Math.min(parseInt(req.query.limite) || 10000, 10000) // aumentamos limite para recorridos largos
  const desde  = req.query.desde || null
  const hasta  = req.query.hasta || null

  try {
    const bodycamResult = await pool.query(
      'SELECT id, nombre FROM bodycams WHERE codigo = $1',
      [codigo]
    )

    if (bodycamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bodycam no encontrada' })
    }

    const { id: bodycamId, nombre } = bodycamResult.rows[0]

    let query = `
      SELECT latitud, longitud, precision_m, registrado_en
      FROM ubicaciones
      WHERE bodycam_id = $1
    `
    const params = [bodycamId]

    if (desde) {
      params.push(desde)
      query += ` AND registrado_en >= $${params.length}`
    }
    
    if (hasta) {
      params.push(hasta)
      query += ` AND registrado_en <= $${params.length}`
    }

    query += ` ORDER BY registrado_en DESC LIMIT $${params.length + 1}`
    params.push(limite)

    const result = await pool.query(query, params)

    res.json({
      bodycam: { codigo, nombre },
      total: result.rows.length,
      ubicaciones: result.rows
    })
  } catch (err) {
    console.error('Error al consultar historial:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

/**
 * GET /api/ubicaciones/:codigo/ultima
 * Devuelve solo la última posición conocida de una bodycam.
 */
app.get('/api/ubicaciones/:codigo/ultima', authMiddleware, async (req, res) => {
  const { codigo } = req.params

  try {
    const result = await pool.query(`
      SELECT b.codigo, b.nombre, u.latitud, u.longitud, u.precision_m, u.registrado_en
      FROM bodycams b
      JOIN ubicaciones u ON u.bodycam_id = b.id
      WHERE b.codigo = $1
      ORDER BY u.registrado_en DESC
      LIMIT 1
    `, [codigo])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sin ubicaciones registradas para esta bodycam' })
    }

    res.json(result.rows[0])
  } catch (err) {
    console.error('Error al consultar última ubicación:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Limpieza Automática de Datos ─────────────────────────────────────────────
const limpiarDatosAntiguos = async () => {
  try {
    const result = await pool.query(`
      DELETE FROM ubicaciones 
      WHERE registrado_en < NOW() - INTERVAL '2 days'
    `)
    if (result.rowCount > 0) {
      console.log(`🧹 Limpieza automática: Se eliminaron ${result.rowCount} ubicaciones antiguas (más de 2 días).`)
    }
  } catch (err) {
    console.error('Error al limpiar ubicaciones antiguas:', err)
  }
}

// Ejecutar la limpieza cada 6 horas (21600000 ms)
setInterval(limpiarDatosAntiguos, 6 * 60 * 60 * 1000)

// ─── Arranque ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor bodycam-tracker corriendo en puerto ${PORT}`)
  limpiarDatosAntiguos() // Ejecutar una limpieza inicial al arrancar
})

module.exports = app