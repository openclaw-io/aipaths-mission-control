# Auditoría de playlists de AIPaths — 2026-07-31

## Resumen ejecutivo

La arquitectura actual está organizada principalmente por **herramienta** y por **formato**, no por el recorrido que quiere hacer el viewer. Eso funcionó para acumular contenido, pero hoy no refleja bien la promesa de AIPaths: pasar de IA suelta a sistemas de IA para operar un negocio.

Snapshot público revisado:
- 9 playlists públicas.
- 6 playlists de videos largos y 3 de Shorts.
- 54 videos visibles en la pestaña Videos al capturar el snapshot, más `ChatGPT Work cuándo usar Chat, Work o Codex`, recién publicado y todavía reportando duración `0:00`.
- 167 Shorts visibles.
- 5 videos largos visibles no pertenecen a ninguna playlist larga.
- 26 Shorts están duplicados entre `Shorts N8N` y `Shorts Chatbot Whatsapp`.
- 38 Shorts no están en ninguna de las tres playlists de Shorts.

No se realizó ningún cambio en YouTube.

## Diagnóstico por playlist

### 1. Automatizaciones para Empresas — 3 videos
**Decisión:** mantener y convertir en playlist principal.

Problemas:
- Es la playlist más alineada con la dirección actual, pero sólo tiene 3 videos.
- No tiene descripción.
- El nombre sigue centrado en automatización; la promesa actual es más amplia: sistemas de IA para operar.

Acción:
- Renombrar a **Sistemas de IA para tu Negocio**.
- Usarla como playlist `Empezá acá` en la home.
- Orden sugerido:
  1. `Metí 6 Agentes en una Mac Mini`
  2. `Cómo construí un equipo usando IA`
  3. `Convertí una Tarea en un Sistema de IA`
  4. `No Automatices Tu Negocio Todavía`
  5. `¿Cuánto Cuesta Correr 8 Agentes de IA?`
  6. `Esto NO es un Chatbot: es un Agente de IA real en tu WhatsApp`

### 2. Agentes de IA con OpenClaw — 11 videos
**Decisión:** mantener, renombrar y limpiar.

Problemas:
- Ya contiene Hermes, WhatsApp y Claude Code; el nombre promete sólo OpenClaw.
- `ChatGPT Work cuándo usar Chat, Work o Codex` no pertenece a esta playlist.
- El orden mezcla prueba, tutorial, migración y casos de uso sin recorrido claro.

Acción:
- Renombrar a **Agentes de IA con Hermes y OpenClaw**.
- Sacar `ChatGPT Work cuándo usar Chat, Work o Codex`.
- Orden sugerido:
  1. `Metí 6 Agentes en una Mac Mini`
  2. `Hermes Agent desde 0 en 27 minutos`
  3. `Migré a Hermes y esto es lo que pasó con mis agentes de IA`
  4. `¿Cuánto Cuesta Correr 8 Agentes de IA?`
  5. `OpenClaw desde 0 | Todo lo que Necesitas`
  6. `OpenClaw: Tu Primer Agente Desde Cero`
  7. `Tu Agente de IA por $20 al mes`
  8. `OpenClaw: El sistema que gestiona todo mi contenido`
  9. `Claude Code vs OpenClaw para crear agentes IA`
  10. `Esto NO es un Chatbot: es un Agente de IA real en tu WhatsApp`

### 3. N8N Automatizaciones — 5 videos
**Decisión:** mantener y reordenar.

Es coherente, pero hoy abre con un tutorial de 34 minutos y deja el tutorial para principiantes al final.

Acción:
- Renombrar a **n8n para Automatizar tu Negocio**.
- Orden sugerido:
  1. `n8n Tutorial para Principiantes: Automatiza GRATIS`
  2. `Cómo Crear un Chatbot de WhatsApp con IA GRATIS`
  3. `Chatbot de WhatsApp: agenda turnos automáticamente`
  4. `RAG en n8n: conecta tu agente con tus datos`
  5. `n8n + Gemini: automatiza noticias de IA`

### 4. Claude Vibe Coding — 8 videos
**Decisión:** mantener, renombrar y sumar 1 video.

Problemas:
- `Vibe Coding` es más estrecho que el contenido real.
- Hay videos de productividad, terminal, presupuestos y contexto, no sólo creación de webs.
- Falta `¿El Vibe Coding es el FUTURO de los Developers?`.

Acción:
- Renombrar a **Claude Code para Emprendedores**.
- Orden sugerido:
  1. `Claude Code: 5 Trucos que tardé 6 meses en aprender`
  2. `Cómo crear presupuestos para clientes con IA`
  3. `Creá tu web gratis en 10 minutos`
  4. `Context Engineering: por qué Prompt Engineering ya no alcanza`
  5. `Claude Code Agents vs ChatGPT: Productividad x5`
  6. `Claude Code vs Cursor`
  7. `¿El Vibe Coding es el FUTURO de los Developers?`
  8. `Cómo usar Gemini, Claude y ChatGPT en la terminal`
  9. `Construí una web completa usando Claude Code` — dejar al final por sus 60 minutos.

### 5. Chatbot Whatsapp — 22 videos
**Decisión:** dividir por intención.

