/* ============================================================
   AI integration · Anthropic Claude or OpenAI GPT
   The portal sends pre-computed context from /context-ai to
   the chosen provider for strategic analysis.
   ============================================================ */

const AIProvider = (() => {
  const KEY_STORAGE_PREFIX = 'electoral_ai_key_';
  const PROVIDER_STORAGE = 'electoral_ai_provider';

  const SYSTEM_PROMPT = `Eres un analista político senior asesorando al alcalde de Rionegro, Antioquia.

Tu tarea es analizar resultados electorales históricos de la Registraduría Nacional del Estado Civil de Colombia y entregar análisis estratégico accionable.

Reglas:
- Habla siempre en español neutro de Colombia.
- Usa tono ejecutivo: directo, conciso, sin jerga académica.
- Cuando hagas afirmaciones cuantitativas, cita los números exactos del contexto.
- Estructura tus respuestas con encabezados breves y bullets cortos.
- Identifica oportunidades estratégicas territoriales: zonas de fortaleza, debilidad y crecimiento.
- No inventes datos que no estén en el contexto. Si falta información, dilo explícitamente.
- Cierra siempre con un bloque "Implicaciones estratégicas" con 2-4 recomendaciones priorizadas.`;

  function getProvider() {
    return sessionStorage.getItem(PROVIDER_STORAGE) || 'anthropic';
  }

  function setProvider(provider) {
    sessionStorage.setItem(PROVIDER_STORAGE, provider);
  }

  function getKey(provider) {
    return sessionStorage.getItem(KEY_STORAGE_PREFIX + provider) || '';
  }

  function setKey(provider, key) {
    sessionStorage.setItem(KEY_STORAGE_PREFIX + provider, key);
  }

  function clearKeys() {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(KEY_STORAGE_PREFIX)) sessionStorage.removeItem(k);
    }
    sessionStorage.removeItem(PROVIDER_STORAGE);
  }

  function hasKey() {
    return !!getKey(getProvider());
  }

  /** Build the initial analysis prompt embedding the API context. */
  function buildInitialPrompt(scope, context) {
    const header = scope.kind === 'station'
      ? `Genera un análisis estratégico del puesto de votación "${scope.stationName}" para la elección ${scope.electionLabel}, cargo ${scope.corporationLabel}.

El análisis debe incluir:
1. Resultados destacados del puesto (ganador, principales fuerzas).
2. Comportamiento del puesto frente al promedio municipal de Rionegro.
3. Concentración del voto (cuán polarizado está el puesto).
4. Implicaciones estratégicas para campaña territorial en esa zona.`
      : `Genera un análisis estratégico del panorama electoral del municipio de Rionegro para la elección ${scope.electionLabel}, cargo ${scope.corporationLabel}.

El análisis debe incluir:
1. Panorama general de fuerzas políticas (top candidatos y partidos).
2. Distribución territorial del voto y zonas dominantes.
3. Concentración o fragmentación del voto.
4. Identificación de oportunidades estratégicas (zonas de crecimiento, abstencionismo, voto fluctuante).
5. Implicaciones estratégicas para próximas elecciones.`;

    const ctxBlock = typeof context === 'string'
      ? context
      : JSON.stringify(context, null, 2);

    return `${header}

CONTEXTO ELECTORAL (datos oficiales de la Registraduría):

\`\`\`json
${ctxBlock}
\`\`\``;
  }

  /** Call Anthropic Messages API. */
  async function callAnthropic(apiKey, messages) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!resp.ok) {
      let msg = `Error ${resp.status} del proveedor de IA`;
      try {
        const body = await resp.json();
        msg = body?.error?.message || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    const content = (data?.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    return content || '(respuesta vacía)';
  }

  /** Call OpenAI Chat Completions. */
  async function callOpenAI(apiKey, messages) {
    const fullMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ];
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: fullMessages,
        max_tokens: 2048,
        temperature: 0.4,
      }),
    });
    if (!resp.ok) {
      let msg = `Error ${resp.status} del proveedor de IA`;
      try {
        const body = await resp.json();
        msg = body?.error?.message || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || '(respuesta vacía)';
  }

  /** Send a list of messages to the configured provider. */
  async function complete(messages) {
    const provider = getProvider();
    const apiKey = getKey(provider);
    if (!apiKey) throw new Error('No hay API key de IA configurada.');

    if (provider === 'anthropic') return callAnthropic(apiKey, messages);
    if (provider === 'openai')    return callOpenAI(apiKey, messages);
    throw new Error(`Proveedor desconocido: ${provider}`);
  }

  return {
    getProvider, setProvider,
    getKey, setKey, clearKeys, hasKey,
    buildInitialPrompt,
    complete,
  };
})();
