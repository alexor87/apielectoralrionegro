# Portal de Consulta Electoral · Rionegro

Aplicación web para explorar los resultados electorales históricos de **Rionegro, Antioquia** (Alcaldía y Concejo Municipal), construida sobre la API electoral de [scrutix.co](https://app.scrutix.co).

> **PRD v1.0** — interfaz interna del alcalde de Rionegro y su equipo. Datos provenientes de la Registraduría Nacional del Estado Civil.

---

## ¿Qué hace?

- 📊 **Resumen general** — métricas clave, ganador destacado, top 5 candidatos y top 5 partidos.
- 👥 **Candidatos** — ranking completo del cargo, filtrable por partido.
- 🏛️ **Partidos** — distribución del voto por colectividad política.
- 🗳️ **Puestos de votación** — grilla de puestos con detalle por candidato y mesa.
- 🤖 **Análisis con IA** — análisis estratégico generado por Claude o GPT a partir del contexto pre-calculado de la API.

---

## Stack

- HTML/CSS/JS vanilla — cero build step.
- Chart.js (cargado como dependencia opcional, listo para gráficas avanzadas en v2).
- Fuentes IBM Plex Sans + Plex Mono.
- Despliegue como sitio estático — sirve cualquier hosting (Vercel, Netlify, GitHub Pages, S3).

## Estructura del proyecto

```
.
├── index.html          # Shell + setup + 4 vistas + modales
├── css/
│   └── styles.css      # Design system: tokens, componentes
├── js/
│   ├── api.js          # Cliente HTTP de la API electoral
│   ├── ai.js           # Integración con Anthropic / OpenAI
│   ├── charts.js       # Helpers de paleta y formato numérico
│   └── app.js          # Estado, vistas, eventos
└── README.md
```

## Configuración

1. Solicita tu API key en [app.scrutix.co](https://app.scrutix.co). Formato esperado: `sk_electoral_...`.
2. Abre `index.html` en un navegador (Chrome/Firefox/Safari/Edge modernos).
3. Ingresa tu API key en la pantalla de bienvenida. La key se guarda **solo en `sessionStorage`** — se borra al cerrar la pestaña.

### Análisis con IA (opcional)

Al hacer clic en *Analizar con IA* se solicita una key de un proveedor LLM:

- **Anthropic (Claude)** — recomendado. Modelo: `claude-sonnet-4-5`.
- **OpenAI (GPT)** — modelo: `gpt-4o-mini`.

Las keys de IA tampoco persisten — se limpian al cerrar la pestaña.

## Servir localmente

Cualquier servidor estático funciona:

```bash
# Python 3
python3 -m http.server 5173

# Node
npx serve .
```

Luego abre `http://localhost:5173`.

## Despliegue

El portal es un sitio estático. Despliegue recomendado:

- **Vercel / Netlify** — `drag-and-drop` del directorio raíz. Sin build.
- **GitHub Pages** — habilita Pages en la rama `main`, raíz `/`.
- **iframe embebible** — incluye `index.html` en cualquier intranet.

## Endpoints utilizados

| Método | Endpoint | Uso |
|---|---|---|
| `GET` | `/elections` | Lista de elecciones disponibles |
| `GET` | `/corporations` | Cargos disponibles por elección + municipio |
| `GET` | `/benchmark` | Top candidatos y partidos del cargo |
| `GET` | `/map` | Resultados por puesto de votación |
| `GET` | `/station` | Detalle completo de un puesto |
| `GET` | `/context-ai` | Contexto compacto para LLMs |

Base URL: `https://app.scrutix.co/api/electoral/v1`
Municipio (Rionegro): `municipality_code: 214`

## Roadmap

Ver el PRD completo (sección 10). v2 incluye multi-municipio, mapa geográfico, exportación PDF/CSV y vista de tendencias históricas.

---

*v1.0 · Mayo 2025 · Alcaldía de Rionegro, Antioquia*