Es la biblioteca más fuerte del canal, pero mezcla:
- entrada para principiantes;
- n8n;
- Meta API;
- cursos antiguos de Node.js de 60–100 minutos;
- venta de chatbots;
- LLMs locales e interpretación de imágenes.

Acción:
- Mantener el ID actual y renombrarlo a **WhatsApp con IA para tu Negocio**.
- Dejar primero el recorrido moderno:
  1. `Whatsapp Chatbot Crash-Course | De 0 a 100 en 60 minutos` — 72K views, sigue siendo el ancla.
  2. `WhatsApp API en Meta: Todo lo que necesitás saber 2026`
  3. `Cómo Crear un Chatbot de WhatsApp con IA GRATIS`
  4. `Esto NO es un Chatbot: es un Agente de IA real en tu WhatsApp`
  5. `Chatbot de WhatsApp: agenda turnos automáticamente`
  6. `Crear un Chatbot con la API de Meta usando NodeJS`
  7. `Whatsapp AI Bot en CLOUD 24/7`
  8. `Aprende a interpretar imágenes por WhatsApp con Gemini`
- Crear una playlist secundaria: **Curso Técnico de Chatbots WhatsApp con Node.js** para los módulos largos, Google Sheets, botones, grupos, deploy y entregas a clientes.
- Sacar `Hugging Face - Describe images for free!`; no tiene una promesa WhatsApp clara.

### 6. LLMs — 5 videos
**Decisión:** archivar de la home; no borrar videos.

Problemas:
- Nombre abstracto y sin resultado.
- Contenido viejo y heterogéneo: GPU, GPTs, APIs, Google Sheets y WhatsApp.
- Duplica dos videos de `Chatbot Whatsapp`.

Acción:
- No mostrarla en la home.
- Mover `Como conectar Whatsapp con un LLM Local` a WhatsApp.
- Mover los videos de GPTs/API a una futura playlist técnica sólo si vuelve a haber contenido de ese cluster.
- Dejar el resto como archivo público o convertir la playlist en no listada después de revisar tráfico de playlist.

### 7–9. Playlists de Shorts
- `Shorts Claude Code` — 51 videos.
- `Shorts N8N` — 61 videos.
- `Shorts Chatbot Whatsapp` — 47 videos.

**Decisión:** no priorizar una reconstrucción manual ahora.

Problemas:
- `Shorts Claude Code` incluye Gemini, Mac Mini, agentes, presupuestos, contexto y webs; el nombre ya no describe el contenido.
- N8N y WhatsApp comparten 26 Shorts.
- 38 Shorts públicos no están en ninguna de las tres.

Acción:
- Quitarlas de las primeras filas de la home si hoy están destacadas.
- Renombrar `Shorts Claude Code` a **Shorts de Agentes y Claude Code**.
- Regla futura: si el Short resuelve WhatsApp/Meta/turnos, va a WhatsApp; si enseña workflow/RAG/n8n sin WhatsApp como resultado principal, va a N8N. No duplicar por herramienta secundaria.
- No hace falta meter los 38 huérfanos en una playlist genérica: sólo sumar los que formen una serie o recorrido claro.

## Videos largos sin playlist y destino recomendado

1. `¿Vale la pena aprender a programar en 2026?` → nueva playlist Historia/Autoridad.
2. `Simulamos una Economía de Agentes IA` → Agentes + Historia/Autoridad.
3. `Vendí 20+ Chatbots y Me Arrepentí` → Historia/Autoridad y WhatsApp.
4. `¿El Vibe Coding es el FUTURO de los Developers?` → Claude Code + Historia/Autoridad.
5. `Método para vender chatbots de WhatsApp en 2025` → playlist técnica/legacy de WhatsApp; no usar como entrada principal porque el posicionamiento actual no lidera con vender servicios.

## Arquitectura final recomendada para la home

1. **Empezá acá: Sistemas de IA para tu Negocio**
2. **Agentes de IA con Hermes y OpenClaw**
3. **WhatsApp con IA para tu Negocio**
4. **n8n para Automatizar tu Negocio**
5. **Claude Code para Emprendedores**
6. **Historias y Decisiones Construyendo con IA**

Secundarias, fuera de las primeras filas:
- **Curso Técnico de Chatbots WhatsApp con Node.js**
- Playlists de Shorts
- Archivo `LLMs`

## Orden de ejecución

### Fase 1 — alto impacto, bajo esfuerzo
1. Sacar `ChatGPT Work` de la playlist de OpenClaw.
2. Renombrar y reordenar OpenClaw, n8n y Claude Code.
3. Renombrar `Automatizaciones para Empresas` y completarla como playlist principal.
4. Crear `Historias y Decisiones Construyendo con IA` y ubicar los 5 videos huérfanos.

### Fase 2 — limpieza de la biblioteca fuerte
5. Dividir WhatsApp entre recorrido moderno y curso técnico Node.js.
6. Ocultar `LLMs` de la home y redistribuir sus videos útiles.

### Fase 3 — mantenimiento
7. Limpiar duplicados de Shorts N8N/WhatsApp con una regla de intención primaria.
8. Definir una regla operativa: cada nuevo video largo debe entrar en una playlist principal y tener un siguiente video lógico.
