# Portal de Consulta Electoral · Rionegro

Aplicación web para explorar los resultados electorales históricos de **Rionegro, Antioquia** (Alcaldía y Concejo Municipal). Datos oficiales de la Registraduría Nacional, servidos por la API de [scrutix.co](https://app.scrutix.co).

> **PRD v1.0** — interfaz interna del alcalde de Rionegro y su equipo.

---

## Arquitectura

```
┌─────────────────────────┐      ┌─────────────────────────┐      ┌────────────────┐
│   Frontend estático     │      │  Cloudflare Worker      │      │  scrutix.co    │
│   (GitHub Pages)        │  →   │  /worker                │  →   │  API electoral │
│                         │      │                         │      │                │
│  X-Portal-Password ─────┼──────▶  valida pwd + añade     │      │                │
│                         │      │  Authorization: Bearer  │      │                │
└─────────────────────────┘      └─────────────────────────┘      └────────────────┘
```

**Por qué el Worker:** la API key de scrutix nunca llega al navegador. Vive como secreto en Cloudflare. El portal solo conoce una contraseña compartida que se valida en el Worker antes de proxear cualquier llamada.

---

## ¿Qué hace?

- 📊 **Resumen general** — métricas clave, ganador destacado, top 5 candidatos y top 5 partidos.
- 👥 **Candidatos** — ranking completo del cargo, filtrable por partido.
- 🏛️ **Partidos** — distribución del voto por colectividad política.
- 🗳️ **Puestos de votación** — grilla de puestos con detalle por candidato y mesa.
- 🤖 **Análisis con IA** — análisis estratégico generado por Claude o GPT a partir del contexto pre-calculado de la API.

## Estructura del proyecto

```
.
├── index.html          # Shell + setup + 4 vistas + modales
├── .nojekyll           # Evita procesamiento Jekyll en GitHub Pages
├── css/
│   └── styles.css      # Design system: tokens, componentes
├── js/
│   ├── config.js       # ⚠️  PROXY_URL del Worker — editar tras desplegar
│   ├── api.js          # Cliente HTTP que habla con el Worker
│   ├── ai.js           # Integración con Anthropic / OpenAI
│   ├── charts.js       # Helpers de paleta y formato
│   └── app.js          # Estado, vistas, eventos
└── worker/             # Cloudflare Worker proxy (ver worker/README.md)
    ├── index.js
    ├── wrangler.toml
    └── README.md
```

---

## Despliegue (primera vez · ~15 min)

### Paso 1 — Desplegar el Worker

Sigue las instrucciones en [`worker/README.md`](worker/README.md). Al terminar tendrás:

- Una URL pública del Worker, tipo `https://electoral-proxy-rionegro.tu-cuenta.workers.dev`.
- Dos secretos cargados en Cloudflare: `SCRUTIX_API_KEY` y `PORTAL_PASSWORD`.

### Paso 2 — Conectar el frontend

Edita `js/config.js` y pega la URL del Worker:

```js
window.PORTAL_CONFIG = {
  PROXY_URL: 'https://electoral-proxy-rionegro.tu-cuenta.workers.dev',
};
```

### Paso 3 — Activar GitHub Pages

1. Haz `git push` con los cambios de `config.js`.
2. En GitHub: **Settings → Pages**.
3. Source: **Deploy from a branch** · Branch: **main** · Folder: **/ (root)** · Save.
4. Espera 1–2 minutos. La URL queda en `https://alexor87.github.io/apielectoralrionegro/`.

> ⚠️ GitHub Pages gratis solo funciona con **repos públicos**. Si el repo es privado, necesitas plan Pro ($4/mes) o usar Vercel/Netlify (gratis con repo privado).

### Paso 4 — Compartir con el equipo

Pasa al alcalde y su equipo:
- 📍 La URL de GitHub Pages.
- 🔐 La contraseña compartida que cargaste como `PORTAL_PASSWORD`.

Listo. Cada usuario la ingresa una vez en su navegador y queda guardada.

---

## Uso

1. El usuario abre la URL del portal.
2. La primera vez: ingresa la contraseña compartida.
3. Selecciona elección y cargo en la barra superior.
4. Navega entre las 4 pestañas: Resumen, Candidatos, Partidos, Puestos.
5. Hace clic en cualquier puesto para ver detalle por candidato y mesa.
6. (Opcional) Botón **Analizar con IA** — pide configurar una key de Anthropic o OpenAI.

### Cerrar sesión

Botón ⚙️ en la barra superior → **Cerrar sesión**. Borra la contraseña del navegador.

---

## Mantenimiento

| Tarea | Cómo |
|---|---|
| Cambiar la contraseña del portal | `cd worker && wrangler secret put PORTAL_PASSWORD` |
| Rotar la API key de scrutix | `cd worker && wrangler secret put SCRUTIX_API_KEY` |
| Ver logs del Worker | `cd worker && wrangler tail` |
| Actualizar el frontend | `git push` (Pages se actualiza solo) |
| Cambiar la URL permitida (CORS) | Editar `worker/wrangler.toml` → `wrangler deploy` |

---

## Costos

| Componente | Plan | Costo |
|---|---|---|
| GitHub Pages | Free (repo público) | $0 |
| Cloudflare Workers | Free | $0 (hasta 100k req/día) |
| Anthropic / OpenAI | Pay per use | ~$0.01–0.03 por análisis IA |
| **Total operativo** | | **~$0/mes** |

---

## Servir localmente

```bash
# Frontend
python3 -m http.server 5173

# Worker (en otra terminal)
cd worker && wrangler dev
# Worker en http://localhost:8787
```

Edita `js/config.js` apuntando a `http://localhost:8787` y agrega `http://localhost:5173` a `ALLOWED_ORIGINS` en `worker/wrangler.toml`.

---

## Roadmap

Ver el PRD (sección 10). v2 incluye multi-municipio, mapa geográfico, exportación PDF/CSV y vista de tendencias históricas.

---

*v1.0 · Mayo 2025 · Alcaldía de Rionegro, Antioquia*
