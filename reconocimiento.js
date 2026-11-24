const express = require('express')
const multer = require('multer')

/**
 * Servicio de reconocimiento facial.
 * Recibe una foto, la envía al backend de biometría y devuelve quién es la persona.
 *
 * Variables de entorno:
 *   BIOMETRY_URL      URL del backend de biometría (ej: http://localhost:8000)
 *   BIOMETRY_API_KEY  Clave que debe coincidir con RECOGNIZE_API_KEYS del backend de biometría
 */
const BIOMETRY_URL = (process.env.BIOMETRY_URL || 'http://localhost:8000').replace(/\/+$/, '')
const BIOMETRY_API_KEY = process.env.BIOMETRY_API_KEY || ''
const TIMEOUT_MS = 30000

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
})

async function reconocerRostro(buffer, mimetype, filename) {
  const form = new FormData()
  form.append('photo', new Blob([buffer], { type: mimetype }), filename || 'foto.jpg')

  const resp = await fetch(`${BIOMETRY_URL}/api/v1/recognize`, {
    method: 'POST',
    headers: { 'X-API-Key': BIOMETRY_API_KEY },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await resp.json().catch(() => ({}))
  return { status: resp.status, data }
}

function crearRouter(authMiddleware) {
  const router = express.Router()

  /**
   * POST /api/reconocimiento
   * Content-Type: multipart/form-data, campo "foto" con la imagen.
   */
  router.post('/api/reconocimiento', authMiddleware, upload.single('foto'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Falta la foto (campo "foto")' })
    }

    try {
      const { status, data } = await reconocerRostro(req.file.buffer, req.file.mimetype, req.file.originalname)

      if (status !== 200) {
        console.error('Biometría respondió', status, data)
        return res.status(status === 401 ? 502 : status).json({
          error: data.detail || 'Error en el servicio de biometría',
        })
      }

      if (!data.recognized) {
        return res.json({
          reconocido: false,
          motivo: data.reason,
          mensaje: data.message,
          mejor_similitud: data.best_similarity_percentage,
          umbral: data.threshold,
        })
      }

      const p = data.person || {}
      res.json({
        reconocido: true,
        similitud: data.similarity_percentage,
        persona: {
          nombre_completo: p.name,
          nombres: p.nombres,
          apellidos: p.apellidos,
          dni: p.dni,
          empleado_id: p.empleado_id,
          foto_url: p.photo_url,
        },
      })
    } catch (err) {
      console.error('Error al llamar a biometría:', err)
      const timeout = err.name === 'TimeoutError'
      res.status(timeout ? 504 : 502).json({
        error: timeout ? 'El servicio de biometría tardó demasiado' : 'No se pudo conectar con el servicio de biometría',
      })
    }
  })

  return router
}

module.exports = { crearRouter }
