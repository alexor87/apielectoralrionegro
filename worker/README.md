# Worker proxy · scrutix → Portal Electoral

Cloudflare Worker que actúa como puente entre el portal estático en GitHub Pages y la API de scrutix.co.

**Qué resuelve:**
- 🔒 La API key de scrutix vive como secreto en Cloudflare. **Nunca llega al navegador.**
- 🚪 El portal exige una contraseña compartida que se valida en el Worker antes de proxear nada.
- 🌐 Cumple CORS para que el frontend en `*.github.io` pueda hablar con el Worker sin problemas.

**Costo:** $0 — plan free de Cloudflare Workers (100.000 requests/día, suficiente para uso interno).

---

## Despliegue paso a paso (5–10 min)

### 1. Crear cuenta de Cloudflare

Si aún no la tienes: https://dash.cloudflare.com/sign-up — gratis, no pide tarjeta.

### 2. Instalar Wrangler (CLI de Cloudflare Workers)

```bash
npm install -g wrangler
wrangler login
```

`wrangler login` abre el navegador para vincular tu cuenta de Cloudflare.

### 3. Configurar `ALLOWED_ORIGINS`

Edita `wrangler.toml` y pon ahí la URL exacta de tu sitio en GitHub Pages, sin slash final:

```toml
[vars]
ALLOWED_ORIGINS = "https://alexor87.github.io"
```

Si vas a probar también desde local, sepáralos por coma:

```toml
ALLOWED_ORIGINS = "https://alexor87.github.io,http://localhost:5173"
```

### 4. Cargar los secretos

Desde dentro del directorio `worker/`:

```bash
# 4.1 La API key de scrutix.co — esta queda en Cloudflare, nunca en el código
wrangler secret put SCRUTIX_API_KEY
# Cuando pregunte, pega: sk_electoral_...

# 4.2 La contraseña que el alcalde y su equipo usarán para entrar al portal
wrangler secret put PORTAL_PASSWORD
# Cuando pregunte, pega cualquier contraseña fuerte (≥ 16 caracteres)
```

> Tip para generar una contraseña fuerte: `openssl rand -base64 24`.

### 5. Desplegar

```bash
wrangler deploy
```

Wrangler te imprime la URL del Worker, algo como:

```
https://electoral-proxy-rionegro.tu-cuenta.workers.dev
```

**Copia esa URL.** La vas a necesitar para el frontend.

### 6. Conectar el frontend con el Worker

Edita el archivo `../js/config.js` (en la raíz del proyecto) y pega la URL del Worker:

```js
window.PORTAL_CONFIG = {
  PROXY_URL: 'https://electoral-proxy-rionegro.tu-cuenta.workers.dev',
};
```

Haz commit y push. GitHub Pages se actualiza solo en 1–2 min.

---

## Operación diaria

| Acción | Comando |
|---|---|
| Ver logs en vivo | `wrangler tail` |
| Cambiar la contraseña | `wrangler secret put PORTAL_PASSWORD` |
| Rotar la API key de scrutix | `wrangler secret put SCRUTIX_API_KEY` |
| Re-desplegar tras editar `index.js` | `wrangler deploy` |
| Borrar el Worker entero | `wrangler delete` |

## Endpoints permitidos

El Worker tiene un allowlist estricto. Solo proxea estos paths:

- `/elections`
- `/corporations`
- `/benchmark`
- `/map`
- `/station`
- `/context-ai`

Cualquier otro path responde `404 — Endpoint no permitido`.

## Modelo de seguridad

| Riesgo | Mitigación |
|---|---|
| Alguien encuentra la URL del Worker | Sin la contraseña, todas las llamadas devuelven `401`. |
| Alguien obtiene la contraseña | Cambiar con `wrangler secret put PORTAL_PASSWORD`. La rotación es instantánea. |
| Brute-force a la contraseña | Cloudflare aplica rate limiting básico por IP automáticamente. Para uso interno con contraseña ≥ 16 chars, riesgo bajo. |
| Filtrado de la API key | Imposible: vive solo dentro del Worker, no se envía al cliente. |

Si necesitas más rigor (login real con Google/email OTP), usa Cloudflare Access con un dominio propio — gratis hasta 50 usuarios. No requiere cambios en el código.

## Desarrollo local

```bash
# desde worker/
wrangler dev
# Sirve en http://localhost:8787
```

Para probar el frontend contra el Worker local, edita `../js/config.js`:

```js
window.PORTAL_CONFIG = { PROXY_URL: 'http://localhost:8787' };
```
